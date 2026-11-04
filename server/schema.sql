CREATE TABLE IF NOT EXISTS masters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(60) NOT NULL,
  email text NOT NULL,
  phone text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS masters_email_unique ON masters (lower(email));

ALTER TABLE masters ADD COLUMN IF NOT EXISTS consent_at timestamptz;
ALTER TABLE masters ADD COLUMN IF NOT EXISTS consent_version text;

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash char(64) NOT NULL UNIQUE,
  master_id uuid NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_master_id_idx ON sessions (master_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS telegram_links (
  master_id uuid PRIMARY KEY REFERENCES masters(id) ON DELETE CASCADE,
  chat_id bigint NOT NULL UNIQUE,
  telegram_username text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS phone_login_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  master_id uuid NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  phone text NOT NULL,
  telegram_chat_id bigint,
  code_hash text,
  verification_attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE INDEX IF NOT EXISTS phone_login_attempts_chat_idx ON phone_login_attempts (telegram_chat_id);
CREATE INDEX IF NOT EXISTS phone_login_attempts_expires_idx ON phone_login_attempts (expires_at);

ALTER TABLE masters ALTER COLUMN email DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS masters_phone_unique ON masters (phone);

CREATE TABLE IF NOT EXISTS phone_registration_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone text NOT NULL,
  telegram_chat_id bigint,
  code_hash text,
  verification_attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  used_at timestamptz
);

CREATE INDEX IF NOT EXISTS phone_registration_attempts_chat_idx ON phone_registration_attempts (telegram_chat_id);
CREATE INDEX IF NOT EXISTS phone_registration_attempts_expires_idx ON phone_registration_attempts (expires_at);
