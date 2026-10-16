/**
 * Where the admin panel (admin/, its own Vercel project) answers. The tool
 * serves it at /admin by handing requests on to this address
 * (next.config.ts), and asks it whether a visitor is signed in
 * (lib/signed-in.ts). Local development points it at the panel's dev server.
 */
export const ADMIN_ORIGIN = process.env.ADMIN_ORIGIN || 'https://true-b-admin.vercel.app';
