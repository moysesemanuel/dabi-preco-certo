-- Encomendas com vários produtos (itens). Migração ADITIVA: nenhuma linha existente é alterada.
-- Encomendas antigas não ganham linhas aqui: o Worker as lê como UM item, a partir das colunas antigas de `orders`
-- (recipe_id, quantity, unit_price, cost_per_unit, cost_captured_at, cost_snapshot_packaging_json), com o id fixo 'item-1'.
-- Toda gravação nova de encomenda escreve TODOS os itens aqui e repete o primeiro item nas colunas antigas (NOT NULL).
CREATE TABLE IF NOT EXISTS order_items (
  user_id             TEXT NOT NULL,
  order_id            TEXT NOT NULL,
  position            INTEGER NOT NULL,
  id                  TEXT NOT NULL,
  recipe_id           TEXT NOT NULL,
  recipe_name         TEXT,                          -- nome da receita quando o item foi registrado; NULL em itens antigos
  quantity            REAL NOT NULL CHECK (quantity > 0),
  unit_price          REAL NOT NULL CHECK (unit_price >= 0),
  cost_per_unit       REAL,                          -- custo histórico registrado; NULL = não registrado
  cost_captured_at    TEXT,
  cost_packaging_json TEXT NOT NULL DEFAULT '[]',    -- embalagens da receita congeladas com o custo
  PRIMARY KEY (user_id, order_id, position)
);
-- Integridade ao excluir receitas: "alguma encomenda ativa usa esta receita?"
CREATE INDEX IF NOT EXISTS idx_order_items_recipe ON order_items (user_id, recipe_id);
