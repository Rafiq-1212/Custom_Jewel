// Creates (or brings up to date) the sign-in tables Better Auth needs, in the
// database in DATABASE_URL (read from .env.local when not set). Safe to run again.
import fs from 'node:fs';
import { getMigrations } from 'better-auth/db/migration';
import { Pool } from '@neondatabase/serverless';

let url = process.env.DATABASE_URL;
if (!url) url = /^DATABASE_URL="?([^"\n]+)"?/m.exec(fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8'))?.[1];
if (!url) throw new Error('DATABASE_URL is not set.');
const pool = new Pool({ connectionString: url });
// The same extra fields as lib/auth.ts: a login's role, its screens, and whether it is still on a temporary password.
const user = {
  additionalFields: {
    role: { type: 'string', defaultValue: 'viewer', input: false },
    screens: { type: 'string', defaultValue: '', input: false },
    mustChangePassword: { type: 'boolean', defaultValue: false, input: false },
  },
};
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations({ database: pool, emailAndPassword: { enabled: true }, user });
await runMigrations();
// Logins made before roles existed were the owners; with no owner at all, the oldest login becomes one.
const owners = await pool.query(`select count(*)::int as n from "user" where role = 'owner'`);
if (owners.rows[0].n === 0) {
  const made = await pool.query(`update "user" set role = 'owner' where id = (select id from "user" order by "createdAt" limit 1) returning email`);
  if (made.rows.length) console.log('owner:', made.rows[0].email);
}
console.log('created:', toBeCreated.map((t) => t.table).join(', ') || 'nothing', '| altered:', toBeAdded.map((t) => t.table).join(', ') || 'nothing');
await pool.end();
