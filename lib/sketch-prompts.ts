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
import type { MarkedFace } from './face-marks';

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
3. Correct the photograph like a printer preparing it, not like a retoucher improving it: even out the exposure, correct the colour and white balance, and lift the shadows on the faces so the features in them can be SEEN. Those are tonal corrections to a photograph and nothing more. Do not sharpen, redraw, re-render or repaint a face, an eye, a lip or an eyebrow. If a feature is soft in this photograph it stays soft: a soft real eye is worth more here than a crisp invented one, because whatever you put in its place is what will be engraved into the metal.
4. OPEN UP THE DARK AREAS. Nothing in the picture may stay crushed to black: a navy blouse, a dark saree, a black jacket, a shadowed sleeve and dark hair must all show what they are made of — the weave, the folds, the embroidery, the print, the individual strands. Lift those shadows until that texture is plainly visible, while keeping the colours natural, and raise the micro-contrast on the fine things a garment carries (embroidery, lace, jewellery, chains, fabric pattern) so each is separate rather than a smudge. This is about revealing what the photograph already recorded in the dark, NOT about adding detail: it applies to cloth, hair and jewellery, and it never becomes a licence to sharpen or rebuild a face. This picture is about to be traced line by line, and a detail that was never in the photograph is a detail that will be engraved as a lie.
5. Do NOT change anyone's face, expression, pose, head angle or tilt, gaze direction, proportions, hairstyle, skin marks or clothing. Do not beautify, smooth skin, slim, reshape or restyle. Do not move, resize or re-crop what you keep; it must stay exactly where it is in the frame.
6. NEVER re-pose anyone. A head photographed at an angle stays at that angle: do not turn a face towards the camera, do not straighten a tilted head, do not re-render the head from another viewpoint. If you cannot retouch a part without redrawing it, leave that part exactly as it is.
7. Never remove or hide a part of a person you are keeping — an arm, a hand, a finger, an ear, a piece of jewellery, or anything they are wearing, holding or carrying. Where you take the background away, leave plain white in its place: never paint clothing, skin, fabric or pattern over the gap to tidy it up.
8. IF THIS IS A SCREENSHOT OF A PHONE SCREEN — the photo is somebody's wallpaper and the phone's interface is sitting on top of it — every piece of that interface goes: the status bar with its clock, signal bars, wifi and battery, the search bar, the app icons and their badges, folder tiles, widgets, notifications, the dock along the bottom and the navigation buttons under it. None of it is part of the photograph. Where a piece of interface was lying over a person, rebuild the small patch it covered from the skin, hair or clothing around it, so nothing of them is left with a rectangle punched through it. That is the one place you may fill a gap: over a person the interface hid, never over background you have removed.
9. Do not draw, sketch, cartoonise or add anything. No text, no watermark.

Output only the edited photograph.`;
}

/** Added to the enhance prompt when the first attempt left objects in the photo. */
export const ENHANCE_RETRY_NOTE = `IMPORTANT: a previous attempt at this edit kept objects that are not part of the subject, such as a car door, window frame or furniture along the bottom of the photo. Remove every such object completely: everything that is not the subject must be pure white, right down to the bottom edge.`;

const FINISH_STYLE = (marksExpected: boolean): string => `STYLE: a detailed pen-and-ink portrait in the Comica line-art style — a jeweller's engraving template. Hand-drawn strokes rather than smooth vector curves, but fine and controlled throughout: rich in detail, light in ink.
- Pure black ink on pure white only. No colour at all${marksExpected ? ' (a red bindi becomes solid black)' : ' (a red saree becomes black lines on white)'}, no grey, no gradients, no stippling dots, no halftone, no pencil texture.
- LINE WEIGHT, and this matters as much as the detail: draw with a fine, even pen. Every line stays thin and crisp, and the outer contours of heads, faces, shoulders and clothing are only a little heavier than the lines inside them: a clean outline, never a thick slab of ink.
- NO SOLID BLACK AREAS. Every dark area, however dark it is in the photo, is built from separate thin strokes with white showing between them, so that each stroke can still be followed one by one. A shape that has been filled in solid, or strokes packed so tightly that they merge into a black blob, is wrong: draw fewer, cleaner strokes there instead. The only solid marks in the whole artwork are tiny ones: pupils and nostrils${marksExpected ? ', and the bindi described below' : ''}.
- DARK GLASSES ARE DARK, and they are the one real exception to the rule above. If a person in image 1 is wearing sunglasses, fill each lens in dark so that it reads as a dark lens at a glance, leaving one clean white highlight streak across it where the light catches, and draw the frame and the arms as firm lines around it. Behind a dark lens there is nothing to see: do not draw the eyes, the lashes or the eyebrow through it, because eyes showing through sunglasses look like a mistake in the metal. Both lenses are equally dark. Two lenses are a small area, unlike a garment, so this costs the laser very little and the piece needs it. Clear spectacles are the opposite case: only the frame, the arms and a small highlight, with the eyes drawn normally through the glass.
- Hair: as dark as the hair is in the photo, but always TEXTURED and always readable: built from many fine strands drawn one by one, with white gaps between them running through the whole mass, scratchy flyaways around the outside, and white highlight strands where light hits. Never a flat solid black fill, never a merged black mass, and never outlined white shapes.
- Beards and moustaches, ONLY on a face that visibly has one in image 1: fine short strokes following the growth direction, with white gaps between the strokes everywhere so the texture of the hair stays visible even in the darkest part, and a scratchy edge. Never a flat solid black shape.
- On every face WITHOUT facial hair in image 1 — a woman, a child, a clean-shaven man — the chin, the jaw, the upper lip and the area under the lower lip are left completely white and EMPTY. Not one short stroke, not one stipple, not one patch of hatching anywhere around the mouth or on the chin: on a woman's face those strokes read as stubble and ruin the piece. Draw only the outline of the lips, the crease between them and the line of the jaw.
- SKIN CARRIES NO SHADING ANYWHERE — a face, a neck, an arm, a hand. No rows of parallel strokes laid over a finger or a forearm to darken it. Real creases are drawn as single lines: the knuckles, the joints of a finger, the lines across a palm or a wrist, the fold inside an elbow.
- FINGERNAILS ARE NEVER FILLED IN SOLID, whatever colour the polish is. Draw the shape of the nail with a clean outline and leave it white, the same way a dark garment is drawn. A nail blacked in reads as a hole in the metal and costs the laser dearly.
- SOMETHING OUT OF FOCUS IN THE PHOTOGRAPH IS DRAWN SIMPLY: its outline and the few forms you can actually make out, nothing more. A blurred hand close to the lens has no visible skin texture, so it gets none — inventing detail there is guessing, and it draws the eye away from the faces, which are the point of the piece.
- FACES CARRY NO SHADING, BUT THEY ARE FULLY DRAWN. These two are different things and the difference is the whole style. SHADING is tone — hatching, strokes laid side by side to darken an area — and there is none of it on skin: no hatching on a cheek or a forehead, no strokes down the neck, no shaded patch beside the nose. DRAWING is a line where one form really ends and another begins, and every one of those is drawn, firmly: the edge of the nose down one side and the curve of its tip, both nostril wings and the two nostril openings, the line under the tip, the dip of the philtrum, the full shape of both lips and the crease beneath the lower one, the curve of the cheek where it meets the mouth, the outer line of the cheek and the jaw, the chin's own curve, the fold of the upper eyelid, the line under the eye, the ear's inner folds. A face with the shading left off is right; a face with the features left off is a blank oval, and that is the mistake to avoid. On a baby or a small child these lines are soft and few, but they are there: draw the round of the cheeks, the little chin, the shape of the nose.
${marksExpected ? `- A BINDI OR POTTU IS DRAWN ONLY ON THE PEOPLE NAMED ABOVE as wearing one. Draw it as a small solid mark in the same place and size image 1 shows it. Every other forehead in this picture stays completely blank, and so does every hair parting. These marks say something about a person's religion and whether she is married, and putting one on someone who does not wear it gives offence.` : `- NOBODY IN THIS PICTURE WEARS A BINDI, A POTTU, A TILAK OR SINDOOR, and every forehead was checked one at a time, close up, before you were asked to draw. So there is no such mark to find and none to draw: every forehead stays blank white and every hair parting stays plain. Do not put a dot, a mark or a line on any forehead — not because you cannot see one, but because there is none there. A mark added here says something untrue about a real person's religion and marriage, and gives offence.`}
- A SMILE HAS TO READ AS A SMILE. When someone is smiling in image 1, draw what the smile actually does to the face: the mouth curving up and its corners pulled back and deepened, the fold that runs from beside the nose down past the corner of the mouth, the cheek lifted into a fuller round with its own curved edge, the lower lids pushed up a little and the crease at the outer corner of the eye if the photo has one. If the teeth show, keep them simple: the shape of the row as a whole and the line where the upper lip crosses it, with at most a hint of the join between the two front teeth. Do not outline every tooth, do not darken the gum line and do not lay strokes between the teeth — a mouth drawn tooth by tooth stops looking like this person's smile. A mouth drawn as a flat closed line on a smiling face is wrong, and so is a cheek left as empty paper when the smile has raised it.
- The CHEEKS: where image 1 shows the cheek's roundness turning away towards the ear or the jaw, or a fold beside the mouth, draw it — one clean line each, never a patch of shading. Where the photograph shows a smooth cheek with no edge in it, the cheek stays white. A pair of curved lines added to a face that has none of its own is an invention, and it changes who the person is.
- Never age anyone. The lines above are the ones the photograph actually shows; do not add wrinkles, eye bags or slack skin on top of them, and a smooth young face stays smooth. Only draw a mole if it is clearly visible in image 1; never add dots or marks that are not there. Do NOT draw acne, pores or skin blemishes.
- Clothing: outline, collar, buttons, and MANY folds. Crinkled or creased fabric gets lots of short fold and crinkle strokes that follow the fabric, so it looks textured, not empty. If the fabric has a pattern (stripes, checks, a print, embroidery), draw that pattern across the whole garment, following the folds. Crinkles and creases are not a pattern: they are drawn as fold strokes, never as stripes or checks.
- NEVER cover a garment in a repeating fine texture — dots, mesh, crosshatch, weave, tiny checks, scribble shading. If a fabric's own print is that fine (a shirt of tiny dots, a woven texture), the garment is drawn PLAIN: only its folds, seams, collar, cuffs, buttons and pocket. Hint at the print in one small area at most, and leave the rest of the cloth empty white. A plain shirt drawn with its folds is right; a shirt filled edge to edge with thousands of little marks is wrong, and each of those marks is a separate cut for the laser.
- DARK CLOTHING IS NEVER FILLED IN BLACK, no matter how dark it is in the photo. A navy blouse, a black jacket, a dark saree border: the fabric itself stays white, and you draw what is on it — its folds, its weave, its embroidery, its border pattern — as lines, exactly as a jeweller's engraving template does. Deep creases may get a few close parallel strokes, nothing more. This is not a style choice: a filled area has to be burned away in full by the laser, which costs far more than following lines.
- Jewellery and flowers traced as they are: every bead of a necklace, every link of a chain, the stones of an earring, each petal, drawn separately with clean outlines.
- Background: plain white. Anything that is white in image 1 stays white.
- THE ARTWORK IS NOT A PICTURE OF A PENDANT. Draw the people and nothing else: no frame, no border, no circle or oval around them, no beaded rim, no chain, no bail, no hanging loop, no cord, no backing plate, no drop shadow. The metal, the shape and the hanging loop are cut and fitted afterwards by the workshop, from this drawing. Seen once in three runs of the same photograph: the whole portrait drawn inside a round beaded frame with a chain over the top, which makes the file useless.`;

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

const FINISH_PROMPT_BODY = (marksExpected: boolean): string => `You are given two images of the same people. Image 1 is the photograph. Image 2 is a rough automatic ink trace of that exact photograph; its lines and dark areas are in the correct positions but they are blotchy and broken. Small isolated specks, dots and speckled skin texture in image 2 are noise from the automatic trace: ignore them, keep skin clean, and never draw them as pores, moles, dots or marks. The one exception is a bindi or pottu between the eyebrows, which is a real mark, not a speck.

If the body has been cut away and only a head is left, this is a HEAD-ONLY portrait: draw the hair, the face, the ears and the beard, and NOTHING below the chin or the beard. No neck, no throat, no shoulders, no collar, no chain: the artwork simply ends where the chin or the beard ends, on white. On the turned side the outline of the face runs from the beard straight up into the ear, with no line hanging down below the ear. Do not continue the neck downwards to complete the figure, even if a little of it shows in image 1. Any scrap of clothing or skin still showing beside or below the beard is left over from that removal, not part of the portrait, and you leave it out completely.

Produce the finished ink artwork for laser engraving on a metal pendant: redraw image 2, using image 1 to understand what each line and dark area is. Keep every line and every dark area in the SAME position as image 2 and the same overall composition and crop. Image 2 shows WHERE the ink goes, not how it is drawn: its solid blotches are a defect of the automatic trace, and each one becomes a patch of separate strokes with white between them. DO NOT SIMPLIFY and DO NOT DROP DETAIL, but never fill an area in solid.

This artwork is cut into metal with a laser, one stroke at a time, so a stroke that cannot be followed by eye cannot be cut either: thin, separate, evenly weighted strokes everywhere.

DETAIL (the artwork is judged on this, and it is drawn with lines, not shading — see FACES CARRY NO SHADING below).

EVERYTHING IN THIS LIST IS SOMETHING TO LOOK FOR IN IMAGE 1, NOT SOMETHING TO PUT ON A FACE. Find it in the photograph first, then draw the shape the photograph shows. Where the photograph does not show it — the light is flat, the face is small, the feature is soft — it does not go into the drawing, and the paper is left white instead. A face assembled from parts you know a face has will come out looking like a stranger with this person's hairstyle, and that is the single worst thing this drawing can do. This is a portrait of one particular person, judged by whether their own family recognises them.

Image 2 is your guide to where the real edges are. It was made from the photograph by machine, with no idea of what a face is, so it has no opinions to add: where it shows nothing, there was nothing to see.
- Hair: dense and dark as described in the style, with individual strand texture visible along the edges, the parting and the highlights. Keep the real shape of curls, waves and messy tufts.
- Eyes, the part everyone looks at first, and the part that most often comes back looking false. Draw THIS PERSON'S eyes, at the size, shape, angle and openness image 1 shows them, however ordinary or asymmetric that is: the upper lid and lash line, the crease above the eye if this face has a visible one, the lashes as the photo shows them, the iris with its pupil, the lower lid line, the inner corner, and the under-eye line where the photo shows one. A catchlight goes in only where the photograph has one. Do not enlarge or open the eyes, do not lift the outer corners, do not add a crease or a lash line that is not there, and do not give a small or soft eye a full round iris it never had — a large, bright, perfectly drawn eye on a face that does not have one is the exact thing that makes these portraits look fake. THE TWO EYES GET THE SAME CARE: neither is left as a bare almond outline while the other is finished. On a head turned to one side the far eye is narrower and partly hidden, and it is drawn that way, not straightened to match.
- Eyebrows: dark, built from short hair strokes in the direction they grow.
- Nose: its real shape, not a pair of hooks. The line down the bridge where the photo shows one, the ball of the tip, BOTH nostril wings, the two nostril openings as small dark marks, and the line under the tip. A woman's or a child's nose is finer than a man's, but it gets the same parts.
- Lips, drawn with a LIGHT HAND — this is the one place where more detail makes the drawing worse: the dip of the upper lip and its two peaks, the line between the lips carried out to both corners, the edge of the lower lip, and the shadow line beneath it if the photo shows one. That is all of it. The lips themselves are never darkened, filled or shaded, whatever colour the lipstick is, and they get no vertical creases, no texture strokes and no doubled outlines. An over-drawn mouth is the fastest way to make a real person look like someone else.
- Face: the chin, the jaw and the round of the cheeks as clean outlines on white skin, with no shading filled in behind them. Every one of those lines is a line the photograph shows: this person's own jaw, their own chin, the edge their own cheek makes. Someone should be able to see the shape of THIS person's face from the drawing alone — which means copying it, not completing it.
- Ears: the inner folds, with a couple of strokes in the deepest part only.
- Arms and hands: draw EVERY arm, hand and finger that is visible in image 1, with the fingernails, knuckles and the creases of the fingers. A hand resting on a shoulder, an arm around a back, a hand holding another hand: these are the point of the picture and must never be left out, merged into the clothing behind them or hidden under a dark area.
- Jewellery: necklaces, chains, earrings, bangles, a watch, a maang tikka, drawn bead by bead and link by link as image 1 shows them.
- Anything held or worn: a handbag with its handles and clasp, a clutch, a bag strap running over a shoulder, glasses, a garland, a bouquet, a shawl over an arm. These are part of the picture and often the point of it. Draw every one of them as image 1 shows it, and never let the clothing behind one close over its place.
- Clothing: every fold, crinkle, seam, collar edge and button.

NEVER INVENT ANYTHING, AND NOTHING ON A FACE IS DRAWN FROM MEMORY. Draw only what image 1 actually shows. No pattern, embroidery, weave, print, jewellery, buttons, straps or folds that are not in the photograph, and nothing added to fill an area you are unsure about — an area drawn plain is right, an area filled with something made up is not. If a person is holding or wearing something, that is what goes there: never replace it with fabric or pattern of your own.

NO STRAY LINES. Every line you draw has to be something real in image 1: an edge, a feature, a fold, a strand. Do not double an outline that is already there, do not run a line off into empty white, do not leave a stroke hanging in the air with nothing at either end, and do not sketch in a line that has no counterpart in the photo. Where a line ends, it ends cleanly on another line or on the white.

${FINISH_FAITHFUL}

${FINISH_STYLE(marksExpected)}

Output only the finished line art.`;

/**
 * The mirror of the above, and just as necessary: a baby whose pottu is
 * plainly there in the photo came back without it, because two other rules
 * delete it first — the one that calls small isolated dots in the trace
 * noise, and the one that keeps foreheads empty. Neither knows what a bindi
 * is, so the fact has to arrive with authority over them.
 */
function foreheadMarksByPerson(faces: MarkedFace[]): string {
  const wearing = faces.filter((face) => face.wears);
  const bare = faces.filter((face) => !face.wears);
  const lines = [
    'IMPORTANT, AND CHECKED AGAINST THE PHOTOGRAPH BEFOREHAND, ONE FOREHEAD AT A TIME. Each person below was looked at on their own, close up. Go through them one by one:',
  ];
  for (const face of wearing) {
    lines.push(
      `- ${face.where.toUpperCase()} IS WEARING a bindi or pottu. Find it in image 1 and draw it on that face, as a small solid mark in the same place and the same size. It is not noise, not a speck and not a blemish, and this comes above every rule below about ignoring small dots or keeping a forehead empty.`,
    );
  }
  for (const face of bare) {
    lines.push(`- ${face.where.toUpperCase()} is NOT wearing one. That forehead and that hair parting stay completely blank.`);
  }
  if (wearing.length > 1) {
    lines.push(
      `All ${wearing.length} of the people named as wearing one get their mark. Drawing it on the first of them and forgetting the rest is the mistake this list exists to stop.`,
    );
  }
  lines.push('Leaving out a mark that is there is exactly as wrong as adding one that is not: both say something untrue about that person.');
  return lines.join('\n');
}

/**
 * Asked for whenever there is a woman or a girl in the photograph. The
 * client's judgement, from a run of real orders: the men come out well and
 * the women come out short — the cheeks and the smile in particular. A man's
 * face carries beard, stubble and heavier brows that give the drawing
 * something to hold on to; a woman's face is mostly smooth skin, and smooth
 * skin under a no-shading rule can end up as empty paper.
 */
const WOMENS_FACES = `THE WOMEN'S FACES IN THIS PICTURE NEED THE MOST LOOKING OF ANYTHING HERE. A man's face has a beard, stubble and heavy brows to describe it; a woman's is mostly smooth skin, and smooth skin is where this drawing tends to go empty — or, worse, where it gets filled in with a face out of your head instead of hers. The answer to both is the same: go back to image 1 and look harder at each of these, then draw exactly the shape it shows, as clean lines and never as shading. Where the photograph truly shows nothing, that part stays white; an empty patch is a smaller mistake than a pretty line that belongs to someone else.
- The cheeks: the curve where the roundness of the cheek turns away towards the ear, the fold that runs beside the mouth, and the fuller round a smile lifts them into.
- The smile: the exact curve of the mouth, its corners pulled back and deepened, the row of teeth kept simple if they show, the lower lids pushed up by it. The work here is the CURVE of the smile and what it does to the cheeks and the eyes, not detail inside the mouth.
- The mouth closed or open, its real shape: the two peaks of the upper lip, the dip between them, the fullness of the lower lip and the line beneath it — clean lines only, with the lips left white and never darkened for lipstick.
- The eyes exactly as they sit in image 1 — their size, their shape, how open they are: the lid crease if this face has one, the lashes as the photo shows them, the iris with its pupil, the line under the eye. Copy her eyes; do not improve them.
- The eyebrows stroke by stroke, following the way they grow and thinning towards the outer end.
- The nose, which on a softer face is easy to lose: the line of one side, the tip, both nostril wings, the openings.
- The hairline, the ear, the jaw and the chin, each as a real edge.
Judge the finished face against image 1, twice over: if you could not tell from your drawing what this woman's smile and cheeks look like, it is not finished — and if the drawing shows a smile or a cheek or an eye that is not hers, it is worse than unfinished. Her own family has to recognise her in it.`;

export interface FinishOptions {
  /** Each person whose forehead was settled, left to right, or null to say nothing at all. */
  faces: MarkedFace[] | null;
  /** True when every person in the photo was settled — see FaceMarks. */
  complete: boolean;
  /** True when the photo has a woman or a girl in it. */
  anyWomen: boolean;
}

export function buildFinishPrompt(options: FinishOptions): string {
  const faces = options.faces ?? [];
  // Whether a bindi belongs anywhere in this picture is decided once and the
  // whole prompt is built around the answer. Appending a denial to a style
  // that still lists "a bindi" among its normal marks was not enough: on the
  // same photograph of two women who wear none, one run left both foreheads
  // blank and the next drew a bindi on one of them. A rule the prompt
  // contradicts elsewhere is a rule the model gets to choose about.
  const marksExpected = faces.some((face) => face.wears);
  const parts = [FINISH_PROMPT_BODY(marksExpected)];
  if (faces.length > 0) {
    // Nobody wearing one at all is stated as a flat fact rather than as a
    // list of denials: told only "draw one if it is there", the model drew
    // one anyway on two women who wear none. That flat fact is only
    // available when every face was settled, though — otherwise the denial
    // is made person by person, and the unchecked faces are left unsaid.
    parts.push(!marksExpected && options.complete ? NO_FOREHEAD_MARKS : foreheadMarksByPerson(faces));
  }
  if (options.anyWomen) parts.push(WOMENS_FACES);
  return parts.join('\n\n');
}

