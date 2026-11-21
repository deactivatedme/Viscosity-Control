import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import path from 'node:path';
import { existsSync } from 'node:fs';
import * as schema from './schema';

export function createDb(url: string) {
  const client = postgres(url, { max: 10, onnotice: () => {} });
  return { db: drizzle(client, { schema }), client };
}
export type Db = ReturnType<typeof createDb>['db'];

export async function runMigrations(db: Db, dir?: string) {
  // running from src/db (tsx) or from dist/ (bundle)
  const candidates = [dir, path.resolve(import.meta.dirname, '../../drizzle'), path.resolve(import.meta.dirname, '../drizzle')];
  const folder = candidates.find((c) => c && existsSync(path.join(c, 'meta/_journal.json')));
  if (!folder) throw new Error('migrations folder not found; set MIGRATIONS_DIR');
  await migrate(db, { migrationsFolder: folder });
}
export { schema };
