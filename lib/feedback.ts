/**
 * Feedback on what the tool made, and how a sketch's feedback becomes a
 * redraw.
 *
 * The team rates each result 👍 or 👎 and, for a 👎, ticks what was wrong.
 * Every tick on a SKETCH has a correction behind it: the same instruction,
 * worded as the drawing step needs it, that a redraw adds to its prompt
 * (lib/sketch-pipeline.ts). The ticks for a product photo and for the
 * production files are recorded only; nothing is redrawn from them.
 *
 * Both apps read these: the tool to show the choices, the admin panel
 * (which stores the labels with each row, so it never needs this file) to
 * count and list them.
 */

export type FeedbackStage = 'sketch' | 'product_photo' | 'production_files';
export type Person = 'all' | 'left' | 'middle' | 'right';

export interface Issue {
  key: string;
  label: string;
  /** For a sketch: what the drawing step is told on a redraw. */
  correction?: string;
}

export const ISSUES: Record<FeedbackStage, Issue[]> = {
  sketch: [
    {
      key: 'likeness',
      label: 'Face doesn\'t look like the person',
      correction:
        'The face did not look like the person. Follow the face in image 2 exactly: its shape, the eyes, nose and mouth, and the spaces between them. Change nothing to make it prettier or more regular.',
    },
    {
      key: 'eyes',
      label: 'Eyes or eyebrows wrong',
      correction:
        'The eyes or eyebrows were wrong. Draw them exactly as image 2 shows them: their shape, size, spacing, how open they are and where they look; the eyebrows at their real thickness, length and arch.',
    },
    {
      key: 'mouth',
      label: 'Mouth or expression wrong',
      correction:
        'The mouth or the expression was wrong. Draw the mouth exactly as image 2 shows it: open or closed, whether teeth show, the fullness of the lips and whether the corners turn up, down or stay level.',
    },
    {
      key: 'mark',
      label: 'Forehead mark (pottu) wrong',
      correction:
        'A forehead mark was wrong. Ink only the marks image 2 shows, each where it is and at the size it has there, measured against that person\'s eye: a dot smaller than the iris stays smaller than the iris. Add none, drop none, and never turn a dot into a ring or a bold spot: every dot, a pale one of sandal paste included, is a tiny solid dot.',
    },
    {
      key: 'mole',
      label: 'Mole or spot wrong',
      correction:
        'A mole or spot was wrong. Ink only the moles plainly visible in image 2, each at its real size, as a tiny dot; draw none anywhere else.',
    },
    {
      key: 'hair',
      label: 'Hair wrong',
      correction:
        'The hair was wrong. Draw it exactly as image 2 shows it: its length, its parting, how it falls, and whether it is straight, wavy or curly.',
    },
    {
      key: 'shading',
      label: 'Too much shading or dark patches',
      correction:
        'There was too much shading. Keep the skin of every face light and clean: shade only where image 2 has deep shadow, with a few fine, widely spaced strokes. No dark patches round the eyes, beside the nose, under the eyebrows or on the cheeks, and no heavy hatching on the clothes.',
    },
    {
      key: 'outline',
      label: 'Outline wrong (chin, ears, neck)',
      correction:
        'The outline was wrong. Follow the outline of the face, the jaw, the ears and the hair in image 1 exactly; keep both ears whole, and draw the chin and jaw where image 2 has them.',
    },
    {
      key: 'clothes',
      label: 'Clothes or jewellery wrong',
      correction: 'The clothes or jewellery were wrong. Draw them exactly as image 2 shows them, with nothing added and nothing left out.',
    },
    { key: 'other', label: 'Something else' },
  ],
  product_photo: [
    { key: 'metal', label: 'Metal colour or finish wrong' },
    { key: 'engraving', label: 'Engraving doesn\'t match the sketch' },
    { key: 'shape', label: 'Pendant shape or cut wrong' },
    { key: 'bail', label: 'Loop (bail) wrong' },
    { key: 'other', label: 'Something else' },
  ],
  production_files: [
    { key: 'dark', label: 'Too dark or heavy in the laser software' },
    { key: 'lost', label: 'Lines or features missing' },
    { key: 'face_lines', label: 'Extra lines on the face' },
    { key: 'cut', label: 'Cut line wrong' },
    { key: 'size', label: 'Size wrong' },
    { key: 'other', label: 'Something else' },
  ],
};

export const PEOPLE: { value: Person; label: string }[] = [
  { value: 'all', label: 'Everyone' },
  { value: 'left', label: 'Person on the left' },
  { value: 'middle', label: 'Person in the middle' },
  { value: 'right', label: 'Person on the right' },
];

export const NOTE_MAX = 400;

export function isStage(value: unknown): value is FeedbackStage {
  return value === 'sketch' || value === 'product_photo' || value === 'production_files';
}

/** The known issue keys for a stage, in the order they are listed. */
export function issuesFor(stage: FeedbackStage, keys: unknown): Issue[] {
  const chosen = new Set(Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : []);
  return ISSUES[stage].filter((issue) => chosen.has(issue.key));
}

/**
 * What one piece of sketch feedback tells the drawing step: its corrections,
 * who they are for, and the note in the team's own words.
 */
export function correctionsFrom(feedback: { issues: string[]; person: string | null; note: string | null }): string {
  const lines = issuesFor('sketch', feedback.issues)
    .map((issue) => issue.correction)
    .filter((line): line is string => Boolean(line));
  const note = (feedback.note ?? '').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX);
  if (note) lines.push(`In the shop's own words: "${note.replace(/"/g, '\'')}"`);
  if (lines.length === 0) return '';
  const who = PEOPLE.find((p) => p.value === feedback.person);
  if (who && who.value !== 'all') lines.push(`These corrections are about the ${who.label.toLowerCase()}; draw everyone else as before.`);
  return lines.map((line) => `- ${line}`).join('\n');
}

/** The block a redraw adds to the drawing prompt. */
export function correctionsBlock(corrections: string): string {
  return corrections
    ? `CORRECTIONS FROM THE SHOP. They saw an earlier drawing of this same photo and asked for these changes. Make them; where they disagree with anything above, they win. Change nothing else.\n${corrections}`
    : '';
}
