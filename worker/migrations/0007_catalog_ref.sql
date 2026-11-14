-- Referência do catálogo de medidas escolhida pelo usuário para o ingrediente (JSON: id, variante, versão do catálogo e valores congelados).
-- Coluna opcional: ingredientes existentes continuam como estão (NULL = sem referência; os valores informados pelo usuário seguem em density_g_per_ml / grams_per_unit).
-- Ordem de publicação: aplicar esta migração ANTES de publicar o Worker e o app novos.
ALTER TABLE ingredients ADD COLUMN catalog_ref TEXT;
