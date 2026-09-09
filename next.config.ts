import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `potrace` (and its Jimp dependency) does internal `instanceof` checks
  // against its own classes; bundling it re-wraps those exports and breaks
  // that check ("Right-hand side of 'instanceof' is not callable"). Leaving
  // it as a plain Node `require()` — exactly what this option is for —
  // avoids the rewrite. Only used server-side, in lib/laser-export.ts.
  serverExternalPackages: ["potrace"],
};

export default nextConfig;
