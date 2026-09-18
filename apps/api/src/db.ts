import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Pool } from "pg";

dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env") });

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing. Add your Neon connection string to the root .env file.");
}

export const database = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

export async function initializeDatabase() {
  await database.query("CREATE EXTENSION IF NOT EXISTS vector");
  await database.query(`
    CREATE TABLE IF NOT EXISTS repositories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      github_url TEXT NOT NULL UNIQUE,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      branch TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS code_chunks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding vector(1536) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS code_chunks_repository_idx ON code_chunks(repository_id);
  `);
}
