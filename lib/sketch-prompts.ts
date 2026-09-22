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
  'full-size': `Keep the whole person, from the top of their head right down to their feet, and everything of them the photograph shows — their whole body, their arms and hands, their clothes and their shoes. Do not cut them off at the chest or the waist, and do not crop or re-frame: whatever the photograph shows of this person is kept.`,
  couple: `Keep both people, from the tops of their heads down to the chest. If the photo shows them below the chest (waist, hips, legs), paint that part white; if the photo already ends at the chest or shoulders, keep everything, including their shoulders and clothing, right to the bottom edge. Keep every arm, hand and finger that belongs to them, including an arm resting on a shoulder, around a waist or across a chest. A hand held up towards the camera — reaching out, pointing, waving, showing a ring — is part of the picture and is kept in full, however large it looms in the frame. The one exception is the arm that is actually TAKING the photograph: an arm running from the bottom corner out of frame, at the end of which the phone is being held. Paint that one arm white, and only when you can tell that is what it is.`,
  family: `Keep every person in the group, from the tops of their heads down to the chest, including any baby or child being held. If the photo shows them below the chest (waist, hips, legs), paint that part white; if the photo already ends at the chest or shoulders, keep everything, including their shoulders and clothing, right to the bottom edge. Keep every arm, hand and finger that belongs to them, including an arm resting on a shoulder, around a waist or across a chest. A hand held up towards the camera — reaching out, pointing, waving, showing a ring — is part of the picture and is kept in full, however large it looms in the frame. The one exception is the arm that is actually TAKING the photograph: an arm running from the bottom corner out of frame, at the end of which the phone is being held. Paint that one arm white, and only when you can tell that is what it is.`,
  pet: `Keep ONLY the pet's head and shoulders. Paint any people, the rest of the body and everything else pure white.`,
};

const KEEP_DEFAULT = `Keep every person in the photo.`;

export function buildEnhancePrompt(category: CategoryId): string {
  const keep = KEEP_BY_CATEGORY[category] ?? KEEP_DEFAULT;
  return `Edit this photograph. This is a PHOTO EDIT, not an illustration: the result must still be a real photograph.

1. Remove the background completely and replace it with flat pure white (#FFFFFF): walls, furniture, vehicles, car doors, windows, plants, sky, and anything else BEHIND or BESIDE the people (or pet). Anything a person is wearing, holding or carrying counts as part of them and STAYS exactly as it is: a handbag, a clutch, a purse, a bag strap across a shoulder, glasses, a watch, a phone, a bouquet, a garland, a walking stick, a baby. Do not tidy the picture by removing them. Furniture and equipment are the other way round: a chair, a sofa, a bed, a baby walker, a pram, a car seat, a high chair or a cot is background and goes, even where the person is sitting in it and touching it on all sides.
2. ${keep}
3. Enhance what remains like a professional retoucher: even out the exposure, correct the colour and white balance, lift the shadows on the faces, and bring out facial detail (eyes, eyebrows, lips, beard and hair texture) with crisp natural sharpening and good local contrast.
4. OPEN UP THE DARK AREAS, and raise the fine detail everywhere. Nothing in the picture may stay crushed to black: a navy blouse, a dark saree, a black jacket, a shadowed sleeve and dark hair must all show what they are made of — the weave, the folds, the embroidery, the print, the individual strands. Lift those shadows until that texture is plainly visible, while keeping the colours natural. At the same time raise the micro-contrast on fine things (embroidery, lace, jewellery, chains, fabric pattern, eyelashes, hair strands, stubble) so each one is separate and sharp rather than a smudge. This picture is about to be traced line by line: every detail that is not visible here is lost for good.
5. Do NOT change anyone's face, expression, pose, head angle or tilt, gaze direction, proportions, hairstyle, skin marks or clothing. Do not beautify, smooth skin, slim, reshape or restyle. Do not move, resize or re-crop what you keep; it must stay exactly where it is in the frame.
6. NEVER re-pose anyone. A head photographed at an angle stays at that angle: do not turn a face towards the camera, do not straighten a tilted head, do not re-render the head from another viewpoint. If you cannot retouch a part without redrawing it, leave that part exactly as it is.
7. Never remove or hide a part of a person you are keeping — an arm, a hand, a finger, an ear, a piece of jewellery, or anything they are wearing, holding or carrying. Where you take the background away, leave plain white in its place: never paint clothing, skin, fabric or pattern over the gap to tidy it up.
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
- Beards and moustaches, ONLY on a face that visibly has one in image 1: fine short strokes following the growth direction, with white gaps between the strokes everywhere so the texture of the hair stays visible even in the darkest part, and a scratchy edge. Never a flat solid black shape.
- On every face WITHOUT facial hair in image 1 — a woman, a child, a clean-shaven man — the chin, the jaw, the upper lip and the area under the lower lip are left completely white and EMPTY. Not one short stroke, not one stipple, not one patch of hatching anywhere around the mouth or on the chin: on a woman's face those strokes read as stubble and ruin the piece. Draw only the outline of the lips, the crease between them and the line of the jaw.
- FACES CARRY NO SHADING, BUT THEY ARE FULLY DRAWN. These two are different things and the difference is the whole style. SHADING is tone — hatching, strokes laid side by side to darken an area — and there is none of it on skin: no hatching on a cheek or a forehead, no strokes down the neck, no shaded patch beside the nose. DRAWING is a line where one form really ends and another begins, and every one of those is drawn, firmly: the edge of the nose down one side and the curve of its tip, both nostril wings and the two nostril openings, the line under the tip, the dip of the philtrum, the full shape of both lips and the crease beneath the lower one, the curve of the cheek where it meets the mouth, the outer line of the cheek and the jaw, the chin's own curve, the fold of the upper eyelid, the line under the eye, the ear's inner folds. A face with the shading left off is right; a face with the features left off is a blank oval, and that is the mistake to avoid. On a baby or a small child these lines are soft and few, but they are there: draw the round of the cheeks, the little chin, the shape of the nose.
- A BINDI OR POTTU IS DRAWN ONLY IF THAT PERSON IS ACTUALLY WEARING ONE in image 1. Look at each face separately: if you can clearly see the mark on her forehead, draw it as a small solid mark in the same place and size; if you cannot, her forehead stays completely blank. The same goes for sindoor in a parting, a tilak or a religious mark of any kind. Never add one, never copy one from another face in the picture, and never leave out one that is there. These marks say something about a person's religion and whether she is married, and putting one on someone who does not wear it gives offence.
- Never age anyone. Draw a wrinkle, a smile line or an under-eye line only where image 1 shows a clear crease; a smooth young face is drawn smooth. Only draw a mole if it is clearly visible in image 1; never add dots or marks that are not there. Do NOT draw acne, pores or skin blemishes.
- Clothing: outline, collar, buttons, and MANY folds. Crinkled or creased fabric gets lots of short fold and crinkle strokes that follow the fabric, so it looks textured, not empty. If the fabric has a pattern (stripes, checks, a print, embroidery), draw that pattern across the whole garment, following the folds. Crinkles and creases are not a pattern: they are drawn as fold strokes, never as stripes or checks.
- NEVER cover a garment in a repeating fine texture — dots, mesh, crosshatch, weave, tiny checks, scribble shading. If a fabric's own print is that fine (a shirt of tiny dots, a woven texture), the garment is drawn PLAIN: only its folds, seams, collar, cuffs, buttons and pocket. Hint at the print in one small area at most, and leave the rest of the cloth empty white. A plain shirt drawn with its folds is right; a shirt filled edge to edge with thousands of little marks is wrong, and each of those marks is a separate cut for the laser.
- DARK CLOTHING IS NEVER FILLED IN BLACK, no matter how dark it is in the photo. A navy blouse, a black jacket, a dark saree border: the fabric itself stays white, and you draw what is on it — its folds, its weave, its embroidery, its border pattern — as lines, exactly as a jeweller's engraving template does. Deep creases may get a few close parallel strokes, nothing more. This is not a style choice: a filled area has to be burned away in full by the laser, which costs far more than following lines.
- Jewellery and flowers traced as they are: every bead of a necklace, every link of a chain, the stones of an earring, each petal, drawn separately with clean outlines.
- Background: plain white. Anything that is white in image 1 stays white. Do not draw any frame, border or shape around the people.`;

const FINISH_FAITHFUL = `FAITHFULNESS (most important):
- This is a TRACING, not a new drawing. Every contour must sit exactly where the corresponding edge is in the photo: same head angles, same gaze, same face shapes and proportions, same expression, same hairline, same clothing folds, same framing and crop.
- Never mirror or flip the image: every person faces exactly the same direction as in image 1 and image 2, and left stays left.
- Do not rotate, symmetrise, beautify, slim, age or restyle anyone. Do not add or remove anything.`;

/**
 * Stated as fact, not as a rule to apply, when the photo has been checked
 * and nobody wears a mark (lib/face-marks.ts). Told only to draw one "if it
 * is there", the model drew one anyway on two women who wear none.
 */
const NO_FOREHEAD_MARKS = `IMPORTANT, AND CHECKED AGAINST THE PHOTOGRAPH BEFOREHAND: not one person in this picture is wearing a bindi, a pottu, a tilak or sindoor. Every forehead in your drawing stays completely blank and every hair parting stays plain. Do not put a dot, a mark or a line on any forehead for any reason.`;

const FINISH_PROMPT_BODY = `You are given two images of the same people. Image 1 is the photograph. Image 2 is a rough automatic ink trace of that exact photograph; its lines and dark areas are in the correct positions but they are blotchy and broken. Small isolated specks, dots and speckled skin texture in image 2 are noise from the automatic trace: ignore them, keep skin clean, and never draw them as pores, moles, dots or marks. The one exception is a bindi or pottu between the eyebrows, which is a real mark, not a speck.

If the body has been cut away and only a head is left, this is a HEAD-ONLY portrait: draw the hair, the face, the ears and the beard, and NOTHING below the chin or the beard. No neck, no throat, no shoulders, no collar, no chain: the artwork simply ends where the chin or the beard ends, on white. On the turned side the outline of the face runs from the beard straight up into the ear, with no line hanging down below the ear. Do not continue the neck downwards to complete the figure, even if a little of it shows in image 1. Any scrap of clothing or skin still showing beside or below the beard is left over from that removal, not part of the portrait, and you leave it out completely.

Produce the finished ink artwork for laser engraving on a metal pendant: redraw image 2, using image 1 to understand what each line and dark area is. Keep every line and every dark area in the SAME position as image 2 and the same overall composition and crop. Image 2 shows WHERE the ink goes, not how it is drawn: its solid blotches are a defect of the automatic trace, and each one becomes a patch of separate strokes with white between them. DO NOT SIMPLIFY and DO NOT DROP DETAIL, but never fill an area in solid.

This artwork is cut into metal with a laser, one stroke at a time, so a stroke that cannot be followed by eye cannot be cut either: thin, separate, evenly weighted strokes everywhere.

DETAIL (the artwork is judged on this, and it is drawn with lines, not shading — see FACES CARRY NO SHADING below):
- Hair: dense and dark as described in the style, with individual strand texture visible along the edges, the parting and the highlights. Keep the real shape of curls, waves and messy tufts.
- Eyes, the part everyone looks at first: bold upper lid and lash line, the crease above the eye, eyelashes, the iris drawn as a full circle with a solid black pupil inside it and a small white catchlight, the lower lid line, the inner corner, and the under-eye line where the photo shows one. THE TWO EYES MUST MATCH: same height on the face, same shape, same size and the same amount of detail in both. On a head turned to one side the far eye is narrower, but it is never higher, lower, simpler or emptier than the near one, and never left as a bare almond outline.
- Eyebrows: dark, built from short hair strokes in the direction they grow.
- Nose: its real shape, not a pair of hooks. The line down the bridge where the photo shows one, the ball of the tip, BOTH nostril wings, the two nostril openings as small dark marks, and the line under the tip. A woman's or a child's nose is finer than a man's, but it gets the same parts.
- Lips: the dip of the upper lip and its two peaks, the line between the lips carried right out to both corners, the lower lip's edge, and the shadow line under the lower lip if the photo shows one.
- Face: the chin, the jaw and the round of the cheeks as clean outlines on white skin, with no shading filled in behind them. The face must have its own structure — someone should be able to see the shape of this person's nose, mouth and cheeks from the drawing alone.
- Ears: the inner folds, with a couple of strokes in the deepest part only.
- Arms and hands: draw EVERY arm, hand and finger that is visible in image 1, with the fingernails, knuckles and the creases of the fingers. A hand resting on a shoulder, an arm around a back, a hand holding another hand: these are the point of the picture and must never be left out, merged into the clothing behind them or hidden under a dark area.
- Jewellery: necklaces, chains, earrings, bangles, a watch, a maang tikka, drawn bead by bead and link by link as image 1 shows them.
- Anything held or worn: a handbag with its handles and clasp, a clutch, a bag strap running over a shoulder, glasses, a garland, a bouquet, a shawl over an arm. These are part of the picture and often the point of it. Draw every one of them as image 1 shows it, and never let the clothing behind one close over its place.
- Clothing: every fold, crinkle, seam, collar edge and button.

NEVER INVENT ANYTHING. Draw only what image 1 actually shows. No pattern, embroidery, weave, print, jewellery, buttons, straps or folds that are not in the photograph, and nothing added to fill an area you are unsure about — an area drawn plain is right, an area filled with something made up is not. If a person is holding or wearing something, that is what goes there: never replace it with fabric or pattern of your own.

NO STRAY LINES. Every line you draw has to be something real in image 1: an edge, a feature, a fold, a strand. Do not double an outline that is already there, do not run a line off into empty white, do not leave a stroke hanging in the air with nothing at either end, and do not sketch in a line that has no counterpart in the photo. Where a line ends, it ends cleanly on another line or on the white.

${FINISH_FAITHFUL}

${FINISH_STYLE}

Output only the finished line art.`;

/**
 * The mirror of the above, and just as necessary: a baby whose pottu is
 * plainly there in the photo came back without it, because two other rules
 * delete it first — the one that calls small isolated dots in the trace
 * noise, and the one that keeps foreheads empty. Neither knows what a bindi
 * is, so the fact has to arrive with authority over them.
 */
function foreheadMarksPresent(count: number): string {
  const who = count === 1 ? 'ONE person in this picture is' : `${count} people in this picture are`;
  return `IMPORTANT, AND CHECKED AGAINST THE PHOTOGRAPH BEFOREHAND: ${who} wearing a bindi or pottu on the forehead. Find it in image 1 and draw it, as a small solid mark in the same place and the same size, on that person and on nobody else. It is not noise, not a speck and not a blemish, and this instruction comes above every rule below about ignoring small dots or keeping a forehead empty. Leaving it out is as wrong as adding one that is not there.`;
}

export interface FinishOptions {
  /** How many people the photo was found to have a forehead mark on, or null if it could not be settled. */
  foreheadMarks: number | null;
}

export function buildFinishPrompt(options: FinishOptions): string {
  if (options.foreheadMarks === null) return FINISH_PROMPT_BODY;
  const fact = options.foreheadMarks === 0 ? NO_FOREHEAD_MARKS : foreheadMarksPresent(options.foreheadMarks);
  return [FINISH_PROMPT_BODY, fact].join('\n\n');
}

