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

CREATE TABLE IF NOT EXISTS telegram_state (
  key text PRIMARY KEY,
  value text NOT NULL
);

ALTER TABLE masters ADD COLUMN IF NOT EXISTS yandex_id text;
CREATE UNIQUE INDEX IF NOT EXISTS masters_yandex_unique ON masters (yandex_id);
ALTER TABLE masters ALTER COLUMN phone DROP NOT NULL;
ALTER TABLE masters ALTER COLUMN password_hash DROP NOT NULL;

CREATE TABLE IF NOT EXISTS oauth_states (
  state text PRIMARY KEY,
  return_url text NOT NULL,
  consent boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE INDEX IF NOT EXISTS oauth_states_expires_idx ON oauth_states (expires_at);

CREATE TABLE IF NOT EXISTS certificates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  master_id uuid NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  number integer NOT NULL,
  recipient varchar(60) NOT NULL,
  amount integer NOT NULL CHECK (amount > 0),
  issued_on date NOT NULL,
  expires_on date NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'redeemed')),
  redeemed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (master_id, number)
);

CREATE INDEX IF NOT EXISTS certificates_master_idx ON certificates (master_id, number DESC);

CREATE TABLE IF NOT EXISTS booking_profiles (
  master_id uuid PRIMARY KEY REFERENCES masters(id) ON DELETE CASCADE,
  slug text NOT NULL UNIQUE,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS booking_profiles_slug_idx ON booking_profiles (slug);

CREATE TABLE IF NOT EXISTS booking_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  master_id uuid NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  name varchar(60) NOT NULL,
  phone text NOT NULL,
  services jsonb NOT NULL,
  day date NOT NULL,
  time text NOT NULL,
  comment text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'declined')),
  consent_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS booking_requests_master_idx ON booking_requests (master_id, created_at DESC);

ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS client_chat_id bigint;
ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS hold_until timestamptz NOT NULL DEFAULT now() + interval '5 hours';
ALTER TABLE booking_requests ALTER COLUMN hold_until SET DEFAULT now() + interval '5 hours';
ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;
ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS declined_at timestamptz;
ALTER TABLE booking_requests DROP CONSTRAINT IF EXISTS booking_requests_status_check;
ALTER TABLE booking_requests ADD CONSTRAINT booking_requests_status_check CHECK (status IN ('pending', 'confirmed', 'declined', 'expired'));

CREATE TABLE IF NOT EXISTS telegram_clients (
  phone text PRIMARY KEY,
  chat_id bigint NOT NULL,
  username text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS telegram_clients_chat_idx ON telegram_clients (chat_id);
CREATE INDEX IF NOT EXISTS booking_requests_client_idx ON booking_requests (client_chat_id);

CREATE TABLE IF NOT EXISTS booking_blacklist (
  master_id uuid NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  phone text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (master_id, phone)
);

CREATE INDEX IF NOT EXISTS booking_blacklist_master_idx ON booking_blacklist (master_id, created_at DESC);
