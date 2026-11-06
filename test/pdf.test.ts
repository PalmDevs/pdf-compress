import "./setup";
import { beforeAll, describe, expect, test } from "bun:test";
import * as mupdf from "mupdf";
import { encodeImage } from "../src/lib/codec";
import { encodeCmykJpeg, PdfSession } from "../src/lib/pdf-core";
import { colorTarget, PRESETS, resolveSettings, targetSize } from "../src/lib/settings";
import type { Encoded, ImageInfo, Pixels, Replacement, Settings } from "../src/lib/types";
import { type Fixture, makeFixture } from "./fixture";

let fixture: Fixture;
let session: PdfSession;
let images: ImageInfo[];
const byId = (id: number) => images.find((i) => i.id === id)!;

beforeAll(() => {
  fixture = makeFixture();
  session = new PdfSession(fixture.bytes.slice());
  images = session.scan();
});

const settings = (over: Partial<Settings>): Settings => ({
  mode: "jpeg",
  quality: 75,
  colors: 256,
  dither: 1,
  maxDpi: 0,
  color: "keep",
  ...over,
});

/** What the app does per image: decode → encode (→ CMYK JPEG in the PDF worker). */
async function encode(s: PdfSession, info: ImageInfo, requested: Settings): Promise<Replacement> {
  const { settings: resolved } = resolveSettings(info, requested);
  expect(resolved.mode).not.toBe("keep");
  const px = s.pixels(info.id, resolved.color);
  const result = await encodeImage(px, resolved, targetSize(info, resolved));
  const encoded = "encoded" in result ? result.encoded : encodeCmykJpeg(result.cmykJpeg, resolved.quality);
  return { id: info.id, encoded, target: colorTarget(resolved.color) };
}

function meanAbsDiff(a: Pixels, b: Pixels): number {
  expect(b.width).toBe(a.width);
  expect(b.height).toBe(a.height);
  let sum = 0;
  for (let i = 0; i < a.data.length; i++) if (i % 4 !== 3) sum += Math.abs(a.data[i] - b.data[i]);
  return sum / ((a.data.length / 4) * 3);
}

describe("scan", () => {
  test("lists images but not soft masks", () => {
    const ids = images.map((i) => i.id).sort((a, b) => a - b);
    const { alphaMask, ...expected } = fixture.ids;
    expect(ids).toEqual(Object.values(expected).sort((a, b) => a - b));
    expect(ids).not.toContain(alphaMask);
  });

  test("describes colour spaces and formats", () => {
    const { ids } = fixture;
    expect(byId(ids.rgbJpeg)).toMatchObject({ format: "JPEG", colorKind: "rgb", channels: 3 });
    expect(byId(ids.grayFlate)).toMatchObject({ format: "Flate", colorKind: "gray", channels: 1 });
    expect(byId(ids.cmykJpeg)).toMatchObject({ format: "JPEG", colorKind: "cmyk", channels: 4 });
    expect(byId(ids.indexed)).toMatchObject({ colorSpace: "Indexed DeviceRGB", colorKind: "rgb", channels: 3 });
    expect(byId(ids.separation)).toMatchObject({ colorKind: "separation", channels: 1 });
    expect(byId(ids.alphaRgb).hasSoftMask).toBe(true);
    expect(byId(ids.colorKey).lockedReason).toBeTruthy();
  });

  test("measures effective DPI from the largest placement", () => {
    const { ids } = fixture;
    // Drawn at 300 DPI on page 1 and 150 DPI on page 2: the lower one wins.
    expect(byId(ids.rgbJpeg)).toMatchObject({ dpi: 150, pages: [1, 2] });
    expect(byId(ids.grayFlate)).toMatchObject({ dpi: 600, pages: [1] });
    expect(byId(ids.cmykJpeg).dpi).toBe(200);
    expect(byId(ids.alphaRgb).dpi).toBe(100);
  });
});

describe("settings", () => {
  test("DPI limit downsamples proportionally and never upscales", () => {
    const gray = byId(fixture.ids.grayFlate); // 600×600 at 600 DPI
    expect(targetSize(gray, settings({ maxDpi: 150 }))).toEqual({ width: 150, height: 150 });
    expect(targetSize(gray, settings({ maxDpi: 0 }))).toEqual({ width: 600, height: 600 });
    expect(targetSize(gray, settings({ maxDpi: 1200 }))).toEqual({ width: 600, height: 600 });
  });

  test("impossible combinations fall back to keep, with a reason", () => {
    const cmyk = byId(fixture.ids.cmykJpeg);
    const palette = resolveSettings(cmyk, settings({ mode: "palette" }));
    expect(palette.settings.mode).toBe("keep");
    expect(palette.note).toBeTruthy();
    expect(resolveSettings(cmyk, settings({ mode: "palette", color: "rgb" })).settings.mode).toBe("palette");
    expect(resolveSettings(byId(fixture.ids.colorKey), settings({})).settings.mode).toBe("keep");
  });
});

describe("encode and save", () => {
  // Tolerance: mean absolute sRGB difference vs. the original; null when colours change on purpose.
  const cases: [keyof Fixture["ids"], Partial<Settings>, number | null][] = [
    ["rgbJpeg", { mode: "jpeg", quality: 80 }, 6],
    ["rgbJpeg", { mode: "jpeg", quality: 60, color: "gray" }, null],
    ["grayFlate", { mode: "jpeg", quality: 85 }, 6],
    ["grayFlate", { mode: "lossless" }, 0],
    ["cmykJpeg", { mode: "jpeg", quality: 85 }, 8],
    ["cmykJpeg", { mode: "lossless" }, 0],
    ["cmykJpeg", { mode: "jpeg", quality: 85, color: "rgb" }, 8],
    ["alphaRgb", { mode: "lossless" }, 0],
    ["alphaRgb", { mode: "palette", colors: 64 }, 20],
    ["indexed", { mode: "lossless" }, 0],
    ["separation", { mode: "lossless" }, 0],
    ["separation", { mode: "jpeg", quality: 90 }, 6],
  ];

  for (const [name, over, tolerance] of cases) {
    test(`${name} ${JSON.stringify(over)} round-trips through a saved PDF`, async () => {
      const info = byId(fixture.ids[name]);
      const replacement = await encode(session, info, settings(over));
      const out = session.save([replacement]);

      const reopened = new PdfSession(out);
      try {
        const after = reopened.scan().find((i) => i.id === info.id);
        expect(after).toBeDefined();
        expect(after!.rawSize).toBe(replacement.encoded.data.byteLength);
        // Colours are compared as displayed (sRGB) against the original.
        const diff = meanAbsDiff(session.displayOriginal(info.id), reopened.displayOriginal(info.id));
        if (tolerance !== null) expect(diff).toBeLessThanOrEqual(tolerance);
        if (over.color === "gray") expect(replacement.encoded.components).toBe(1);
        // The preview path decodes the same bytes the same way.
        const preview = session.displayEncoded(info.id, replacement.encoded, replacement.target);
        expect(meanAbsDiff(reopened.displayOriginal(info.id), preview)).toBe(0);
        if (info.hasSoftMask) {
          const obj = reopened.doc.newIndirect(info.id);
          expect(obj.get("SMask").isStream()).toBe(true);
        }
      } finally {
        reopened.destroy();
      }
    });
  }

  test("colour space is preserved by default (ICC stays ICC)", async () => {
    const info = byId(fixture.ids.rgbJpeg);
    const original = session.doc.newIndirect(info.id).get("ColorSpace").toString();
    const replacement = await encode(session, info, settings({ quality: 70 }));
    const reopened = new PdfSession(session.save([replacement]));
    try {
      const cs = reopened.doc.newIndirect(info.id).get("ColorSpace");
      expect(cs.isArray()).toBe(true);
      expect(cs.get(0).asName()).toBe("ICCBased");
      expect(original).toContain(" R");
    } finally {
      reopened.destroy();
    }
  });

  test("downsampling keeps the image's size on the page", async () => {
    const info = byId(fixture.ids.grayFlate);
    const replacement = await encode(session, info, settings({ maxDpi: 150 }));
    expect(replacement.encoded).toMatchObject({ width: 150, height: 150 });
    const reopened = new PdfSession(session.save([replacement]));
    try {
      const after = reopened.scan().find((i) => i.id === info.id)!;
      expect(after).toMatchObject({ width: 150, height: 150, dpi: 150 });
    } finally {
      reopened.destroy();
    }
  });

  test("every preset produces a smaller, valid PDF", async () => {
    for (const preset of PRESETS.filter((p) => p.settings.mode !== "keep")) {
      const replacements: Replacement[] = [];
      for (const info of images) {
        if (resolveSettings(info, preset.settings).settings.mode === "keep") continue;
        const r = await encode(session, info, preset.settings);
        if (r.encoded.data.byteLength + (r.encoded.palette?.byteLength ?? 0) < info.rawSize) replacements.push(r);
      }
      const out = session.save(replacements);
      expect(out.byteLength).toBeLessThan(fixture.bytes.byteLength);

      const doc = mupdf.Document.openDocument(out, "application/pdf");
      try {
        for (let p = 0; p < doc.countPages(); p++) {
          const pix = doc.loadPage(p).toPixmap(mupdf.Matrix.scale(0.25, 0.25), mupdf.ColorSpace.DeviceRGB);
          expect(pix.getWidth()).toBeGreaterThan(0);
          pix.destroy();
        }
      } finally {
        doc.destroy();
      }
    }
  });

  test("saving twice starts from the original each time", async () => {
    const info = byId(fixture.ids.rgbJpeg);
    const low = await encode(session, info, settings({ quality: 20 }));
    session.save([low]);
    const high = await encode(session, info, settings({ quality: 90 }));
    const reopened = new PdfSession(session.save([high]));
    try {
      expect(meanAbsDiff(session.displayOriginal(info.id), reopened.displayOriginal(info.id))).toBeLessThan(6);
    } finally {
      reopened.destroy();
    }
  });
});

describe("CMYK JPEG", () => {
  test("stores values uninverted, as PDF readers expect", () => {
    const px: Pixels = { data: new Uint8ClampedArray(16 * 16 * 4), width: 16, height: 16, channels: 4 };
    for (let i = 0; i < px.data.length; i += 4) px.data.set([200, 20, 100, 10], i);
    const enc: Encoded = encodeCmykJpeg(px, 95);
    const doc = new mupdf.PDFDocument();
    const dict = doc.newDictionary();
    for (const [k, v] of Object.entries({ Width: 16, Height: 16, BitsPerComponent: 8 })) dict.put(k, v);
    dict.put("Type", doc.newName("XObject"));
    dict.put("Subtype", doc.newName("Image"));
    dict.put("ColorSpace", doc.newName("DeviceCMYK"));
    dict.put("Filter", doc.newName("DCTDecode"));
    const pix = doc.loadImage(doc.addRawStream(enc.data, dict)).toPixmap();
    const [c, m, y, k] = pix.getPixels();
    expect(Math.abs(c - 200)).toBeLessThan(4);
    expect(Math.abs(m - 20)).toBeLessThan(4);
    expect(Math.abs(y - 100)).toBeLessThan(4);
    expect(Math.abs(k - 10)).toBeLessThan(4);
  });
});
