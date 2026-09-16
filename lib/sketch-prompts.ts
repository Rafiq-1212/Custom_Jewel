/**
 * Instructions for the two AI steps of the sketch pipeline
 * (lib/sketch-pipeline.ts). Kept apart from the Gemini client so the wording
 * can be tuned without touching request code.
 *
 * The pipeline copies how the client makes their own artwork: enhance the
 * photo, then turn that exact photo into comic-style ink (they use the Comica
 * app). An earlier single-step "draw this person as line art" prompt let the
 * model redraw people from scratch, which drifted the likeness, invented
 * details (a flower from cheek marks) and smoothed everything into a vector
 * cartoon. Here the model first only EDITS the photo, then only FINISHES a
 * trace whose line positions were already fixed by a filter on that photo.
 */

import type { CategoryId } from './pendant-categories';

/**
 * What to keep in the photo for each pendant style. Applied during the
 * enhance step by painting everything else white, so the rest of the
 * pipeline never sees it.
 *
 * Face Pendant asks for no framing at all: cutting the body off in the
 * prompt made the model re-render the head (a man photographed at
 * three-quarters came back facing the camera, twice out of two runs), so
 * that crop is done on pixels afterwards instead — `cropPhotoToHead` in
 * lib/image-processing.ts.
 */
const KEEP_BY_CATEGORY: Partial<Record<CategoryId, string>> = {
  face: `Keep the person exactly as photographed, including their neck, shoulders and clothing. If anyone else is in the photo, paint them out completely. Do not crop, zoom or re-frame: the pendant's framing is decided later, from the finished picture.`,
  'half-size': `Keep the person from the top of the head down to the chest. If the photo shows them below the chest (waist, hips, legs), paint that part white; if the photo already ends at the chest or shoulders, keep everything, including their shoulders and clothing, right to the bottom edge.`,
  couple: `Keep both people, from the tops of their heads down to the chest. If the photo shows them below the chest (waist, hips, legs), paint that part white; if the photo already ends at the chest or shoulders, keep everything, including their shoulders and clothing, right to the bottom edge. Keep every arm, hand and finger that belongs to them, including an arm resting on a shoulder, around a waist or across a chest. The one exception is a selfie arm, an arm that runs out of the frame towards the camera because it is holding the phone: paint that arm and hand white.`,
  family: `Keep every person in the group, from the tops of their heads down to the chest, including any baby or child being held. If the photo shows them below the chest (waist, hips, legs), paint that part white; if the photo already ends at the chest or shoulders, keep everything, including their shoulders and clothing, right to the bottom edge. Keep every arm, hand and finger that belongs to them, including an arm resting on a shoulder, around a waist or across a chest. The one exception is a selfie arm, an arm that runs out of the frame towards the camera because it is holding the phone: paint that arm and hand white.`,
  pet: `Keep ONLY the pet's head and shoulders. Paint any people, the rest of the body and everything else pure white.`,
};

const KEEP_DEFAULT = `Keep every person in the photo.`;

export function buildEnhancePrompt(category: CategoryId): string {
  const keep = KEEP_BY_CATEGORY[category] ?? KEEP_DEFAULT;
  return `Edit this photograph. This is a PHOTO EDIT, not an illustration: the result must still be a real photograph.

1. Remove the background completely and replace it with flat pure white (#FFFFFF). That includes walls, furniture, vehicles, car doors, windows, plants, sky and any other object that is not part of the people (or pet).
2. ${keep}
3. Enhance what remains like a professional retoucher: even out the exposure, correct the colour and white balance, lift the shadows on the faces, and bring out facial detail (eyes, eyebrows, lips, beard and hair texture) with crisp natural sharpening and good local contrast.
4. OPEN UP THE DARK AREAS, and raise the fine detail everywhere. Nothing in the picture may stay crushed to black: a navy blouse, a dark saree, a black jacket, a shadowed sleeve and dark hair must all show what they are made of — the weave, the folds, the embroidery, the print, the individual strands. Lift those shadows until that texture is plainly visible, while keeping the colours natural. At the same time raise the micro-contrast on fine things (embroidery, lace, jewellery, chains, fabric pattern, eyelashes, hair strands, stubble) so each one is separate and sharp rather than a smudge. This picture is about to be traced line by line: every detail that is not visible here is lost for good.
5. Do NOT change anyone's face, expression, pose, head angle or tilt, gaze direction, proportions, hairstyle, skin marks or clothing. Do not beautify, smooth skin, slim, reshape or restyle. Do not move, resize or re-crop what you keep; it must stay exactly where it is in the frame.
6. NEVER re-pose anyone. A head photographed at an angle stays at that angle: do not turn a face towards the camera, do not straighten a tilted head, do not re-render the head from another viewpoint. If you cannot retouch a part without redrawing it, leave that part exactly as it is.
7. Never remove or hide a part of a person you are keeping — an arm, a hand, a finger, an ear, a piece of jewellery.
8. Do not draw, sketch, cartoonise or add anything. No text, no watermark.

Output only the edited photograph.`;
}

/** Added to the enhance prompt when the first attempt left objects in the photo. */
export const ENHANCE_RETRY_NOTE = `IMPORTANT: a previous attempt at this edit kept objects that are not part of the subject, such as a car door, window frame or furniture along the bottom of the photo. Remove every such object completely: everything that is not the subject must be pure white, right down to the bottom edge.`;

const FINISH_STYLE = `STYLE: a detailed pen-and-ink portrait in the Comica line-art style — a jeweller's engraving template. Hand-drawn strokes rather than smooth vector curves, but fine and controlled throughout: rich in detail, light in ink.
- Pure black ink on pure white only. No colour at all (a red bindi becomes solid black), no grey, no gradients, no stippling dots, no halftone, no pencil texture.
- LINE WEIGHT, and this matters as much as the detail: draw with a fine, even pen. Every line stays thin and crisp, and the outer contours of heads, faces, shoulders and clothing are only a little heavier than the lines inside them: a clean outline, never a thick slab of ink.
- NO SOLID BLACK AREAS. Every dark area, however dark it is in the photo, is built from separate thin strokes with white showing between them, so that each stroke can still be followed one by one. A shape that has been filled in solid, or strokes packed so tightly that they merge into a black blob, is wrong: draw fewer, cleaner strokes there instead. The only solid marks in the whole artwork are tiny ones: pupils, nostrils, a bindi.
- Hair: as dark as the hair is in the photo, but always TEXTURED and always readable: built from many fine strands drawn one by one, with white gaps between them running through the whole mass, scratchy flyaways around the outside, and white highlight strands where light hits. Never a flat solid black fill, never a merged black mass, and never outlined white shapes.
- Beards and moustaches: fine short strokes following the growth direction, with white gaps between the strokes everywhere so the texture of the hair stays visible even in the darkest part, and a scratchy edge. Never a flat solid black shape.
- Faces: skin is white, but every shadow in the photo becomes hatching made of separate strokes (never a solid black patch): the shadow side of the nose, under the cheekbones, the jawline, under the chin and down the neck, the eye sockets and smile lines. A bindi becomes a small solid mark. Only draw a mole if it is clearly visible in image 1; never add dots or marks that are not there. Do NOT draw acne, pores or skin blemishes.
- Clothing: outline, collar, buttons, and MANY folds. Crinkled or creased fabric gets lots of short fold and crinkle strokes that follow the fabric, so it looks textured, not empty. If the fabric has a pattern (stripes, checks, a print, embroidery), draw that pattern across the whole garment, following the folds. Crinkles and creases are not a pattern: they are drawn as fold strokes, never as stripes or checks.
- NEVER cover a garment in a repeating fine texture — dots, mesh, crosshatch, weave, tiny checks, scribble shading. If a fabric's own print is that fine (a shirt of tiny dots, a woven texture), the garment is drawn PLAIN: only its folds, seams, collar, cuffs, buttons and pocket. Hint at the print in one small area at most, and leave the rest of the cloth empty white. A plain shirt drawn with its folds is right; a shirt filled edge to edge with thousands of little marks is wrong, and each of those marks is a separate cut for the laser.
- DARK CLOTHING IS NEVER FILLED IN BLACK, no matter how dark it is in the photo. A navy blouse, a black jacket, a dark saree border: the fabric itself stays white, and you draw what is on it — its folds, its weave, its embroidery, its border pattern — as lines, exactly as a jeweller's engraving template does. Deep creases may get a few close parallel strokes, nothing more. This is not a style choice: a filled area has to be burned away in full by the laser, which costs far more than following lines.
- Jewellery and flowers traced as they are: every bead of a necklace, every link of a chain, the stones of an earring, each petal, drawn separately with clean outlines.
- Background: plain white. Anything that is white in image 1 stays white. Do not draw any frame, border or shape around the people.`;

const FINISH_FAITHFUL = `FAITHFULNESS (most important):
- This is a TRACING, not a new drawing. Every contour must sit exactly where the corresponding edge is in the photo: same head angles, same gaze, same face shapes and proportions, same expression, same hairline, same clothing folds, same framing and crop.
- Never mirror or flip the image: every person faces exactly the same direction as in image 1 and image 2, and left stays left.
- Do not rotate, symmetrise, beautify, slim, age or restyle anyone. Do not add or remove anything.`;

export const FINISH_PROMPT = `You are given two images of the same people. Image 1 is the photograph. Image 2 is a rough automatic ink trace of that exact photograph; its lines and dark areas are in the correct positions but they are blotchy and broken. Small isolated specks, dots and speckled skin texture in image 2 are noise from the automatic trace: ignore them, keep skin clean, and never draw them as pores, moles, dots or marks.

Produce the finished ink artwork for laser engraving on a metal pendant: redraw image 2, using image 1 to understand what each line and dark area is. Keep every line and every dark area in the SAME position as image 2 and the same overall composition and crop. Image 2 shows WHERE the ink goes, not how it is drawn: its solid blotches are a defect of the automatic trace, and each one becomes a patch of separate strokes with white between them. DO NOT SIMPLIFY and DO NOT DROP DETAIL, but never fill an area in solid.

This artwork is cut into metal with a laser, one stroke at a time, so a stroke that cannot be followed by eye cannot be cut either: thin, separate, evenly weighted strokes everywhere.

DETAIL (the artwork is judged on this):
- Hair: dense and dark as described in the style, with individual strand texture visible along the edges, the parting and the highlights. Keep the real shape of curls, waves and messy tufts.
- Eyes: bold upper lid and lash line, the crease above the eye, eyelashes, the iris with a solid black pupil and a small white catchlight, lower lid, and the under-eye lines where the photo shows them.
- Eyebrows: dark, built from short hair strokes in the direction they grow.
- Face: the real contours of the nose (bridge, tip, nostrils), lips (upper lip shape, lower lip edge, corners), cheekbones, smile lines, chin and jaw, with hatching in every shadow.
- Ears: the inner folds, with shading inside.
- Arms and hands: draw EVERY arm, hand and finger that is visible in image 1, with the fingernails, knuckles and the creases of the fingers. A hand resting on a shoulder, an arm around a back, a hand holding another hand: these are the point of the picture and must never be left out, merged into the clothing behind them or hidden under a dark area.
- Jewellery: necklaces, chains, earrings, bangles, a watch, a maang tikka, drawn bead by bead and link by link as image 1 shows them.
- Clothing: every fold, crinkle, seam, collar edge and button.

${FINISH_FAITHFUL}

${FINISH_STYLE}

Output only the finished line art.`;
