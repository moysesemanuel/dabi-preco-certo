-- Recebimentos (pagamentos parciais) das encomendas. O sinal continua em orders.deposit.
CREATE TABLE IF NOT EXISTS order_payments (
  user_id     TEXT NOT NULL,
  order_id    TEXT NOT NULL,
  position    INTEGER NOT NULL,
  id          TEXT NOT NULL,
  amount      REAL NOT NULL,
  received_at TEXT NOT NULL,
  method      TEXT,
  note        TEXT,
  PRIMARY KEY (user_id, order_id, position)
);
CREATE INDEX IF NOT EXISTS idx_order_payments_order ON order_payments (user_id, order_id);
