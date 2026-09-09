/**
 * Minimal ambient types for `potrace` (the tooolbox/node-potrace fork), which
 * ships no TypeScript declarations of its own. Covers only what this app
 * actually calls — see node_modules/potrace/lib/index.js and Potrace.js for
 * the verified real signatures this is modelled on.
 */
declare module 'potrace' {
  export interface PotraceOptions {
    turnPolicy?: string;
    turdSize?: number;
    alphaMax?: number;
    optCurve?: boolean;
    optTolerance?: number;
    threshold?: number;
    blackOnWhite?: boolean;
    color?: string;
    background?: string;
  }

  export class Potrace {
    constructor(options?: PotraceOptions);
    setParameters(options: PotraceOptions): void;
    loadImage(file: Buffer | string, callback: (this: Potrace, error: Error | null) => void): void;
    getSVG(): string;
    getPathTag(fillColor?: string): string;
    getSymbol(id: string): string;
  }

  export function trace(
    file: Buffer | string,
    options: PotraceOptions,
    callback: (error: Error | null, svg: string, instance: Potrace) => void,
  ): void;
  export function trace(
    file: Buffer | string,
    callback: (error: Error | null, svg: string, instance: Potrace) => void,
  ): void;
}
