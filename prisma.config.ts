import path from "node:path";
import fs from "node:fs";
import { defineConfig } from "prisma/config";

// Load DATABASE_URL: env wins, then .env at repo root (dev fallback).
function loadDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const match = line.match(/^DATABASE_URL\s*=\s*"?([^"]*)"?\s*$/);
      if (match) return match[1];
    }
  }
  return "";
}

export default defineConfig({
  schema: path.join(__dirname, "prisma", "schema.prisma"),
  migrations: {
    path: path.join(__dirname, "prisma", "migrations"),
  },
  datasource: {
    url: loadDatabaseUrl(),
  },
});
