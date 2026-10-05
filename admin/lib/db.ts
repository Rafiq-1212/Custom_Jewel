/**
 * The shared database (../db/schema.sql): written by the pendant tool, read
 * here. Made on first use, not at import, so `next build` runs with no
 * database in the environment.
 */

import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

let client: NeonQueryFunction<false, false> | null = null;

export function db(): NeonQueryFunction<false, false> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
  client ??= neon(process.env.DATABASE_URL);
  return client;
}
