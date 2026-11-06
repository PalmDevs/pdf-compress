import "./setup";
import { beforeAll, describe, expect, test } from "bun:test";
import * as mupdf from "mupdf";
import { encodeImage } from "../src/lib/codec";
import { DEFAULT_SAVE_OPTIONS, PdfSession } from "../src/lib/pdf-core";
import { colorTarget, cropRect, targetSize } from "../src/lib/settings";
import type { ImageInfo, Replacement, SaveOptions, Settings } from "../src/lib/types";
import { makeCleanupFixture } from "./cleanup-fixture";

let fixture: ReturnType<typeof makeCleanupFixture>;
let session: PdfSession;
let images: ImageInfo[];
const info = (id: number) => images.find((i) => i.id === id)!;

beforeAll(() => {
  fixture = makeCleanupFixture();
  session = new PdfSession(fixture.bytes.slice());
  images = session.scan();
});

const save = (options: Partial<SaveOptions>, replacements: Replacement[] = []) =>
  session.save(replacements, { ...DEFAULT_SAVE_OPTIONS, ...options });

function open(bytes: Uint8Array) {
  return mupdf.Document.openDocument(bytes, "application/pdf").asPDF()!;
}

function render(bytes: Uint8Array, page: number) {
  const doc = open(bytes);
  const pix = doc.loadPage(page).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB);
  const data = new Uint8Array(pix.getPixels());
  pix.destroy();
  doc.destroy();
  return data;
}

function meanDiff(a: Uint8Array, b: Uint8Array) {
  expect(b.length).toBe(a.length);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

function text(bytes: Uint8Array) {
  const doc = open(bytes);
  const out = Array.from({ length: doc.countPages() }, (_, p) =>
    doc.loadPage(p).toStructuredText("preserve-whitespace").asText(),
  ).join("\n");
  doc.destroy();
  return out;
}

describe("scan", () => {
  test("visible area of a clipped image", () => {
    const v = info(fixture.ids.clipped).visible!;
    expect(v).not.toBeNull();
    [0, 0, 0.5, 0.5].forEach((expected, i) => expect(v[i]).toBeCloseTo(expected, 2));
    expect(info(fixture.ids.photoA).visible).toBeNull(); // fully visible
  });

  test("thumbnails and alternates are never cropped or merged", () => {
    for (const id of [fixture.ids.thumb, fixture.ids.alternate]) {
      const i = images.find((x) => x.id === id);
      if (i) expect(i).toMatchObject({ visible: null, mergeable: false });
    }
    expect(info(fixture.ids.photoA).mergeable).toBe(true);
  });
});

describe("similar images", () => {
  const sizes = () => Object.fromEntries(images.map((i) => [i.id, i.rawSize]));

  test("re-encoded copies merge into the better original; a changed copy does not", () => {
    const ids = images.filter((i) => i.mergeable).map((i) => i.id);
    const merges = session.similarImages(ids, 98, sizes());
    expect(merges).toEqual(
      expect.arrayContaining([
        [fixture.ids.photoACopy, fixture.ids.photoA],
        [fixture.ids.alphaB, fixture.ids.alphaA],
      ]),
    );
    expect(merges).toHaveLength(2);
  });

  test("images with transparency merge only when their masks match", () => {
    expect(info(fixture.ids.alphaA)).toMatchObject({ hasSoftMask: true, mergeable: true, visible: null });
    const ids = images.filter((i) => i.mergeable).map((i) => i.id);
    const merged = session.similarImages(ids, 80, sizes()).map(([from]) => from);
    expect(merged).toContain(fixture.ids.alphaB);
    expect(merged).not.toContain(fixture.ids.alphaOtherMask);
  });

  test("a local change (a small label) blocks merging even at the slider minimum", () => {
    const ids = images.filter((i) => i.mergeable).map((i) => i.id);
    const merged = session.similarImages(ids, 80, sizes()).map(([from]) => from);
    expect(merged).not.toContain(fixture.ids.photoMarked);
  });

  test("merged images with masks render the same", () => {
    const out = save({ merges: [[fixture.ids.alphaB, fixture.ids.alphaA]] });
    expect(meanDiff(render(fixture.bytes, 1), render(out, 1))).toBeLessThan(1);
  });

  test("merging rewrites references and drops the duplicate", () => {
    const out = save({ merges: [[fixture.ids.photoACopy, fixture.ids.photoA]] });
    expect(out.byteLength).toBeLessThan(save({}).byteLength);
    expect(meanDiff(render(fixture.bytes, 1), render(out, 1))).toBeLessThan(1);
  });
});

describe("crop to visible area", () => {
  test("cropped image renders the same and is smaller", async () => {
    const i = info(fixture.ids.clipped);
    const crop = cropRect(i, i.visible)!;
    expect(crop.width).toBeLessThan(i.width * 0.6);
    const settings: Settings = { mode: "lossless", quality: 75, colors: 256, dither: 1, maxDpi: 0, color: "keep" };
    const px = session.pixels(i.id, "keep", crop);
    const result = await encodeImage(px, settings, targetSize(i, settings, crop));
    if (!("encoded" in result)) throw new Error("unexpected CMYK path");
    const replacement: Replacement = {
      id: i.id,
      encoded: result.encoded,
      target: colorTarget("keep"),
      crop: { ...crop, sourceWidth: i.width, sourceHeight: i.height },
    };
    const uncropped = await encodeImage(session.pixels(i.id, "keep"), settings, targetSize(i, settings));
    expect(result.encoded.data.byteLength).toBeLessThan(
      ("encoded" in uncropped ? uncropped.encoded : null)!.data.byteLength / 2,
    );

    const out = save({}, [replacement]);
    expect(meanDiff(render(fixture.bytes, 0), render(out, 0))).toBeLessThan(0.5);
    const doc = open(out);
    expect(doc.newIndirect(i.id).get("Subtype").asName()).toBe("Form");
    doc.destroy();
  });
});

describe("document options", () => {
  test("font subsetting shrinks the file and keeps the text", () => {
    const plain = save({});
    const subset = save({ subsetFonts: true });
    expect(subset.byteLength).toBeLessThan(plain.byteLength - 10_000);
    expect(text(subset)).toBe(text(plain));
    expect(meanDiff(render(plain, 0), render(subset, 0))).toBe(0);
  });

  test("clean content streams keeps rendering and invisible (OCR) text", () => {
    const plain = save({});
    const clean = save({ cleanContent: true });
    expect(text(clean)).toBe(text(plain));
    expect(text(clean)).toContain("invisible ocr text");
    expect(meanDiff(render(plain, 0), render(clean, 0))).toBeLessThan(0.01); // sub-pixel anti-aliasing only
  });

  test("leftovers: PieceInfo, thumbnails and XMP go", () => {
    const out = save({ leftovers: true });
    expect(out.byteLength).toBeLessThan(save({}).byteLength);
    const doc = open(out);
    const page = doc.findPage(0);
    expect(page.get("PieceInfo").isNull()).toBe(true);
    expect(page.get("Thumb").isNull()).toBe(true);
    expect(page.get("Metadata").isNull()).toBe(true);
    expect(doc.getTrailer().get("Root").get("Metadata").isNull()).toBe(true);
    doc.destroy();
  });

  test("leftovers: document XMP is kept for PDF/A", () => {
    const pdfa = makeCleanupFixture({ pdfa: true });
    const s = new PdfSession(pdfa.bytes);
    const doc = open(s.save([], { ...DEFAULT_SAVE_OPTIONS, leftovers: true }));
    expect(doc.getTrailer().get("Root").get("Metadata").isStream()).toBe(true);
    expect(doc.findPage(0).get("Metadata").isNull()).toBe(true);
    doc.destroy();
    s.destroy();
  });

  test("attachments", () => {
    expect(Object.keys(open(save({})).getEmbeddedFiles())).toEqual(["notes.txt"]);
    const doc = open(save({ removeAttachments: true }));
    expect(Object.keys(doc.getEmbeddedFiles())).toEqual([]);
    doc.destroy();
  });

  test("JavaScript", () => {
    const doc = open(save({ removeJavaScript: true }));
    const catalog = doc.getTrailer().get("Root");
    expect(catalog.get("OpenAction").isNull()).toBe(true);
    expect(catalog.get("Names").get("JavaScript").isNull()).toBe(true);
    doc.destroy();
  });

  test("alternate images", () => {
    const doc = open(save({ removeAlternateImages: true }));
    expect(doc.newIndirect(fixture.ids.photoA).get("Alternates").isNull()).toBe(true);
    doc.destroy();
  });

  test("unused named destinations", () => {
    const doc = open(save({ removeUnusedDestinations: true }));
    const tree = doc.getTrailer().get("Root").get("Names").get("Dests");
    const keys: string[] = [];
    const pairs = tree.get("Names");
    for (let i = 0; i < pairs.length; i += 2) keys.push(pairs.get(i).asString());
    expect(keys).toEqual(["used"]);
    doc.destroy();
  });

  test("everything together still renders both pages", () => {
    const all = save({
      subsetFonts: true,
      leftovers: true,
      cleanContent: true,
      removeAttachments: true,
      removeJavaScript: true,
      removeAlternateImages: true,
      removeUnusedDestinations: true,
      merges: [[fixture.ids.photoACopy, fixture.ids.photoA]],
    });
    expect(all.byteLength).toBeLessThan(fixture.bytes.byteLength);
    expect(meanDiff(render(fixture.bytes, 0), render(all, 0))).toBeLessThan(0.5);
    expect(meanDiff(render(fixture.bytes, 1), render(all, 1))).toBeLessThan(1);
  });
});
