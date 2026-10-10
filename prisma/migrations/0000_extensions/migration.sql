-- 0000_init 的 Message.embedding 欄位使用 pgvector 的 vector 型別；
-- 此 migration 排在 0000_init 之前，讓全新資料庫可以直接套用。
CREATE EXTENSION IF NOT EXISTS "vector";
