/**
 * Instructions for the one AI step of the sketch pipeline, the photo edit
 * (lib/sketch-pipeline.ts). Kept apart from the Gemini client so the wording
 * can be tuned without touching request code.
 *
 * The model only EDITS the photo — background out, colour and exposure
 * corrected, detail sharpened — and the artwork is then the ink filter on
 * that exact photo. The sharpening matters: with a tonal-only edit a pale eye
 * came back as a blank white shape in the ink, and with it both irises were
 * there. The rules against changing, re-posing or beautifying a face stay.
 * Earlier versions also had the model redraw the result as line art, which
 * drifted the likeness and invented clothing, marks and whole faces.
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
8. IF THIS IS A SCREENSHOT OF A PHONE SCREEN — the photo is somebody's wallpaper and the phone's interface is sitting on top of it — every piece of that interface goes: the status bar with its clock, signal bars, wifi and battery, the search bar, the app icons and their badges, folder tiles, widgets, notifications, the dock along the bottom and the navigation buttons under it. None of it is part of the photograph. Where a piece of interface was lying over a person, rebuild the small patch it covered from the skin, hair or clothing around it, so nothing of them is left with a rectangle punched through it. That is the one place you may fill a gap: over a person the interface hid, never over background you have removed.
9. Do not draw, sketch, cartoonise or add anything. No text, no watermark.

Output only the edited photograph.`;
}

/** Added to the enhance prompt when the first attempt left objects in the photo. */
export const ENHANCE_RETRY_NOTE = `IMPORTANT: a previous attempt at this edit kept objects that are not part of the subject, such as a car door, window frame or furniture along the bottom of the photo. Remove every such object completely: everything that is not the subject must be pure white, right down to the bottom edge.`;
