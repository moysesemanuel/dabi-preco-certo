-- Freeze the amount actually charged for order-level packaging. Existing orders remain unchanged.
ALTER TABLE orders ADD COLUMN packaging_charge REAL NOT NULL DEFAULT 0 CHECK (packaging_charge >= 0);
