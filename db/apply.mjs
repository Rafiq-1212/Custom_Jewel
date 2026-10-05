// Applies db/schema.sql to the database in DATABASE_URL (read from .env.local when not set).
import fs from 'node:fs';
import { neon } from '@neondatabase/serverless';

const here = new URL('.', import.meta.url);
let url = process.env.DATABASE_URL;
if (!url) {
  const env = fs.readFileSync(new URL('../.env.local', here), 'utf8');
  url = /^DATABASE_URL="?([^"\n]+)"?/m.exec(env)?.[1];
}
if (!url) throw new Error('DATABASE_URL is not set.');
const sql = neon(url);
const statements = fs
  .readFileSync(new URL('schema.sql', here), 'utf8')
  .replace(/^\s*--.*$/gm, '')
  .replace(/--[^\n]*/g, '')
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);
for (const statement of statements) await sql.query(statement);
const tables = await sql.query("select table_name from information_schema.tables where table_schema = 'public' order by 1");
console.log('tables:', tables.map((t) => t.table_name).join(', '));
