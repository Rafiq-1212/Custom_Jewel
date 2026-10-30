/**
 * GET /api/try/image?job=...&kind=sketch|photo&metal=gold|silver&token=...
 * One of the signed-in customer's own pictures, from the private store: the
 * sketch, or the product photo in a metal. The token comes in the address
 * because an <img> cannot send a header; it is the customer's own.
 * Or &key=... in place of the token: the design's own picture link, kept on
 * the shop's cart line (app/api/try/picture-key).
 */

import { timingSafeEqual } from 'node:crypto';
import { get } from '@vercel/blob';
import { phoneFromToken, pictureKey } from '@/lib/customer-session';
import { folderOf, folderOfJob, pictureOf } from '@/lib/customers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const JOB_NAME = /^batches\/[A-Za-z0-9_-]{1,128}$/;

async function folderByKey(job: string, key: string): Promise<string | null> {
  const expected = Buffer.from(pictureKey(job));
  const given = Buffer.from(key);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return folderOfJob(job);
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const job = params.get('job') ?? '';
  const key = params.get('key');
  const phone = key ? null : phoneFromToken(params.get('token'));
  if (!key && !phone) return new Response('Sign in first.', { status: 401 });
  if (!JOB_NAME.test(job)) return new Response('Not found', { status: 404 });
  const folder = key ? await folderByKey(job, key) : await folderOf(phone!, job);
  if (!folder) return new Response('Not found', { status: 404 });
  const metal = params.get('metal') === 'silver' ? 'silver' : 'gold';
  const path = await pictureOf(folder, params.get('kind') === 'photo' ? 'photo' : 'sketch', metal);
  if (!path) return new Response('Not found', { status: 404 });
  const blob = await get(path, { access: 'private' }).catch(() => null);
  if (!blob || blob.statusCode !== 200) return new Response('Not found', { status: 404 });
  return new Response(blob.stream, { headers: { 'Content-Type': blob.blob.contentType, 'Cache-Control': 'private, max-age=3600' } });
}
