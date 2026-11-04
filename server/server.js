const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 3000);
const SESSION_SECONDS = 60 * 60 * 24 * 30;
const BODY_LIMIT = 16 * 1024;
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean));
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const attempts = new Map();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(res, status, data, extraHeaders = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders });
  res.end(JSON.stringify(data));
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) throw new HttpError(403, "Источник запроса не разрешён.");
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
}

async function body(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new HttpError(413, "Слишком большой запрос.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "Некорректный формат запроса.");
  }
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Укажите корректную электронную почту.");
  return email;
}

function normalizePhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) digits = "7" + digits;
  if (digits.length === 11 && digits.startsWith("8")) digits = "7" + digits.slice(1);
  if (digits.length !== 11 || !digits.startsWith("7")) throw new HttpError(400, "Укажите телефон полностью: +7 (999) 999-99-99.");
  return "+" + digits;
}

function validateName(value) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 60) throw new HttpError(400, "Имя мастера должно содержать от 2 до 60 символов.");
  return name;
}

function validatePassword(value) {
  const password = String(value || "");
  if (password.length < 8 || password.length > 128 || Buffer.byteLength(password) > 512) throw new HttpError(400, "Пароль должен содержать от 8 до 128 символов.");
  return password;
}

function scrypt(password, salt, N, r, p) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N, r, p }, (error, key) => error ? reject(error) : resolve(key));
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const N = 16384, r = 8, p = 1;
  const hash = await scrypt(password, salt, N, r, p);
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

async function verifyPassword(password, stored) {
  const [algorithm, N, r, p, salt, expected] = String(stored).split("$");
  if (algorithm !== "scrypt" || !salt || !expected) return false;
  const actual = await scrypt(password, Buffer.from(salt, "base64url"), Number(N), Number(r), Number(p));
  const expectedBuffer = Buffer.from(expected, "base64url");
  return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
}

const tokenHash = token => crypto.createHash("sha256").update(token).digest("hex");

function parseCookies(req) {
  const result = {};
  for (const item of String(req.headers.cookie || "").split(";")) {
    const separator = item.indexOf("=");
    if (separator > 0) result[item.slice(0, separator).trim()] = item.slice(separator + 1).trim();
  }
  return result;
}

function sessionCookie(token) {
  return `__Host-mf_session=${token}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${SESSION_SECONDS}`;
}

function clearCookie() {
  return "__Host-mf_session=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0";
}

async function createSession(masterId) {
  const token = crypto.randomBytes(32).toString("base64url");
  await pool.query("INSERT INTO sessions (token_hash, master_id, expires_at) VALUES ($1, $2, now() + interval '30 days')", [tokenHash(token), masterId]);
  return token;
}

async function currentMaster(req) {
  const token = parseCookies(req)["__Host-mf_session"];
  if (!token) return null;
  const result = await pool.query(
    "SELECT m.id, m.name, m.email, m.phone FROM sessions s JOIN masters m ON m.id = s.master_id WHERE s.token_hash = $1 AND s.expires_at > now()",
    [tokenHash(token)]
  );
  return result.rows[0] || null;
}

function rateLimit(req, route) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = forwarded || req.socket.remoteAddress || "unknown";
  const key = `${route}:${ip}`;
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  let entry = attempts.get(key);
  if (!entry || now - entry.started > windowMs) entry = { started: now, count: 0 };
  entry.count++;
  attempts.set(key, entry);
  if (attempts.size > 10000) {
    for (const [key, value] of attempts) if (now - value.started > windowMs) attempts.delete(key);
  }
  if (entry.count > 12) throw new HttpError(429, "Слишком много попыток. Повторите через 15 минут.");
}

async function register(req, res) {
  const data = await body(req);
  const name = validateName(data.name);
  const email = normalizeEmail(data.email);
  const phone = normalizePhone(data.phone);
  const password = validatePassword(data.password);
  if (data.consent !== true) throw new HttpError(400, "Для регистрации необходимо согласие на обработку данных.");
  const passwordHash = await hashPassword(password);
  try {
    const result = await pool.query(
      "INSERT INTO masters (name, email, phone, password_hash, consent_at, consent_version) VALUES ($1, $2, $3, $4, now(), '2026-11-04') RETURNING id, name, email, phone",
      [name, email, phone, passwordHash]
    );
    const master = result.rows[0];
    const token = await createSession(master.id);
    json(res, 201, { master }, { "Set-Cookie": sessionCookie(token) });
  } catch (error) {
    if (error.code === "23505") throw new HttpError(409, "Аккаунт с такой почтой уже существует.");
    throw error;
  }
}

async function login(req, res) {
  const data = await body(req);
  const email = normalizeEmail(data.email);
  const password = validatePassword(data.password);
  const result = await pool.query("SELECT id, name, email, phone, password_hash FROM masters WHERE lower(email) = lower($1)", [email]);
  const master = result.rows[0];
  if (!master || !(await verifyPassword(password, master.password_hash))) throw new HttpError(401, "Неверная почта или пароль.");
  const token = await createSession(master.id);
  delete master.password_hash;
  json(res, 200, { master }, { "Set-Cookie": sessionCookie(token) });
}

async function logout(req, res) {
  const token = parseCookies(req)["__Host-mf_session"];
  if (token) await pool.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash(token)]);
  json(res, 200, { ok: true }, { "Set-Cookie": clearCookie() });
}

function requireTelegram() {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_BOT_USERNAME || !process.env.OTP_SECRET) {
    throw new HttpError(503, "Telegram-бот ещё не подключён.");
  }
}

async function telegramApi(method, payload, timeoutMs = 30000) {
  const content = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: "149.154.167.220",
      servername: "api.telegram.org",
      path: `/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`,
      method: "POST",
      headers: { "Host": "api.telegram.org", "Content-Type": "application/json", "Content-Length": Buffer.byteLength(content) }
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (response.statusCode !== 200 || !result.ok) return reject(new Error(`Telegram API: ${result.description || response.statusCode}`));
          resolve(result.result);
        } catch {
          reject(new Error("Telegram API: invalid response"));
        }
      });
    });
    request.on("error", reject);
    request.setTimeout(timeoutMs, () => request.destroy(new Error("Telegram API timeout")));
    request.end(content);
  });
}

function otpHash(attemptId, code) {
  return crypto.createHmac("sha256", process.env.OTP_SECRET || "").update(`${attemptId}:${code}`).digest("hex");
}

async function sendPhoneCode(attempt, purpose = "login") {
  const code = String(crypto.randomInt(0, 10000)).padStart(4, "0");
  const table = purpose === "register" ? "phone_registration_attempts" : "phone_login_attempts";
  await pool.query(`UPDATE ${table} SET code_hash = $1, verification_attempts = 0 WHERE id = $2`, [otpHash(attempt.id, code), attempt.id]);
  await telegramApi("sendMessage", {
    chat_id: attempt.telegram_chat_id,
    text: `Ваш код для ${purpose === "register" ? "регистрации" : "входа"} в Мастерфолио: ${code}\n\nОн действует 10 минут. Никому не сообщайте его.`,
    reply_markup: { remove_keyboard: true }
  });
}

async function phoneStart(req, res) {
  requireTelegram();
  const data = await body(req);
  const phone = normalizePhone(data.phone);
  const masterResult = await pool.query("SELECT id, phone FROM masters WHERE phone = $1", [phone]);
  const master = masterResult.rows[0];
  if (!master) throw new HttpError(404, "Аккаунт с таким номером не найден.");
  const linkResult = await pool.query("SELECT chat_id FROM telegram_links WHERE master_id = $1", [master.id]);
  const chatId = linkResult.rows[0]?.chat_id || null;
  const result = await pool.query(
    "INSERT INTO phone_login_attempts (master_id, phone, telegram_chat_id, expires_at) VALUES ($1, $2, $3, now() + interval '10 minutes') RETURNING id",
    [master.id, phone, chatId]
  );
  const attempt = { id: result.rows[0].id, telegram_chat_id: chatId };
  if (chatId) {
    await sendPhoneCode(attempt);
    return json(res, 200, { attemptId: attempt.id, delivery: "telegram" });
  }
  json(res, 200, {
    attemptId: attempt.id,
    delivery: "bot",
    botUrl: `https://t.me/${process.env.TELEGRAM_BOT_USERNAME}?start=${attempt.id}`
  });
}

async function phoneVerify(req, res) {
  requireTelegram();
  const data = await body(req);
  const attemptId = String(data.attemptId || "");
  const code = String(data.code || "").replace(/\s/g, "");
  if (!/^[0-9a-f-]{36}$/i.test(attemptId) || !/^\d{4}$/.test(code)) throw new HttpError(400, "Введите четырёхзначный код из Telegram.");
  const result = await pool.query(
    "SELECT a.id, a.telegram_chat_id, a.code_hash, a.verification_attempts, m.id AS master_id, m.name, m.email, m.phone FROM phone_login_attempts a JOIN masters m ON m.id = a.master_id WHERE a.id = $1 AND a.used_at IS NULL AND a.expires_at > now()",
    [attemptId]
  );
  const attempt = result.rows[0];
  if (!attempt || !attempt.code_hash) throw new HttpError(400, "Срок кода истёк. Запросите новый.");
  if (attempt.verification_attempts >= 5) throw new HttpError(429, "Слишком много попыток. Запросите новый код.");
  const actual = Buffer.from(otpHash(attemptId, code));
  const expected = Buffer.from(attempt.code_hash);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    await pool.query("UPDATE phone_login_attempts SET verification_attempts = verification_attempts + 1 WHERE id = $1", [attemptId]);
    throw new HttpError(401, "Неверный код.");
  }
  await pool.query("UPDATE phone_login_attempts SET used_at = now() WHERE id = $1", [attemptId]);
  if (attempt.telegram_chat_id) {
    await pool.query(
      "INSERT INTO telegram_links (master_id, chat_id) VALUES ($1, $2) ON CONFLICT (master_id) DO UPDATE SET chat_id = EXCLUDED.chat_id, updated_at = now()",
      [attempt.master_id, attempt.telegram_chat_id]
    );
  }
  const token = await createSession(attempt.master_id);
  json(res, 200, { master: { id: attempt.master_id, name: attempt.name, email: attempt.email, phone: attempt.phone } }, { "Set-Cookie": sessionCookie(token) });
}

async function registrationPhoneStart(req, res) {
  requireTelegram();
  const data = await body(req);
  const phone = normalizePhone(data.phone);
  const existing = await pool.query("SELECT 1 FROM masters WHERE phone = $1", [phone]);
  if (existing.rows[0]) throw new HttpError(409, "Аккаунт с таким номером уже существует. Попробуйте войти.");
  const result = await pool.query(
    "INSERT INTO phone_registration_attempts (phone, expires_at) VALUES ($1, now() + interval '10 minutes') RETURNING id",
    [phone]
  );
  json(res, 200, {
    attemptId: result.rows[0].id,
    botUrl: `https://t.me/${process.env.TELEGRAM_BOT_USERNAME}?start=${result.rows[0].id}`
  });
}

async function registrationPhoneVerify(req, res) {
  requireTelegram();
  const data = await body(req);
  const attemptId = String(data.attemptId || "");
  const code = String(data.code || "").replace(/\s/g, "");
  if (!/^[0-9a-f-]{36}$/i.test(attemptId) || !/^\d{4}$/.test(code)) throw new HttpError(400, "Введите четырёхзначный код из Telegram.");
  const result = await pool.query(
    "SELECT id, code_hash, verification_attempts FROM phone_registration_attempts WHERE id = $1 AND used_at IS NULL AND verified_at IS NULL AND expires_at > now()",
    [attemptId]
  );
  const attempt = result.rows[0];
  if (!attempt || !attempt.code_hash) throw new HttpError(400, "Срок кода истёк. Запросите новый.");
  if (attempt.verification_attempts >= 5) throw new HttpError(429, "Слишком много попыток. Запросите новый код.");
  const actual = Buffer.from(otpHash(attemptId, code));
  const expected = Buffer.from(attempt.code_hash);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    await pool.query("UPDATE phone_registration_attempts SET verification_attempts = verification_attempts + 1 WHERE id = $1", [attemptId]);
    throw new HttpError(401, "Неверный код.");
  }
  await pool.query("UPDATE phone_registration_attempts SET verified_at = now() WHERE id = $1", [attemptId]);
  json(res, 200, { registrationToken: attemptId, generatedPassword: crypto.randomBytes(12).toString("base64url") });
}

async function completePhoneRegistration(req, res) {
  const data = await body(req);
  const name = validateName(data.name);
  const password = validatePassword(data.password);
  const email = String(data.email || "").trim() ? normalizeEmail(data.email) : null;
  const attemptId = String(data.registrationToken || "");
  if (!/^[0-9a-f-]{36}$/i.test(attemptId)) throw new HttpError(400, "Сначала подтвердите номер через Telegram.");
  if (data.consent !== true) throw new HttpError(400, "Для регистрации необходимо согласие на обработку данных.");
  const passwordHash = await hashPassword(password);
  const client = await pool.connect();
  let master;
  try {
    await client.query("BEGIN");
    const result = await client.query(
      "SELECT id, phone, telegram_chat_id FROM phone_registration_attempts WHERE id = $1 AND verified_at IS NOT NULL AND used_at IS NULL AND expires_at > now() FOR UPDATE",
      [attemptId]
    );
    const attempt = result.rows[0];
    if (!attempt) throw new HttpError(400, "Подтверждение номера истекло. Начните регистрацию заново.");
    const inserted = await client.query(
      "INSERT INTO masters (name, email, phone, password_hash, consent_at, consent_version) VALUES ($1, $2, $3, $4, now(), '2026-11-04') RETURNING id, name, email, phone",
      [name, email, attempt.phone, passwordHash]
    );
    master = inserted.rows[0];
    await client.query("UPDATE phone_registration_attempts SET used_at = now() WHERE id = $1", [attemptId]);
    if (attempt.telegram_chat_id) {
      await client.query("INSERT INTO telegram_links (master_id, chat_id) VALUES ($1, $2)", [master.id, attempt.telegram_chat_id]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") throw new HttpError(409, "Аккаунт с таким номером или почтой уже существует.");
    throw error;
  } finally {
    client.release();
  }
  const token = await createSession(master.id);
  json(res, 201, { master }, { "Set-Cookie": sessionCookie(token) });
}

async function processTelegramUpdate(update) {
  const message = update.message;
  if (message?.text?.startsWith("/start")) {
    const match = message.text.match(/^\/start\s+([0-9a-f-]{36})$/i);
    if (match) {
      let purpose = "login";
      let result = await pool.query("SELECT id FROM phone_login_attempts WHERE id = $1 AND used_at IS NULL AND expires_at > now()", [match[1]]);
      if (!result.rows[0]) {
        purpose = "register";
        result = await pool.query("SELECT id FROM phone_registration_attempts WHERE id = $1 AND used_at IS NULL AND verified_at IS NULL AND expires_at > now()", [match[1]]);
      }
      if (result.rows[0]) {
        const table = purpose === "register" ? "phone_registration_attempts" : "phone_login_attempts";
        await pool.query(`UPDATE ${table} SET telegram_chat_id = $1 WHERE id = $2`, [message.chat.id, match[1]]);
      }
    }
    await telegramApi("sendMessage", {
      chat_id: message.chat.id,
      text: "Чтобы подтвердить номер, нажмите «Отправить контакт».",
      reply_markup: { keyboard: [[{ text: "Отправить контакт", request_contact: true }]], resize_keyboard: true, one_time_keyboard: false }
    });
  } else if (message?.contact) {
    if (message.contact.user_id !== message.from.id) {
      await telegramApi("sendMessage", { chat_id: message.chat.id, text: "Нужно отправить собственный контакт Telegram." });
    } else {
      const phone = normalizePhone(message.contact.phone_number);
      const result = await pool.query(
        "SELECT id, phone, telegram_chat_id, 'login' AS purpose, created_at FROM phone_login_attempts WHERE (telegram_chat_id = $1 OR telegram_chat_id IS NULL) AND phone = $2 AND used_at IS NULL AND expires_at > now() UNION ALL SELECT id, phone, telegram_chat_id, 'register' AS purpose, created_at FROM phone_registration_attempts WHERE (telegram_chat_id = $1 OR telegram_chat_id IS NULL) AND phone = $2 AND used_at IS NULL AND verified_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1",
        [message.chat.id, phone]
      );
      const attempt = result.rows[0];
      if (attempt) {
        attempt.telegram_chat_id = message.chat.id;
        const table = attempt.purpose === "register" ? "phone_registration_attempts" : "phone_login_attempts";
        await pool.query(`UPDATE ${table} SET telegram_chat_id = $1 WHERE id = $2`, [message.chat.id, attempt.id]);
        await sendPhoneCode(attempt, attempt.purpose);
      } else {
        await telegramApi("sendMessage", { chat_id: message.chat.id, text: "Не нашёл активную заявку с таким номером. Вернитесь на страницу и снова нажмите «Получить код».", reply_markup: { remove_keyboard: true } });
      }
    }
  }
}

async function telegramWebhook(req, res) {
  if (req.headers["x-telegram-bot-api-secret-token"] !== process.env.TELEGRAM_WEBHOOK_SECRET || !process.env.TELEGRAM_WEBHOOK_SECRET) {
    throw new HttpError(401, "Неверный секрет webhook.");
  }
  await processTelegramUpdate(await body(req));
  json(res, 200, { ok: true });
}

async function pollTelegram() {
  await telegramApi("deleteWebhook", { drop_pending_updates: false });
  let offset = 0;
  while (true) {
    try {
      const updates = await telegramApi("getUpdates", { offset, timeout: 50, allowed_updates: ["message"] }, 65000);
      for (const update of updates) {
        offset = update.update_id + 1;
        await processTelegramUpdate(update);
      }
    } catch (error) {
      console.error(error.message);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

async function handle(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "600" });
    return res.end();
  }
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/health" && req.method === "GET") {
    await pool.query("SELECT 1");
    return json(res, 200, { ok: true });
  }
  if (url.pathname === "/api/auth/register" && req.method === "POST") {
    rateLimit(req, "register");
    return await register(req, res);
  }
  if (url.pathname === "/api/auth/register-phone/start" && req.method === "POST") {
    rateLimit(req, "register-phone-start");
    return await registrationPhoneStart(req, res);
  }
  if (url.pathname === "/api/auth/register-phone/verify" && req.method === "POST") {
    rateLimit(req, "register-phone-verify");
    return await registrationPhoneVerify(req, res);
  }
  if (url.pathname === "/api/auth/register/complete" && req.method === "POST") {
    rateLimit(req, "register-complete");
    return await completePhoneRegistration(req, res);
  }
  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    rateLimit(req, "login");
    return await login(req, res);
  }
  if (url.pathname === "/api/auth/phone/start" && req.method === "POST") {
    rateLimit(req, "phone-start");
    return await phoneStart(req, res);
  }
  if (url.pathname === "/api/auth/phone/verify" && req.method === "POST") {
    rateLimit(req, "phone-verify");
    return await phoneVerify(req, res);
  }
  if (url.pathname === "/api/telegram/webhook" && req.method === "POST") return await telegramWebhook(req, res);
  if (url.pathname === "/api/auth/logout" && req.method === "POST") return await logout(req, res);
  if (url.pathname === "/api/auth/me" && req.method === "GET") {
    const master = await currentMaster(req);
    if (!master) throw new HttpError(401, "Вход не выполнен.");
    return json(res, 200, { master });
  }
  throw new HttpError(404, "Адрес не найден.");
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(error => {
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) console.error(error);
    if (!res.headersSent) json(res, status, { error: status === 500 ? "Внутренняя ошибка сервера." : error.message });
    else res.end();
  });
});

async function start() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  await pool.query(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
  server.listen(PORT, "127.0.0.1", () => console.log(`Masterfolio API listening on 127.0.0.1:${PORT}`));
  if (process.env.TELEGRAM_BOT_TOKEN) pollTelegram().catch(error => console.error(error.message));
}

start().catch(error => {
  console.error(error);
  process.exit(1);
});

process.on("SIGTERM", () => server.close(() => pool.end().then(() => process.exit(0))));
