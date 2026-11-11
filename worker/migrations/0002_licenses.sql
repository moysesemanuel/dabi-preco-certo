-- Licenças individuais dos compradores. A chave NUNCA é armazenada: apenas o SHA-256 dela.
CREATE TABLE IF NOT EXISTS licenses (
  id           TEXT PRIMARY KEY,              -- identificador interno do proprietário (usado em quotes.owner_id)
  key_hash     TEXT NOT NULL UNIQUE,          -- SHA-256 (hex) da chave de licença
  label        TEXT,                          -- referência administrativa opcional (sem dados sensíveis)
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  quota_active INTEGER NOT NULL DEFAULT 100 CHECK (quota_active >= 0),  -- máx. de orçamentos ativos (não revogados)
  quota_daily  INTEGER NOT NULL DEFAULT 30  CHECK (quota_daily >= 0),   -- máx. de orçamentos criados por dia (fuso do Brasil)
  created_at   TEXT NOT NULL,
  revoked_at   TEXT
);

-- Contadores de limitação de taxa (janela fixa). Atualizados de forma atômica; linhas antigas são limpas pelo Worker.
CREATE TABLE IF NOT EXISTS rate_limits (
  license_id   TEXT NOT NULL,
  scope        TEXT NOT NULL,                 -- 'write' ou 'verify'
  window_start INTEGER NOT NULL,              -- início da janela, em segundos desde a época
  count        INTEGER NOT NULL,
  PRIMARY KEY (license_id, scope, window_start)
);

CREATE INDEX IF NOT EXISTS idx_quotes_owner_active ON quotes (owner_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_quotes_owner_created ON quotes (owner_id, created_at);
