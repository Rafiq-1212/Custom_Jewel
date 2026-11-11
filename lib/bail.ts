/**
 * The bail that hangs a Silhouette Cut from its chain, as multiples of the
 * hole's radius: a tall, tapered loop of folded metal standing upright above
 * the hanging tab, its narrow lower end passing through the hole — the
 * hardware on the workshop's own finished pieces. (It was a round jump
 * ring; the client wanted it to look like theirs.)
 *
 * It is drawn into the flat design rather than asked for in words because
 * asking failed, repeatedly and in the same way: told to add a hanging loop,
 * the model put it at the top centre of the plate however the prompt was
 * worded, while the real hole sits off to one side above someone's head.
 * Hardware already in the picture cannot be put in the wrong place.
 *
 * It is a bought component threaded through the hole, not metal cut from the
 * sheet, so it belongs only in pictures: the cut layout and the laser
 * exports show the plate and its hole alone.
 */
export const BAIL_HEIGHT = 9;
export const BAIL_TOP_HALF_WIDTH = 2.3;
export const BAIL_BOTTOM_HALF_WIDTH = 0.85;
/** How far below the hole's centre the bail's lower end reaches, so it sits inside the hole. */
export const BAIL_DROP = 0.35;

/** The bail's outline as an SVG path, its lower end in the hole at (cx, cy) of radius r. */
export function bailPath(cx: number, cy: number, r: number): string {
  const bottom = cy + r * BAIL_DROP;
  const top = bottom - r * BAIL_HEIGHT;
  const wt = r * BAIL_TOP_HALF_WIDTH;
  const wb = r * BAIL_BOTTOM_HALF_WIDTH;
  // Straight tapered sides, a round top, a softly rounded lower end.
  return `M${cx - wb} ${bottom} L${cx - wt} ${top + wt} A${wt} ${wt} 0 0 1 ${cx + wt} ${top + wt} L${cx + wb} ${bottom} Q${cx} ${bottom + r * 0.5} ${cx - wb} ${bottom} Z`;
}
