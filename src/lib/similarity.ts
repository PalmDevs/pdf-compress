/**
 * Finds images that look the same (e.g. one photo embedded twice at different
 * JPEG qualities). Two checks must both pass:
 *  - coarse colour: 16×16 grid of RGB means;
 *  - fine detail: images stretched to a common square, mean absolute gray
 *    difference per 12×12 block. Using the *worst* block means two scans that
 *    differ only in a few words are not considered similar.
 */
import type { Pixels } from "./types";

const CANON = 384;
const BLOCK = 12;
const CELLS = 16;

export interface Signature {
  id: number;
  width: number;
  height: number;
  /** Ranks which image of a group survives: more pixels, then more bytes. */
  rawSize: number;
  /** The image's transparency mask, when it has one. */
  mask?: Signature;
  /** CELLS×CELLS RGB means. */
  cells: Float32Array;
  /** CANON×CANON gray. */
  gray: Uint8Array;
}

/** Box-filter resample of RGBA to RGB at w×h (nearest when upscaling). */
function resampleRgb(px: Pixels, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h * 3);
  for (let ty = 0; ty < h; ty++) {
    const sy0 = Math.floor((ty * px.height) / h);
    const sy1 = Math.max(sy0 + 1, Math.floor(((ty + 1) * px.height) / h));
    for (let tx = 0; tx < w; tx++) {
      const sx0 = Math.floor((tx * px.width) / w);
      const sx1 = Math.max(sx0 + 1, Math.floor(((tx + 1) * px.width) / w));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let y = sy0; y < sy1; y++) {
        let i = (y * px.width + sx0) * 4;
        for (let x = sx0; x < sx1; x++, i += 4) {
          r += px.data[i];
          g += px.data[i + 1];
          b += px.data[i + 2];
        }
      }
      const n = (sy1 - sy0) * (sx1 - sx0);
      const o = (ty * w + tx) * 3;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
    }
  }
  return out;
}

/** `px` must be display RGBA (as from PdfSession.displayOriginal). */
export function signature(id: number, px: Pixels, rawSize: number): Signature {
  const rgb = resampleRgb(px, CANON, CANON);
  const gray = new Uint8Array(CANON * CANON);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = Math.round(0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2]);
  }
  const cells = new Float32Array(CELLS * CELLS * 3);
  const step = CANON / CELLS;
  for (let cy = 0; cy < CELLS; cy++) {
    for (let cx = 0; cx < CELLS; cx++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let y = cy * step; y < (cy + 1) * step; y++) {
          for (let x = cx * step; x < (cx + 1) * step; x++) sum += rgb[(y * CANON + x) * 3 + c];
        }
        cells[(cy * CELLS + cx) * 3 + c] = sum / (step * step);
      }
    }
  }
  return { id, width: px.width, height: px.height, rawSize, cells, gray };
}

/** Worst-case difference between two signatures, as a similarity percentage (100 = identical). */
export function similarity(a: Signature, b: Signature, floor = 0): number {
  if (Math.abs(a.width / a.height / (b.width / b.height) - 1) > 0.01) return 0;
  // Transparency must match too: both unmasked, or both masks similar.
  let maskScore = 100;
  if (a.mask || b.mask) {
    if (!a.mask || !b.mask) return 0;
    maskScore = similarity(a.mask, b.mask, floor);
    if (maskScore < floor) return 0;
  }
  return Math.min(maskScore, pixelSimilarity(a, b, floor));
}

function pixelSimilarity(a: Signature, b: Signature, floor: number): number {
  const worstAllowed = ((100 - floor) / 100) * 255;
  let worst = 0;
  for (let i = 0; i < a.cells.length; i++) {
    worst = Math.max(worst, Math.abs(a.cells[i] - b.cells[i]));
    if (worst > worstAllowed) return 0;
  }
  const blocks = CANON / BLOCK;
  for (let by = 0; by < blocks; by++) {
    for (let bx = 0; bx < blocks; bx++) {
      let sum = 0;
      for (let y = by * BLOCK; y < (by + 1) * BLOCK; y++) {
        let i = y * CANON + bx * BLOCK;
        for (let x = 0; x < BLOCK; x++, i++) sum += Math.abs(a.gray[i] - b.gray[i]);
      }
      worst = Math.max(worst, sum / (BLOCK * BLOCK));
      if (worst > worstAllowed) return 0;
    }
  }
  return 100 * (1 - worst / 255);
}

/**
 * Greedy clustering: images are visited best-first; each joins the first group
 * whose representative it is similar enough to, so every merged image is
 * directly similar to the image that replaces it (no chains).
 * Returns [merged-away id, replacement id] pairs.
 */
export function findMerges(signatures: Signature[], minSimilarity: number): [number, number][] {
  const ranked = [...signatures].sort(
    (a, b) => b.width * b.height - a.width * a.height || b.rawSize - a.rawSize || a.id - b.id,
  );
  const representatives: Signature[] = [];
  const merges: [number, number][] = [];
  for (const sig of ranked) {
    const match = representatives.find((rep) => similarity(rep, sig, minSimilarity) >= minSimilarity);
    if (match) merges.push([sig.id, match.id]);
    else representatives.push(sig);
  }
  return merges;
}
