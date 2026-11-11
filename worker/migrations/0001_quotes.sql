-- Orçamentos compartilhados. Guarda apenas a cópia pública (PublicQuote); nada do banco local do app.
CREATE TABLE IF NOT EXISTS quotes (
  id         TEXT PRIMARY KEY,   -- identificador aleatório de 128 bits em base64url (22 caracteres)
  payload    TEXT NOT NULL,      -- JSON do PublicQuote já validado
  created_at TEXT NOT NULL,      -- ISO 8601 UTC
  updated_at TEXT NOT NULL,
  revoked_at TEXT,               -- preenchido quando o vendedor revoga o link
  owner_id   TEXT                -- RESERVADO: identidade do comprador autorizado (definida quando houver autenticação)
);
