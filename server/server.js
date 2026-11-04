const http = require("node:http");
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
  const passwordHash = await hashPassword(password);
  try {
    const result = await pool.query(
      "INSERT INTO masters (name, email, phone, password_hash) VALUES ($1, $2, $3, $4) RETURNING id, name, email, phone",
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
  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    rateLimit(req, "login");
    return await login(req, res);
  }
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
}

start().catch(error => {
  console.error(error);
  process.exit(1);
});

process.on("SIGTERM", () => server.close(() => pool.end().then(() => process.exit(0))));
