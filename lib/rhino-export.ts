/**
 * Rhino .3dm writer, via McNeel's official `rhino3dm` (openNURBS compiled to
 * WASM) — the client's jewellery CAD workflow takes a .3dm alongside the DXF,
 * so both are produced from the same flattened curves lib/laser-export.ts
 * already builds for the DXF.
 *
 * What goes in: 2D closed polyline curves on the Z=0 plane, in millimetres,
 * Y-up (the same CAD convention the DXF uses), on two layers — CUT (red) for
 * the pendant perimeter and ENGRAVE (black) for the artwork — so the CAD
 * operator can select each operation as a whole. No surfaces or relief: a 2D
 * sketch has no credible depth information to invent, and the operator
 * extrudes/embosses the curves in Rhino as part of their normal process.
 */

import rhino3dm, { type RhinoModule, type File3dm } from 'rhino3dm';
import type { Point } from './pendant-geometry';

if (typeof window !== 'undefined') {
  throw new Error('lib/rhino-export.ts was imported into a browser bundle. This module is server-only.');
}

export type RhinoLayerName = 'CUT' | 'ENGRAVE';

export interface RhinoPolylineSpec {
  points: Point[];
  layer: RhinoLayerName;
  closed: boolean;
}

// The WASM module is loaded once per process and reused.
let modulePromise: Promise<RhinoModule> | null = null;
function getRhino(): Promise<RhinoModule> {
  modulePromise ??= rhino3dm();
  return modulePromise;
}

function addLayer(
  rhino: RhinoModule,
  doc: File3dm,
  name: RhinoLayerName,
  color: { r: number; g: number; b: number; a: number },
): number {
  const layer = new rhino.Layer();
  layer.name = name;
  layer.color = color;
  return doc.layers().add(layer);
}

export async function buildRhino3dm(polylines: RhinoPolylineSpec[]): Promise<Uint8Array> {
  const rhino = await getRhino();
  const doc = new rhino.File3dm();
  doc.settings().modelUnitSystem = rhino.UnitSystem.Millimeters;

  const layerIndex: Record<RhinoLayerName, number> = {
    CUT: addLayer(rhino, doc, 'CUT', { r: 255, g: 0, b: 0, a: 255 }),
    ENGRAVE: addLayer(rhino, doc, 'ENGRAVE', { r: 0, g: 0, b: 0, a: 255 }),
  };

  for (const spec of polylines) {
    const points = spec.points.map((p) => [p.x, p.y, 0]);
    if (spec.closed && points.length > 1) {
      const first = points[0];
      const last = points[points.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) points.push([...first]);
    }
    if (points.length < 2) continue;

    const curve = new rhino.PolylineCurve(points);
    const attributes = new rhino.ObjectAttributes();
    attributes.layerIndex = layerIndex[spec.layer];
    doc.objects().addCurve(curve, attributes);
  }

  return doc.toByteArray();
}
