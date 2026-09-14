# True Tribute: Custom Pendant Design

An internal tool for **True Tribute by Prabu Jewellery**. You upload one photo
of a customer and get everything you need to list and make a custom photo
pendant:

1. **An engraving sketch.** A pen and ink portrait of the people (or pet) in
   the photo, drawn by Google Gemini.
2. **An instant preview** of that sketch on any pendant in the catalogue, in
   silver or gold.
3. **A realistic product photo** of the finished pendant for your online
   store.
4. **Files for production:** 3DM for Rhino, DXF for the laser cutter, and SVG.

```bash
npm install
cp .env.example .env.local   # then add your real GEMINI_API_KEY
npm run dev                  # http://localhost:3000
```

Get a key from [Google AI Studio](https://aistudio.google.com/apikey). Billing
has to be turned on for the key's Google Cloud project, because image models
don't have a free allowance. If you see a `429` quota error, that's a billing
issue, not a bug.

## How to use it

| Step | What you do | What happens |
|---|---|---|
| 1. Add a photo | Drop in or choose a JPG, PNG or WEBP (up to 8 MB). Drag the box around the people you want, leaving out stretched-out arms, other people and busy backgrounds | The photo is checked in the browser and again on the server. Only what's inside the box is sent |
| 2. Pick a pendant style | Face, Half Size, Couple, Family or Pet | Tells Gemini how to frame the sketch. Face stops at the jaw; Couple keeps both people |
| | Click **Create sketch** | **First AI call**, about 10 to 15 seconds |
| 3. Your sketch | Check it, and click **Draw it again** if it's not right | The sketch is trimmed and its background made see-through |
| 4. Choose the pendant | **Cut to shape** or **Shaped pendant** | For Cut to shape, the cut line and hanging ring are worked out from the sketch |
| 5. Choose the metal | Silver or gold | |
| 6. Preview | Compare silver and gold, and check the cut layout (black engraving, red cut line, ring) | Drawn instantly in the browser |
| 7. Adjust the artwork | Zoom, rotate and move the drawing | Drawn instantly in the browser |
| 8. Product photo | Click **Make silver photo** or **Make gold photo** | **Second AI call**, once for each metal you click, about 13 seconds |
| 9. Files for production | Click **Get production files** | 3DM, DXF and SVG. No AI |
| 10. Download a preview | Pick the sketch or a metal preview | PNG with a see-through background. No AI |

**Cost per design:** one AI call for the sketch, plus one for each product
photo you make. Everything else (choosing shapes and metals, adjusting,
previewing and downloading files) is free and instant, and can never trigger
an AI call. The sketch and your choices survive a page reload; the original
photo doesn't.

## Pendant types

**Cut to shape.** These are the catalogue's Face, Half Size, Couple, Family
and Pet pendants. The metal is cut along the outline of the people in the
drawing, a small even distance outside the ink, with a ring at the top for
hanging. This matches the client's own production files.

- The cut line is an exact offset of the drawing: every point sits the same
  distance from the ink, so it follows hair, ears and shoulders closely.
- The ring sits at the top centre and is joined to the outline on both sides,
  with rounded joins, so it's a solid part of the piece.
- The outline is traced from the **sketch**, never from the photo. Gemini
  reframes people when it draws them, so an outline taken from the photo
  wouldn't match the drawing being cut.

**Shaped pendant.** The drawing is engraved on a round, oval, heart, bar, tag
or octagonal pendant. Heart and round can also have a red or blue enamel rim
(the catalogue's "Heart with Color" and "Round with Color").

## What you get

| Output | Format | How it's made | Use it for |
|---|---|---|---|
| Sketch | PNG, see-through background | Gemini, then cleaned up | Reference artwork |
| Product photo | PNG or JPEG (whichever Gemini returns; the file name matches) | Gemini, from a flat drawing of the exact design | Your online store |
| Production files | **3DM**, **DXF**, SVG | Traced to vectors, no AI | Rhino and the laser cutter |
| Cut layout | PNG, white background | Drawn in the browser from the same shapes as the files | Checking the cut line and ring before production |
| Preview image | PNG, see-through background | Drawn in the browser | Sharing quickly |

The production files have two layers, measured in millimetres, 25 mm wide by
default. You can resize them in your software.

- **CUT** (red): where the metal is cut. For Cut to shape, that's the outline
  including the ring, plus the ring's hole.
- **ENGRAVE** (black): the drawing, traced to closed curves.

They're flat 2D curves with no depth. Extruding and finishing happen in
Rhino. The DXF and 3DM contain exactly the same shapes.

Always look over each product photo before posting it. Gemini is told not to
change the engraving or add text or hallmarks, but it's still an AI image.

## Deployment

**Live:** https://true-b.vercel.app (Vercel project `true-beauty`)

- **Automatic deploys:** the Vercel project is connected to
  [leroypinto1977/True_Beauty](https://github.com/leroypinto1977/True_Beauty).
  Every push to `main` goes live. Other branches get a preview link, which
  needs a Vercel login to open.
- **Environment variables** (Vercel, then Project, Settings, Environment
  Variables): only `GEMINI_API_KEY` is set, for Production and Preview, marked
  Sensitive. `REMOVE_BG_API_KEY` is deliberately **not** set on Vercel. The
  only route that uses it isn't used by the app but can still be reached from
  outside, so setting the key would let anyone spend your remove.bg credits.
  After changing a variable, redeploy for it to take effect.
- **Access:** the live site is public, and every sketch and product photo is a
  paid Gemini call. Add a login before sharing the link widely.
- **Deploy by hand** (without pushing): `npx vercel@latest deploy --prod`.
- **Cloudflare Containers:** `Dockerfile`, `wrangler.jsonc` and
  `cloudflare/worker.ts` are ready for running the app on Cloudflare at
  pendants.goatassets.com. That needs the Workers Paid plan and Docker on your
  computer. It hasn't been deployed yet.

## Settings

`.env.local` is read on the server only. Never start these names with
`NEXT_PUBLIC_`.

| Variable | Needed? | What it's for |
|---|---|---|
| `GEMINI_API_KEY` | Yes | Sketches and product photos |
| `REMOVE_BG_API_KEY` | No | Only for an unused feature (see below). Keep it local, not on Vercel |
| `DIECUT_URL`, `DIECUT_TOKEN` | No | Not used by the app (see below) |

Values you might want to tune:

| What | Where |
|---|---|
| Cut margin (2.5% of the sketch) and ring size (14% of the piece's width) for Cut to shape | `lib/edge-cut-contour.ts` |
| Default width of the production files (25 mm) | `lib/laser-export.ts` |
| Sketch style and the framing for each pendant style | `lib/gemini.ts` |
| Product photo instructions | `lib/mockup.ts` |
| Shapes, metals and rim colours | `lib/pendant-shapes.ts`, `lib/materials.ts` |
| Allowed photo types and size limit | `lib/validation.ts` |

## How it works

```
Browser                                   Server                               Google Gemini
───────                                   ──────                               ─────────────
Cropped photo + style ──────────────────▶ POST /api/generate-image
                                            check bytes → lib/gemini.ts    ──▶ photo → sketch
                                            lib/image-processing.ts        ◀──
◀── sketch (data URL) ────────────────────  (trim, see-through background)

lib/edge-cut-contour.ts works out the cut line and ring from the sketch
components/PendantPreview.tsx and CutLayoutPreview.tsx draw the previews

Make product photo ─────────────────────▶ POST /api/render-mockup
                                            lib/mockup.ts: flat drawing    ──▶ drawing → photo
◀── product photo ────────────────────────                                ◀──

Get production files ───────────────────▶ POST /api/export-laser
                                            lib/laser-export.ts (sharp + potrace)
◀── SVG + DXF + 3DM ──────────────────────  lib/dxf-writer.ts, lib/rhino-export.ts
```

All the shape maths lives in `lib/pendant-geometry.ts`. The previews, the cut
layout, the product photo and the production files all take their outline and
artwork position from there, so they always show the same pendant.

API keys are only read on the server and never reach the browser. Nothing is
stored on the server: photos, sketches and files exist only in the browser and
in the request that made them. Every error message is one plain sentence; the
technical details go to the server log only.

## Project layout

```
app/
  page.tsx                          the whole page, steps 1 to 10
  api/generate-image/route.ts       photo → sketch (first AI call)
  api/render-mockup/route.ts        design → product photo (second AI call)
  api/export-laser/route.ts         design → SVG, DXF and 3DM
  api/edge-cut/remove-background/   unused remove.bg route
components/
  PhotoCropper.tsx                  the crop box in step 1
  PendantPreview.tsx                draws the pendant previews and preview PNGs
  CutLayoutPreview.tsx              the cut layout view and its download
  MockupPanel.tsx                   step 8
  ExportPanel.tsx                   step 9
  DownloadPanel.tsx                 step 10
  …Picker.tsx, PendantControls.tsx  the choices and adjustment sliders
lib/
  gemini.ts                         Gemini client, instructions, error messages
  image-processing.ts               trims the sketch and clears its background
  photo-crop.ts                     crops the photo in the browser before sending
  edge-cut-contour.ts               cut line and ring for Cut to shape
  distance-transform.ts             exact offset maths behind the cut line
  silhouette-geometry.ts            filling and tracing outlines
  pendant-geometry.ts               shared shape and placement maths
  pendant-shapes.ts, materials.ts,
  pendant-categories.ts             the catalogue
  mockup.ts                         product photo drawing and instructions
  laser-export.ts                   tracing and building the SVG and DXF
  dxf-writer.ts, rhino-export.ts    DXF and 3DM writers
  svg-path-flatten.ts               turns curves into lines for DXF and 3DM
  design-request.ts                 checks requests for the two design routes
  pendant-storage.ts                keeps your work across a page reload
  validation.ts                     photo type and size checks
```

## Known limitations

- **No tests yet.** The geometry code is pure functions and would be the best
  place to start.
- **DXF version:** the file header says R12 but uses `LWPOLYLINE`, which came
  in with R13. Most software opens it fine, but a strict R12-only reader might
  not. Open the first files in the client's own laser software to be sure.
- **Unused code:** `lib/remove-bg.ts`, `lib/remove-bg-contour.ts` and their
  route work but aren't connected, because the remove.bg result arrived late
  and made the outline change on screen after a few seconds, which the client
  didn't want. `lib/diecut-service.ts` expects a Python service that isn't in
  this repo, and nothing uses it.
- **Limits:** photos can be up to 8 MB, and the model is fixed to
  `gemini-3.1-flash-image` in `lib/gemini.ts`.
