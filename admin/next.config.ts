import type { NextConfig } from 'next';
import { BASE_PATH } from './lib/base-path';

/** The address people use, and this app's own: the forms on its pages are posted from either. */
const ORIGINS = ['true-b.vercel.app', 'true-b-admin.vercel.app', 'localhost:3011', 'localhost:3012'];

const nextConfig: NextConfig = {
  basePath: BASE_PATH,
  experimental: { serverActions: { allowedOrigins: ORIGINS } },
  async redirects() {
    // The panel's own address, bare, is not a page any more.
    return [{ source: '/', destination: BASE_PATH, permanent: false, basePath: false }];
  },
};

export default nextConfig;
