-- Dados do usuário no servidor (fonte autoritativa quando há conta + licença). Isolamento: toda linha tem user_id.
-- Exclusões são lógicas (deleted_at): o servidor nunca apaga dados do usuário por sincronização.
CREATE TABLE IF NOT EXISTS sync_state (
  user_id       TEXT PRIMARY KEY,
  revision      INTEGER NOT NULL DEFAULT 0,   -- aumenta a cada envio aceito
  last_push_id  TEXT,                          -- identifica o envio que está sendo aplicado (guarda de atomicidade)
  settings_json TEXT,
  settings_rev  INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingredients (
  user_id           TEXT NOT NULL,
  id                TEXT NOT NULL,
  name              TEXT NOT NULL,
  unit              TEXT NOT NULL,
  purchase_quantity REAL NOT NULL,
  purchase_price    REAL NOT NULL,
  density_g_per_ml  REAL,
  grams_per_unit    REAL,
  rev               INTEGER NOT NULL,          -- revisão da conta em que esta linha mudou pela última vez
  deleted_at        TEXT,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_ingredients_rev ON ingredients (user_id, rev);

CREATE TABLE IF NOT EXISTS recipes (
  user_id           TEXT NOT NULL,
  id                TEXT NOT NULL,
  name              TEXT NOT NULL,
  yield             REAL NOT NULL,
  packaging_per_unit REAL NOT NULL,
  labor_total       REAL NOT NULL,
  extra_total       REAL NOT NULL,
  desired_margin    REAL NOT NULL,
  rev               INTEGER NOT NULL,
  deleted_at        TEXT,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_recipes_rev ON recipes (user_id, rev);

CREATE TABLE IF NOT EXISTS recipe_items (
  user_id       TEXT NOT NULL,
  recipe_id     TEXT NOT NULL,
  position      INTEGER NOT NULL,
  ingredient_id TEXT NOT NULL,
  quantity      REAL NOT NULL,
  unit          TEXT,
  PRIMARY KEY (user_id, recipe_id, position)
);
CREATE INDEX IF NOT EXISTS idx_recipe_items_ingredient ON recipe_items (user_id, ingredient_id);

CREATE TABLE IF NOT EXISTS orders (
  user_id          TEXT NOT NULL,
  id               TEXT NOT NULL,
  customer         TEXT NOT NULL,
  recipe_id        TEXT NOT NULL,
  quantity         REAL NOT NULL,
  unit_price       REAL NOT NULL,
  deposit          REAL NOT NULL,
  delivery_date    TEXT NOT NULL,
  status           TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  cost_per_unit    REAL,                       -- custo histórico registrado (snapshot); NULL = não registrado
  cost_captured_at TEXT,
  rev              INTEGER NOT NULL,
  deleted_at       TEXT,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_orders_rev ON orders (user_id, rev);
CREATE INDEX IF NOT EXISTS idx_orders_recipe ON orders (user_id, recipe_id);
