-- Painel administrativo do proprietário. Migração ADITIVA (nenhuma tabela existente é alterada).
-- Permissão administrativa = linha ativa em `admins` para o usuário da sessão. Só é criada por operação administrativa fora da interface
-- pública (CLI `grant-admin`); nenhuma rota pública cria administradores e nenhum campo enviado pelo cliente conta como prova de permissão.
CREATE TABLE IF NOT EXISTS admins (
  user_id    TEXT PRIMARY KEY,                       -- users.id
  role       TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner')),   -- espaço para novos papéis no futuro
  granted_at TEXT NOT NULL,
  granted_by TEXT NOT NULL,                          -- 'cli' (bootstrap) ou o user_id de quem concedeu
  revoked_at TEXT
);

-- Histórico de ações administrativas. Nunca guarda tokens, códigos de login nem dados privados dos clientes.
CREATE TABLE IF NOT EXISTS admin_audit (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  at             TEXT NOT NULL,
  admin_user_id  TEXT NOT NULL,                      -- quem agiu ('cli' para o bootstrap feito no terminal)
  action         TEXT NOT NULL,                      -- ex.: customer.create, customer.suspend, session.revoke
  license_id     TEXT,                               -- conta (licença) afetada
  target_user_id TEXT,
  result         TEXT NOT NULL,                      -- 'ok' | 'noop'
  detail         TEXT                                -- código curto e não sensível (ex.: 'sessions=2')
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_at ON admin_audit (at);
CREATE INDEX IF NOT EXISTS idx_admin_audit_license ON admin_audit (license_id, id);
-- Listagem paginada de clientes (mais recentes primeiro).
CREATE INDEX IF NOT EXISTS idx_licenses_created ON licenses (created_at, id);
