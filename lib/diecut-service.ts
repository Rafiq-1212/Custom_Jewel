// lib/services/diecut.ts
//
// Server-only. Sits beside your AI-generation service behind the same kind of
// abstraction, so the storefront never learns that a Python process exists.

import { z } from "zod";

const CATEGORIES = ["contour_bust", "contour_face"] as const;
export type DieCutCategory = (typeof CATEGORIES)[number];

const ResponseSchema = z.object({
  cacheKey: z.string(),
  cutSvg: z.string(),
  previewPng: z.string(), // base64
});

export interface DieCutInput {
  photoUrl: string;
  lineArtUrl: string;
  category: DieCutCategory;
  bailX?: number;
}

export interface DieCutResult {
  cacheKey: string;
  cutSvgUrl: string;   // manufacturing file
  previewUrl: string;  // storefront preview
}

export interface DieCutService {
  generate(input: DieCutInput): Promise<DieCutResult>;
}

/** Talks to the Python service. */
class HttpDieCutService implements DieCutService {
  constructor(
    private baseUrl: string,
    private token: string,
    private upload: (key: string, body: Buffer, contentType: string) => Promise<string>,
  ) {}

  async generate(input: DieCutInput): Promise<DieCutResult> {
    const res = await fetch(`${this.baseUrl}/diecut`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, token: this.token }),
      // die-cutting takes a few seconds; don't let a proxy cache it
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      throw new Error(`diecut failed (${res.status}): ${await res.text()}`);
    }

    const data = ResponseSchema.parse(await res.json());

    const [cutSvgUrl, previewUrl] = await Promise.all([
      this.upload(
        `diecut/${data.cacheKey}/cut.svg`,
        Buffer.from(data.cutSvg, "utf8"),
        "image/svg+xml",
      ),
      this.upload(
        `diecut/${data.cacheKey}/preview.png`,
        Buffer.from(data.previewPng, "base64"),
        "image/png",
      ),
    ]);

    return { cacheKey: data.cacheKey, cutSvgUrl, previewUrl };
  }
}

/** Mock for local dev, same shape as your other mocked services. */
class MockDieCutService implements DieCutService {
  async generate(input: DieCutInput): Promise<DieCutResult> {
    return {
      cacheKey: "mock",
      cutSvgUrl: "/mock/cut.svg",
      previewUrl: input.lineArtUrl,
    };
  }
}

export function createDieCutService(
  upload: (key: string, body: Buffer, contentType: string) => Promise<string>,
): DieCutService {
  const base = process.env.DIECUT_URL;
  if (!base) return new MockDieCutService();
  return new HttpDieCutService(base, process.env.DIECUT_TOKEN ?? "", upload);
}
