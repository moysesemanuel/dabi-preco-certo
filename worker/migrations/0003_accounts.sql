-- Contas, sessões e códigos de acesso. Login sem senha: o código enviado por e-mail prova a posse do endereço.
CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL UNIQUE,         -- normalizado (minúsculas)
  email_verified_at TEXT,
  created_at        TEXT NOT NULL,
  disabled_at       TEXT
);

-- A licença passa a poder ser associada a uma conta (por e-mail do comprador).
ALTER TABLE licenses ADD COLUMN email TEXT;       -- e-mail para o qual a licença foi emitida
ALTER TABLE licenses ADD COLUMN user_id TEXT;     -- preenchido no primeiro login verificado
CREATE UNIQUE INDEX IF NOT EXISTS idx_licenses_email ON licenses (email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_licenses_user ON licenses (user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,   -- SHA-256 do token do cookie; o token em si nunca é gravado
  csrf_token   TEXT NOT NULL,          -- exigido no cabeçalho X-CSRF-Token em operações que alteram dados
  device_label TEXT,                   -- rótulo informado pelo usuário (ex.: "Celular da Bia")
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id, revoked_at);

CREATE TABLE IF NOT EXISTS auth_codes (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  code_hash  TEXT NOT NULL,            -- HMAC-SHA256 (segredo do servidor) do código; códigos de 8 dígitos não resistiriam a um SHA-256 simples
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  used_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_codes_email ON auth_codes (email, created_at);
