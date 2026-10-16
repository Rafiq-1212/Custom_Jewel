import type { NextConfig } from "next";
import { ADMIN_ORIGIN } from "./lib/admin-origin";

const nextConfig: NextConfig = {
  // `potrace` (and its Jimp dependency) does internal `instanceof` checks
  // against its own classes; bundling it re-wraps those exports and breaks
  // that check ("Right-hand side of 'instanceof' is not callable"). Leaving
  // it as a plain Node `require()` — exactly what this option is for —
  // avoids the rewrite. Only used server-side, in lib/laser-export.ts.
  serverExternalPackages: ["potrace"],
  // The admin panel (admin/) is its own app, deployed as its own Vercel
  // project, and served here at /admin: every request under it is handed on.
  async rewrites() {
    const admin = ADMIN_ORIGIN;
    return [
      { source: "/admin", destination: `${admin}/admin` },
      { source: "/admin/:path+", destination: `${admin}/admin/:path+` },
    ];
  },
};

export default nextConfig;
