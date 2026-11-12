-- Código permanente de atendimento do orçamento (ex.: ORC-K7M42P), gerado no aplicativo e único por conta.
-- Coluna opcional: encomendas existentes continuam com NULL até o aplicativo gravar o código derivado (nada financeiro é alterado).
-- Ordem de publicação: aplicar esta migração ANTES de publicar o Worker e o app novos.
ALTER TABLE orders ADD COLUMN quote_code TEXT;
-- Unicidade por conta (inclui encomendas excluídas logicamente, para um código nunca ser reaproveitado).
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_quote_code ON orders (user_id, quote_code) WHERE quote_code IS NOT NULL;
