import { describe, expect, test } from "bun:test";
import { unzlibSync } from "fflate";
import { flateEncode, parsePng, pngToEncoded } from "../src/lib/flate";
import { formatPages } from "../src/lib/format";

/** Undoes PNG row filters (PDF Predictor 15) for 8-bit samples. */
function unfilter(data: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
  const rowBytes = width * bpp;
  const out = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const filter = data[y * (rowBytes + 1)];
    for (let i = 0; i < rowBytes; i++) {
      const raw = data[y * (rowBytes + 1) + 1 + i];
      const a = i >= bpp ? out[y * rowBytes + i - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * rowBytes + i] : 0;
      const c = i >= bpp && y > 0 ? out[(y - 1) * rowBytes + i - bpp] : 0;
      const p = a + b - c;
      const paeth =
        Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
          ? a
          : Math.abs(p - b) <= Math.abs(p - c)
            ? b
            : c;
      const pred = [0, a, b, (a + b) >> 1, paeth][filter];
      out[y * rowBytes + i] = (raw + pred) & 0xff;
    }
  }
  return out;
}

describe("flateEncode", () => {
  test("round-trips CMYK samples through PNG predictors", () => {
    const w = 37;
    const h = 23;
    const samples = new Uint8Array(w * h * 4).map((_, i) => (i * 7 + (i >> 5) * 13) & 255);
    const enc = flateEncode(samples, w, h, 4);
    expect(enc).toMatchObject({ filter: "FlateDecode", predictor: true, components: 4, bpc: 8 });
    expect(unfilter(unzlibSync(enc.data), w, h, 4)).toEqual(samples);
  });
});

describe("pngToEncoded", () => {
  const png = (colorType: number, bitDepth: number, palette: number[] | null = null) => ({
    width: 4,
    height: 4,
    bitDepth,
    colorType,
    interlaced: false,
    palette: palette ? new Uint8Array(palette) : null,
    hasTransparency: false,
    idat: new Uint8Array([1, 2, 3]),
  });

  test("gray PNG in a 3-component space becomes an exact gray ramp", () => {
    const enc = pngToEncoded(png(0, 2), 3)!;
    expect(enc.components).toBe(3);
    expect([...enc.palette!]).toEqual([0, 0, 0, 85, 85, 85, 170, 170, 170, 255, 255, 255]);
  });

  test("palette PNG for a gray image keeps one byte per entry", () => {
    const enc = pngToEncoded(png(3, 1, [10, 10, 10, 240, 240, 240]), 1)!;
    expect(enc).toMatchObject({ components: 1, bpc: 1 });
    expect([...enc.palette!]).toEqual([10, 240]);
  });

  test("alpha PNGs are rejected", () => {
    expect(pngToEncoded(png(6, 8), 3)).toBeNull();
  });

  test("parsePng reads IHDR and concatenates IDAT", () => {
    // Minimal 1×1 gray PNG.
    const bytes = Uint8Array.from(
      atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg=="),
      (c) => c.charCodeAt(0),
    );
    const parsed = parsePng(bytes);
    expect(parsed).toMatchObject({ width: 1, height: 1, bitDepth: 8, colorType: 0, interlaced: false });
    expect([...unzlibSync(parsed.idat)]).toEqual([0, 0]);
  });
});

test("formatPages", () => {
  expect(formatPages([1, 2, 3, 5, 7, 8])).toBe("1–3, 5, 7–8");
  expect(formatPages([])).toBe("—");
});
