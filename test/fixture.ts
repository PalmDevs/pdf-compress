/**
 * Builds a test PDF covering the image cases the app has to handle.
 *
 * Objects are created in a fixed order; `makeFixture` returns their numbers.
 */
import * as mupdf from "mupdf";

function photo(cs: mupdf.ColorSpace, w: number, h: number, alpha = false): mupdf.Pixmap {
  const pix = new mupdf.Pixmap(cs, [0, 0, w, h], alpha);
  const px = pix.getPixels();
  const n = pix.getNumberOfComponents();
  const colors = n - (alpha ? 1 : 0);
  let seed = 1;
  const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 9) - 4;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * n;
      for (let c = 0; c < colors; c++) {
        const v = 128 + 90 * Math.sin((x * (c + 1)) / 37 + y / (23 + c * 7)) + noise();
        px[o + c] = Math.max(0, Math.min(255, Math.round(v)));
      }
      if (alpha) px[o + n - 1] = Math.round((x / (w - 1)) * 255);
    }
  }
  return pix;
}

function imageDict(doc: mupdf.PDFDocument, w: number, h: number, bpc: number, cs: mupdf.PDFObject | string) {
  const d = doc.newDictionary();
  d.put("Type", doc.newName("XObject"));
  d.put("Subtype", doc.newName("Image"));
  d.put("Width", w);
  d.put("Height", h);
  d.put("BitsPerComponent", bpc);
  d.put("ColorSpace", typeof cs === "string" ? doc.newName(cs) : cs);
  return d;
}

export interface Fixture {
  bytes: Uint8Array;
  ids: {
    rgbJpeg: number;
    grayFlate: number;
    cmykJpeg: number;
    alphaRgb: number;
    alphaMask: number;
    indexed: number;
    colorKey: number;
    separation: number;
  };
}

export function makeFixture(): Fixture {
  const doc = new mupdf.PDFDocument();

  // 1200×900 RGB JPEG, drawn at 4×3 in (300 DPI) on page 1 and 8×6 in (150 DPI) on page 2.
  const rgbJpeg = doc.addImage(new mupdf.Image(photo(mupdf.ColorSpace.DeviceRGB, 1200, 900).asJPEG(95, false)));
  // 600×600 gray Flate, drawn at 1×1 in (600 DPI).
  const grayFlate = doc.addImage(new mupdf.Image(photo(mupdf.ColorSpace.DeviceGray, 600, 600)));
  // 400×400 CMYK JPEG, drawn at 2×2 in (200 DPI).
  const cmykJpeg = doc.addImage(new mupdf.Image(photo(mupdf.ColorSpace.DeviceCMYK, 400, 400).asJPEG(95, false)));
  // 300×200 RGB with an alpha channel → base image + SMask.
  const alphaRgb = doc.addImage(new mupdf.Image(photo(mupdf.ColorSpace.DeviceRGB, 300, 200, true)));

  // 64×64 Indexed RGB with 4 colours.
  const lookup = new Uint8Array([255, 0, 0, 0, 128, 0, 0, 0, 255, 250, 250, 250]);
  const idxCs = doc.newArray();
  idxCs.push(doc.newName("Indexed"));
  idxCs.push(doc.newName("DeviceRGB"));
  idxCs.push(3);
  idxCs.push(doc.newByteString(lookup));
  const idxData = new Uint8Array(64 * 64).map((_, i) => ((i % 64) >> 4) & 3);
  const indexed = doc.addStream(idxData, imageDict(doc, 64, 64, 8, idxCs));

  // 32×32 RGB with a colour-key mask → must be left alone.
  const ck = imageDict(doc, 32, 32, 8, "DeviceRGB");
  const mask = doc.newArray();
  [0, 0, 0, 0, 0, 0].forEach((v) => mask.push(v));
  ck.put("Mask", mask);
  const colorKey = doc.addStream(new Uint8Array(32 * 32 * 3).fill(200), ck);

  // 50×50 Separation (spot colour) image.
  const sep = doc.newArray();
  sep.push(doc.newName("Separation"));
  sep.push(doc.newName("Spot"));
  sep.push(doc.newName("DeviceCMYK"));
  const fn = doc.newDictionary();
  fn.put("FunctionType", 2);
  const domain = doc.newArray();
  domain.push(0);
  domain.push(1);
  fn.put("Domain", domain);
  const c0 = doc.newArray();
  const c1 = doc.newArray();
  [0, 0, 0, 0].forEach((v) => c0.push(v));
  [0, 0.8, 0.9, 0].forEach((v) => c1.push(v));
  fn.put("C0", c0);
  fn.put("C1", c1);
  fn.put("N", 1);
  sep.push(fn);
  const sepData = new Uint8Array(50 * 50).map((_, i) => (i * 5) & 255);
  const separation = doc.addStream(sepData, imageDict(doc, 50, 50, 8, sep));

  const xobjects = doc.newDictionary();
  const names: [string, mupdf.PDFObject][] = [
    ["Im0", rgbJpeg],
    ["Im1", grayFlate],
    ["Im2", cmykJpeg],
    ["Im3", alphaRgb],
    ["Im4", indexed],
    ["Im5", colorKey],
    ["Im6", separation],
  ];
  for (const [name, ref] of names) xobjects.put(name, ref);
  const resources = doc.newDictionary();
  resources.put("XObject", xobjects);

  const page1 = [
    "q 288 0 0 216 36 560 cm /Im0 Do Q", // 4×3 in
    "q 72 0 0 72 400 700 cm /Im1 Do Q", // 1×1 in
    "q 144 0 0 144 36 380 cm /Im2 Do Q", // 2×2 in
    "q 216 0 0 144 220 380 cm /Im3 Do Q", // 3×2 in → 100 DPI
    "q 64 0 0 64 460 400 cm /Im4 Do Q",
    "q 32 0 0 32 460 300 cm /Im5 Do Q",
    "q 50 0 0 50 400 300 cm /Im6 Do Q",
  ].join("\n");
  const page2 = "q 576 0 0 432 18 300 cm /Im0 Do Q"; // 8×6 in
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, resources, page1));
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, resources, page2));

  const out = doc.saveToBuffer("compress");
  const bytes = new Uint8Array(out.asUint8Array());
  const ids = {
    rgbJpeg: rgbJpeg.asIndirect(),
    grayFlate: grayFlate.asIndirect(),
    cmykJpeg: cmykJpeg.asIndirect(),
    alphaRgb: alphaRgb.asIndirect(),
    alphaMask: alphaRgb.get("SMask").asIndirect(),
    indexed: indexed.asIndirect(),
    colorKey: colorKey.asIndirect(),
    separation: separation.asIndirect(),
  };
  doc.destroy();
  return { bytes, ids };
}
