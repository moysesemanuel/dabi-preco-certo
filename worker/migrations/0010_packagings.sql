-- Additive packaging catalog and recipe relations. Existing financial rows are untouched.
CREATE TABLE IF NOT EXISTS packagings (
  user_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
  purchase_price REAL NOT NULL, purchase_quantity REAL NOT NULL,
  capacity REAL, active INTEGER NOT NULL DEFAULT 1,
  rev INTEGER NOT NULL, deleted_at TEXT,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_packagings_rev ON packagings (user_id, rev);
CREATE TABLE IF NOT EXISTS recipe_packaging_items (
  user_id TEXT NOT NULL, recipe_id TEXT NOT NULL, position INTEGER NOT NULL,
  packaging_id TEXT NOT NULL, quantity_per_unit REAL NOT NULL,
  PRIMARY KEY (user_id, recipe_id, position)
);
CREATE INDEX IF NOT EXISTS idx_recipe_packaging_items_packaging ON recipe_packaging_items (user_id, packaging_id);
ALTER TABLE orders ADD COLUMN packaging_items_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE orders ADD COLUMN cost_snapshot_packaging_json TEXT NOT NULL DEFAULT '[]';
