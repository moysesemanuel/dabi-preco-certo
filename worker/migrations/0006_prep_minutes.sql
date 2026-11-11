-- Tempo estimado de produção da receita (minutos por receita/lote), usado na análise de prazo.
ALTER TABLE recipes ADD COLUMN prep_minutes REAL;
