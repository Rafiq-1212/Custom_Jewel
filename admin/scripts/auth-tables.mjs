// Creates (or brings up to date) the sign-in tables Better Auth needs, in the
// database in DATABASE_URL (read from .env.local when not set). Safe to run again.
import fs from 'node:fs';
import { getMigrations } from 'better-auth/db/migration';
import { Pool } from '@neondatabase/serverless';

let url = process.env.DATABASE_URL;
if (!url) url = /^DATABASE_URL="?([^"\n]+)"?/m.exec(fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8'))?.[1];
if (!url) throw new Error('DATABASE_URL is not set.');
const pool = new Pool({ connectionString: url });
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations({ database: pool, emailAndPassword: { enabled: true } });
await runMigrations();
console.log('created:', toBeCreated.map((t) => t.table).join(', ') || 'nothing', '| altered:', toBeAdded.map((t) => t.table).join(', ') || 'nothing');
await pool.end();
