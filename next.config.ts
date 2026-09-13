import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `potrace` (and its Jimp dependency) does internal `instanceof` checks
  // against its own classes; bundling it re-wraps those exports and breaks
  // that check ("Right-hand side of 'instanceof' is not callable"). Leaving
  // it as a plain Node `require()` — exactly what this option is for —
  // avoids the rewrite. Only used server-side, in lib/laser-export.ts.
  //
  // `rhino3dm` is a WASM module that locates its own .wasm file relative to
  // its package directory at load time; bundling it would break that lookup.
  // Only used server-side, in lib/rhino-export.ts.
  serverExternalPackages: ["potrace", "rhino3dm"],

  // rhino3dm reads rhino3dm.wasm from disk at runtime rather than importing
  // it, so file tracing can't see it. Without this, serverless deployments
  // (e.g. Vercel) ship the export route without the .wasm and the 3DM export
  // fails in production only.
  outputFileTracingIncludes: {
    "/api/export-laser": ["./node_modules/rhino3dm/rhino3dm.wasm"],
  },
};

export default nextConfig;
