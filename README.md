# Custom Jewellery Image Generator

A small Next.js app that turns an uploaded photo into a black-and-white
jewellery engraving line-art design, using Google's Gemini image model.

```bash
npm install
cp .env.example .env.local   # then add your real GEMINI_API_KEY
npm run dev                  # http://localhost:3000
```

Get a key from [Google AI Studio](https://aistudio.google.com/apikey).

## How it works

```
Browser                          Server                              Google
───────                          ──────                              ──────
<ImageUploader>          ──▶   POST /api/generate-image
  validates type/size            ├─ re-validates the real bytes
  (instant feedback)             │  (magic-byte sniff, not just
                                  │  the declared MIME type)
                                  ├─ lib/gemini.ts
                                  │    sends the photo as an actual
<GenerationProgress>      ◀──    │    image input (inlineData), not
  while waiting                  │    a URL or a text description  ──▶ gemini-3.1-flash-image
                                  ├─ extracts the generated image
<GeneratedImage>          ◀──    │  bytes from the response         ◀──
  + Download Preview             └─ returns { success, image }
                                     as a data: URL
```

The Gemini API key is read from `process.env.GEMINI_API_KEY` inside
`lib/gemini.ts` only, and never leaves the server. Nothing is persisted —
the uploaded photo and the generated image live only in the browser's
component state and in the one request/response pair that produced them.

## Layout

```
app/
  page.tsx                   the whole UI: upload → generate → result
  api/generate-image/route.ts   POST handler: validate → call Gemini → respond
components/
  ImageUploader.tsx           drag-and-drop / browse, client-side validation
  ImagePreview.tsx            a single labelled image panel
  GenerationProgress.tsx      cycling status messages while waiting
  GeneratedImage.tsx          result image + download
lib/
  gemini.ts                   all Gemini-specific logic: client, prompt,
                               request/response shape, typed errors
  validation.ts                accepted types/size + magic-byte sniffing,
                               shared by the client (instant feedback) and
                               the server (the check that actually decides)
```

## Error handling

Every failure the server can produce maps to one plain, customer-facing
sentence — no error codes, no stack traces, no raw provider messages ever
reach the browser. The technical detail is logged server-side only, via
`console.error`. Covered: no file selected, unsupported format (checked by
content, not extension), file too large, missing/invalid API key, rate
limit / quota exceeded, safety-blocked generation, an empty response from
the model, and network failures.

## Notes

- **Model**: `gemini-3.1-flash-image`, pinned as a literal in `lib/gemini.ts`
  — the current stable image model, not a `-preview` alias.
- **Free tier**: a `429` with a quota message in the response means your
  Google Cloud project has no free-tier allowance for this model, not a bug
  in the app. Check [ai.dev/rate-limit](https://ai.dev/rate-limit) and make
  sure billing is enabled on the project behind your API key — image-output
  models generally require it even at low volume.
- **Size limit**: uploads are capped at 8MB (`lib/validation.ts`).
