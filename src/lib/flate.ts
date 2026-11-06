/**
 * Lossless PDF image streams.
 *
 * PNG's IDAT data is a zlib stream of PNG-filtered rows, which is exactly what
 * PDF's FlateDecode with /Predictor 15 expects. So an optimised PNG from OxiPNG
 * can be embedded without recompression (the same trick img2pdf uses).
 */
import { zlibSync } from "fflate";
import type { Encoded } from "./types";

export interface ParsedPng {
  width: number;
  height: number;
  bitDepth: number;
  /** 0 gray, 2 RGB, 3 palette, 4 gray+alpha, 6 RGBA. */
  colorType: number;
  interlaced: boolean;
  /** PLTE chunk: RGB triples. */
  palette: Uint8Array<ArrayBuffer> | null;
  hasTransparency: boolean;
  /** Concatenated IDAT payloads (a zlib stream). */
  idat: Uint8Array<ArrayBuffer>;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export function parsePng(png: Uint8Array): ParsedPng {
  if (!PNG_SIGNATURE.every((b, i) => png[i] === b)) throw new Error("Not a PNG");
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const idatParts: Uint8Array[] = [];
  let idatLength = 0;
  let header: Omit<ParsedPng, "palette" | "hasTransparency" | "idat"> | null = null;
  let palette: Uint8Array<ArrayBuffer> | null = null;
  let hasTransparency = false;

  for (let pos = 8; pos + 8 <= png.length;) {
    const length = view.getUint32(pos);
    const type = String.fromCharCode(png[pos + 4], png[pos + 5], png[pos + 6], png[pos + 7]);
    const data = png.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") {
      header = {
        width: view.getUint32(pos + 8),
        height: view.getUint32(pos + 12),
        bitDepth: data[8],
        colorType: data[9],
        interlaced: data[12] !== 0,
      };
    } else if (type === "PLTE") {
      palette = data.slice();
    } else if (type === "tRNS") {
      hasTransparency = true;
    } else if (type === "IDAT") {
      idatParts.push(data);
      idatLength += data.length;
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + length;
  }
  if (!header) throw new Error("PNG has no IHDR");

  const idat = new Uint8Array(idatLength);
  let offset = 0;
  for (const part of idatParts) {
    idat.set(part, offset);
    offset += part.length;
  }
  return { ...header, palette, hasTransparency, idat };
}

/**
 * Maps an optimised PNG to a PDF stream whose colour space has `channels`
 * components (1 or 3). Returns null when the PNG layout has no exact PDF equivalent.
 */
export function pngToEncoded(png: ParsedPng, channels: 1 | 3): Encoded | null {
  if (png.interlaced || png.bitDepth > 8) return null;
  const common = {
    filter: "FlateDecode" as const,
    data: png.idat,
    width: png.width,
    height: png.height,
    bpc: png.bitDepth,
    predictor: true,
  };

  switch (png.colorType) {
    case 0: {
      if (png.hasTransparency) return null;
      if (channels === 1) return { ...common, components: 1 };
      // Gray samples in a 3-component space: an Indexed ramp keeps the colours exact.
      const levels = 1 << png.bitDepth;
      const ramp = new Uint8Array(levels * 3);
      for (let i = 0; i < levels; i++) ramp.fill(Math.round((i * 255) / (levels - 1)), i * 3, i * 3 + 3);
      return { ...common, components: 3, palette: ramp };
    }
    case 2:
      if (png.hasTransparency || channels !== 3) return null;
      return { ...common, components: 3 };
    case 3: {
      if (!png.palette) return null;
      if (channels === 3) return { ...common, components: 3, palette: png.palette };
      // Gray image: palette entries have R = G = B, keep one byte each.
      const gray = new Uint8Array(png.palette.length / 3);
      for (let i = 0; i < gray.length; i++) gray[i] = png.palette[i * 3];
      return { ...common, components: 1, palette: gray };
    }
    default:
      return null;
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Generic 8-bit PNG-predicted Flate encoder, for layouts PNG can't express (CMYK)
 * and as a fallback. Picks a filter per row with the usual minimum-sum heuristic.
 */
export function flateEncode(samples: Uint8Array, width: number, height: number, components: 1 | 3 | 4): Encoded {
  const bpp = components;
  const rowBytes = width * bpp;
  const filtered = new Uint8Array(height * (rowBytes + 1));
  const candidates = Array.from({ length: 5 }, () => new Uint8Array(rowBytes));
  const zeroRow = new Uint8Array(rowBytes);

  for (let y = 0; y < height; y++) {
    const row = samples.subarray(y * rowBytes, (y + 1) * rowBytes);
    const prev = y > 0 ? samples.subarray((y - 1) * rowBytes, y * rowBytes) : zeroRow;
    let best = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      const out = candidates[f];
      let score = 0;
      for (let i = 0; i < rowBytes; i++) {
        const a = i >= bpp ? row[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        const predicted = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const v = (row[i] - predicted) & 0xff;
        out[i] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
    }
    const offset = y * (rowBytes + 1);
    filtered[offset] = best;
    filtered.set(candidates[best], offset + 1);
  }

  return {
    filter: "FlateDecode",
    data: zlibSync(filtered, { level: 9 }),
    width,
    height,
    bpc: 8,
    components,
    predictor: true,
  };
}

/** Extracts the first `components` bytes of each RGBA-packed pixel. */
export function unpackSamples(rgba: Uint8ClampedArray, components: 1 | 3 | 4): Uint8Array {
  const pixels = rgba.length / 4;
  const out = new Uint8Array(pixels * components);
  for (let p = 0, s = 0, d = 0; p < pixels; p++, s += 4, d += components) {
    for (let c = 0; c < components; c++) out[d + c] = rgba[s + c];
  }
  return out;
}
