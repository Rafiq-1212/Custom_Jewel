// Makes the admin account, or resets its password if it already exists.
//
//   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='...' node scripts/seed-admin.mjs
//
// The email and password are given when it is run and are never written to
// the repository. This is the only way an account is made: the panel has no
// sign-up. DATABASE_URL is read from .env.local when not set.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { betterAuth } from 'better-auth';
import { Pool } from '@neondatabase/serverless';

const email = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD ?? '';
const name = process.env.ADMIN_NAME ?? 'Admin';
if (!email.includes('@') || !password) throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD.');

let url = process.env.DATABASE_URL;
if (!url) url = /^DATABASE_URL="?([^"\n]+)"?/m.exec(fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8'))?.[1];
if (!url) throw new Error('DATABASE_URL is not set.');

const pool = new Pool({ connectionString: url });
// The password chosen here is the owner's own call, so no minimum length is
// applied to it; the panel itself asks for 10 characters when one is changed.
const auth = betterAuth({
  database: pool,
  // Neither is used for anything here: passwords are hashed without the secret, and no request is served.
  secret: randomBytes(32).toString('hex'),
  baseURL: 'http://localhost',
  emailAndPassword: { enabled: true, minPasswordLength: 1 },
});

const existing = await pool.query('select id from "user" where email = $1', [email]);
if (existing.rows.length) {
  const { password: hasher } = await auth.$context;
  const updated = await pool.query(`update account set password = $1, "updatedAt" = now() where "userId" = $2 and "providerId" = 'credential'`, [
    await hasher.hash(password),
    existing.rows[0].id,
  ]);
  await pool.query('delete from session where "userId" = $1', [existing.rows[0].id]);
  console.log(updated.rowCount ? `password reset for ${email}; signed out everywhere` : `no password login found for ${email}`);
} else {
  await auth.api.signUpEmail({ body: { name, email, password } });
  console.log(`admin account created for ${email}`);
}
await pool.end();
