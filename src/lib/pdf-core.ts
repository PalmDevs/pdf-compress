/**
 * Everything that touches the PDF itself, built on mupdf.js.
 * Kept free of DOM/worker APIs so it runs under `bun test` too.
 */
import * as mupdf from "mupdf";
import {
  removeAlternateImages,
  removeAttachments,
  removeJavaScript,
  removeLeftovers,
  removeUnusedDestinations,
  replaceReferences,
  wrapAsCroppedForm,
} from "./doc-cleanup";
import { findMerges, type Signature, signature } from "./similarity";
import type {
  ColorKind,
  ColorMode,
  ColorTarget,
  CropRect,
  Encoded,
  ImageInfo,
  Pixels,
  Replacement,
  SaveOptions,
} from "./types";
import { VisibleArea, visibilityDevice } from "./visibility";

interface ColorSpaceDescription {
  label: string;
  kind: ColorKind;
  channels: number;
}

const DEVICE_SPACES: Record<string, ColorSpaceDescription> = {
  DeviceGray: { label: "DeviceGray", kind: "gray", channels: 1 },
  G: { label: "DeviceGray", kind: "gray", channels: 1 },
  DeviceRGB: { label: "DeviceRGB", kind: "rgb", channels: 3 },
  RGB: { label: "DeviceRGB", kind: "rgb", channels: 3 },
  DeviceCMYK: { label: "DeviceCMYK", kind: "cmyk", channels: 4 },
  CMYK: { label: "DeviceCMYK", kind: "cmyk", channels: 4 },
};

const KIND_BY_CHANNELS: Record<number, ColorKind> = { 1: "gray", 3: "rgb", 4: "cmyk" };
const NAME_BY_CHANNELS: Record<number, string> = { 1: "Gray", 3: "RGB", 4: "CMYK" };

/** Describes a PDF colour space object. Indexed spaces are described by their base. */
export function describeColorSpace(
  cs: mupdf.PDFObject,
  depth = 0,
): (ColorSpaceDescription & { indexed: boolean }) | null {
  if (depth > 4 || cs.isNull()) return null;
  if (cs.isName()) {
    const known = DEVICE_SPACES[cs.asName()];
    return known ? { ...known, indexed: false } : null;
  }
  if (!cs.isArray() || cs.length === 0) return null;

  const family = cs.get(0).asName();
  const plain = (d: ColorSpaceDescription) => ({ ...d, indexed: false });
  switch (family) {
    case "ICCBased": {
      const profile = cs.get(1);
      const n = profile.isDictionary() ? profile.get("N").asNumber() : 0;
      return plain({
        label: `ICC ${NAME_BY_CHANNELS[n] ?? `${n}-channel`}`,
        kind: KIND_BY_CHANNELS[n] ?? "unknown",
        channels: n,
      });
    }
    case "CalRGB":
      return plain({ label: "CalRGB", kind: "rgb", channels: 3 });
    case "CalGray":
      return plain({ label: "CalGray", kind: "gray", channels: 1 });
    case "Lab":
      return plain({ label: "Lab", kind: "lab", channels: 3 });
    case "Separation":
      return plain({ label: `Separation (${cs.get(1).asName()})`, kind: "separation", channels: 1 });
    case "DeviceN": {
      const n = cs.get(1).length;
      return plain({ label: `DeviceN (${n})`, kind: n === 1 ? "separation" : "devicen", channels: n });
    }
    case "Indexed":
    case "I": {
      const b = describeColorSpace(cs.get(1), depth + 1);
      return b ? { ...b, label: `Indexed ${b.label}`, indexed: true } : null;
    }
    default: {
      const known = DEVICE_SPACES[family];
      return known ? plain(known) : null;
    }
  }
}

function describeFromImage(image: mupdf.Image): ColorSpaceDescription {
  const cs = image.getColorSpace();
  const n = cs?.getNumberOfComponents() ?? image.getNumberOfComponents();
  const type = cs?.getType();
  const kind: ColorKind =
    type === "Gray"
      ? "gray"
      : type === "RGB" || type === "BGR"
        ? "rgb"
        : type === "CMYK"
          ? "cmyk"
          : type === "Lab"
            ? "lab"
            : type === "Separation"
              ? n === 1
                ? "separation"
                : "devicen"
              : (KIND_BY_CHANNELS[n] ?? "unknown");
  return { label: cs?.getName() ?? `${n}-channel`, kind, channels: n };
}

const FORMAT_NAMES: Record<string, string> = {
  DCTDecode: "JPEG",
  DCT: "JPEG",
  FlateDecode: "Flate",
  Fl: "Flate",
  JPXDecode: "JPEG 2000",
  JBIG2Decode: "JBIG2",
  CCITTFaxDecode: "CCITT",
  CCF: "CCITT",
  LZWDecode: "LZW",
  LZW: "LZW",
  RunLengthDecode: "RunLength",
  RL: "RunLength",
};
const TEXT_FILTERS = new Set(["ASCIIHexDecode", "AHx", "ASCII85Decode", "A85"]);

/** The codec that actually holds the pixels (the last non-text filter). */
export function formatOf(obj: mupdf.PDFObject): string {
  const f = obj.get("Filter");
  const names: string[] = [];
  if (f.isName()) names.push(f.asName());
  else if (f.isArray()) for (let i = 0; i < f.length; i++) names.push(f.get(i).asName());
  const codec = names.filter((n) => !TEXT_FILTERS.has(n)).at(-1);
  return codec ? (FORMAT_NAMES[codec] ?? codec) : "Uncompressed";
}

/** Base (non-Indexed) colour space of an image, falling back to a device space. */
function originalBaseColorSpace(doc: mupdf.PDFDocument, obj: mupdf.PDFObject, components: number): mupdf.PDFObject {
  const cs = obj.get("ColorSpace");
  if (cs.isArray() && cs.length >= 2 && ["Indexed", "I"].includes(cs.get(0).asName())) return cs.get(1);
  if (!cs.isNull()) return cs;
  return doc.newName(components === 1 ? "DeviceGray" : components === 4 ? "DeviceCMYK" : "DeviceRGB");
}

function colorSpaceFor(
  doc: mupdf.PDFDocument,
  enc: Encoded,
  target: ColorTarget,
  original: () => mupdf.PDFObject,
): mupdf.PDFObject {
  const base = target === "original" ? original() : doc.newName(target);
  if (!enc.palette) return base;
  const indexed = doc.newArray();
  indexed.push(doc.newName("Indexed"));
  indexed.push(base);
  indexed.push(enc.palette.length / enc.components - 1);
  indexed.push(doc.newByteString(enc.palette));
  return indexed;
}

/** Writes the image dictionary entries describing `enc` into `dict`. */
function writeImageDict(doc: mupdf.PDFDocument, dict: mupdf.PDFObject, enc: Encoded, colorSpace: mupdf.PDFObject) {
  for (const key of ["DecodeParms", "Decode", "SMaskInData", "DL", "Filter"]) dict.delete(key);
  dict.put("Type", doc.newName("XObject"));
  dict.put("Subtype", doc.newName("Image"));
  dict.put("Width", enc.width);
  dict.put("Height", enc.height);
  dict.put("BitsPerComponent", enc.bpc);
  dict.put("ColorSpace", colorSpace);
  dict.put("Filter", doc.newName(enc.filter));
  if (enc.predictor) {
    const parms = doc.newDictionary();
    parms.put("Predictor", 15);
    parms.put("Colors", enc.palette ? 1 : enc.components);
    parms.put("BitsPerComponent", enc.bpc);
    parms.put("Columns", enc.width);
    dict.put("DecodeParms", parms);
  }
}

/**
 * Packs a pixmap's samples into four-bytes-per-pixel layout. The alpha channel
 * (e.g. from colour-key masking) is copied only when `withAlpha` is set.
 */
function packPixmap(pix: mupdf.Pixmap, withAlpha = false): Pixels {
  const width = pix.getWidth();
  const height = pix.getHeight();
  const n = pix.getNumberOfComponents();
  const channels = n - pix.getAlpha();
  if (channels !== 1 && channels !== 3 && channels !== 4) {
    throw new Error(`Unsupported number of colour channels: ${channels}`);
  }
  const alpha = withAlpha && pix.getAlpha() > 0;
  const stride = pix.getStride();
  const src = pix.getPixels();
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    let s = y * stride;
    let d = y * width * 4;
    for (let x = 0; x < width; x++, s += n, d += 4) {
      if (channels === 1) {
        out[d] = out[d + 1] = out[d + 2] = src[s];
        out[d + 3] = alpha ? src[s + 1] : 255;
      } else if (channels === 3) {
        out[d] = src[s];
        out[d + 1] = src[s + 1];
        out[d + 2] = src[s + 2];
        out[d + 3] = alpha ? src[s + 3] : 255;
      } else {
        out[d] = src[s];
        out[d + 1] = src[s + 1];
        out[d + 2] = src[s + 2];
        out[d + 3] = src[s + 3];
      }
    }
  }
  return { data: out, width, height, channels };
}

/** Decodes an image to sRGB-ish RGBA for display. */
/** A mask (soft mask or stencil) as gray RGBA, from its first sample per pixel. */
function maskPixels(mask: mupdf.Image): Pixels {
  const pix = mask.toPixmap();
  try {
    const width = pix.getWidth();
    const height = pix.getHeight();
    const n = pix.getNumberOfComponents();
    const stride = pix.getStride();
    const src = pix.getPixels();
    const out = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = src[y * stride + x * n];
        const d = (y * width + x) * 4;
        out[d] = out[d + 1] = out[d + 2] = v;
        out[d + 3] = 255;
      }
    }
    return { data: out, width, height, channels: 1 };
  } finally {
    pix.destroy();
  }
}

function displayPixels(image: mupdf.Image): Pixels {
  const pix = image.toPixmap();
  try {
    if (pix.getColorSpace()?.isRGB()) return packPixmap(pix, true);
    const rgb = pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, pix.getAlpha() > 0);
    try {
      return packPixmap(rgb, true);
    } finally {
      rgb.destroy();
    }
  } finally {
    pix.destroy();
  }
}

export class PdfSession {
  readonly doc: mupdf.PDFDocument;
  readonly pageCount: number;
  private readonly bytes: Uint8Array;
  private readonly images = new Map<number, mupdf.Image>();

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    const doc = mupdf.Document.openDocument(bytes, "application/pdf");
    if (doc.needsPassword()) {
      doc.destroy();
      throw new Error("This PDF is password-protected, which isn't supported.");
    }
    const pdf = doc.asPDF();
    if (!pdf) throw new Error("Not a PDF file.");
    this.doc = pdf;
    this.pageCount = pdf.countPages();
  }

  destroy() {
    for (const image of this.images.values()) image.destroy();
    this.images.clear();
    this.doc.destroy();
  }

  /** Lists every image XObject (excluding masks) and measures where it is drawn. */
  scan(onProgress?: (donePages: number, totalPages: number) => void): ImageInfo[] {
    const doc = this.doc;
    const masks = new Set<number>();
    const candidates: number[] = [];
    /** Images referenced other than by drawing them (thumbnails, alternates): never cropped. */
    const usedElsewhere = new Set<number>();

    const objectCount = doc.countObjects();
    for (let num = 1; num < objectCount; num++) {
      try {
        const obj = doc.newIndirect(num);
        if (!obj.isStream() || obj.get("Subtype").asName() !== "Image") continue;
        candidates.push(num);
        const alternates = obj.get("Alternates");
        if (alternates.isArray()) {
          for (let i = 0; i < alternates.length; i++) {
            const entry = alternates.get(i);
            const alt = entry.isDictionary() ? entry.get("Image") : entry;
            if (alt.isIndirect()) usedElsewhere.add(alt.asIndirect());
          }
        }
        for (const key of ["SMask", "Mask"]) {
          const m = obj.get(key);
          if (m.isIndirect() && m.isStream()) masks.add(m.asIndirect());
        }
        if (obj.get("ImageMask").asBoolean()) masks.add(num);
      } catch {
        // Broken object: skip it.
      }
    }

    const infos = new Map<number, ImageInfo & { masked: boolean }>();
    const areas = new Map<number, VisibleArea>();
    const byPointer = new Map<number, number>();
    for (const num of candidates) {
      if (masks.has(num)) continue;
      try {
        const obj = doc.newIndirect(num);
        const image = doc.loadImage(obj);
        this.images.set(num, image);
        byPointer.set(image.pointer as unknown as number, num);

        const described = describeColorSpace(obj.get("ColorSpace"));
        const cs = described ?? { ...describeFromImage(image), indexed: false };
        let rawSize = obj.get("Length").asNumber();
        if (!rawSize) {
          const raw = obj.readRawStream();
          rawSize = raw.getLength();
          raw.destroy();
        }
        const smask = obj.get("SMask");
        infos.set(num, {
          id: num,
          width: image.getWidth(),
          height: image.getHeight(),
          bpc: image.getBitsPerComponent(),
          format: formatOf(obj),
          colorSpace: cs.label,
          colorKind: cs.kind,
          channels: cs.channels,
          rawSize,
          pages: [],
          dpi: null,
          hasSoftMask: smask.isStream() || obj.get("SMaskInData").asNumber() > 0,
          // Internal: any mask at all (soft, stencil or embedded). Cropping would misalign it.
          masked: smask.isStream() || obj.get("Mask").isStream() || obj.get("SMaskInData").asNumber() > 0,
          lockedReason: obj.get("Mask").isArray()
            ? "Uses a colour-key mask, which re-encoding would break"
            : obj.get("SMaskInData").asNumber() > 0
              ? "Transparency is embedded in the JPEG 2000 stream"
              : null,
          visible: null,
          mergeable: false,
        });
        areas.set(num, new VisibleArea());
      } catch (err) {
        console.warn(`Skipping image object ${num}:`, err);
      }
    }

    // Run every page through a device that only records image placements.
    // The device receives the same fz_image pointers loadImage returned above.
    for (let p = 0; p < this.pageCount; p++) {
      const page = doc.loadPage(p);
      const thumb = page.getObject().get("Thumb");
      if (thumb.isIndirect()) usedElsewhere.add(thumb.asIndirect());
      const bounds = page.getBounds() as [number, number, number, number];
      const device = new mupdf.Device(
        visibilityDevice(bounds, (image, ctm, placement) => {
          const id = byPointer.get(image.pointer as unknown as number);
          image.destroy();
          const info = id === undefined ? undefined : infos.get(id);
          if (!info) return;
          areas.get(info.id)!.add(placement);
          const widthPt = Math.hypot(ctm[0], ctm[1]);
          const heightPt = Math.hypot(ctm[2], ctm[3]);
          if (widthPt < 0.01 || heightPt < 0.01) return;
          const dpi = Math.min(info.width / (widthPt / 72), info.height / (heightPt / 72));
          info.dpi = info.dpi === null ? dpi : Math.min(info.dpi, dpi);
          if (info.pages.at(-1) !== p + 1) info.pages.push(p + 1);
        }),
      );
      try {
        page.run(device, mupdf.Matrix.identity);
      } catch (err) {
        console.warn(`Could not scan page ${p + 1}:`, err);
      } finally {
        device.close();
        device.destroy();
        page.destroy();
      }
      onProgress?.(p + 1, this.pageCount);
    }

    return [...infos.values()].map(({ masked, ...info }) => {
      // Merging compares masks too (see similarImages), so masked images can merge;
      // cropping would need the mask cropped as well, so they aren't cropped.
      const mergeable = !info.lockedReason && !usedElsewhere.has(info.id);
      return {
        ...info,
        dpi: info.dpi === null ? null : Math.round(info.dpi),
        visible: mergeable && !masked ? areas.get(info.id)!.result() : null,
        mergeable,
      };
    });
  }

  private image(id: number): mupdf.Image {
    let image = this.images.get(id);
    if (!image) {
      image = this.doc.loadImage(this.doc.newIndirect(id));
      this.images.set(id, image);
    }
    return image;
  }

  /** Decoded pixels in the colour space the encoder should work in, optionally cropped. */
  pixels(id: number, color: ColorMode, crop: CropRect | null = null): Pixels {
    const pix = this.image(id).toPixmap();
    let converted: mupdf.Pixmap | null = null;
    try {
      const keepAlpha = pix.getAlpha() > 0; // mupdf can't drop alpha while converting; packing ignores it
      if (color === "rgb") converted = pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, keepAlpha);
      else if (color === "gray") converted = pix.convertToColorSpace(mupdf.ColorSpace.DeviceGray, keepAlpha);
      const px = packPixmap(converted ?? pix);
      return crop ? cropPixels(px, crop) : px;
    } finally {
      converted?.destroy();
      pix.destroy();
    }
  }

  private readonly signatures = new Map<number, Signature>();

  /**
   * Groups visually similar images. Signatures are computed once per image
   * (decoding each image), so changing the threshold afterwards is cheap.
   */
  similarImages(
    ids: number[],
    minSimilarity: number,
    rawSizes: Record<number, number>,
    onProgress?: (done: number, total: number) => void,
  ): [number, number][] {
    ids.forEach((id, i) => {
      if (!this.signatures.has(id)) {
        try {
          const image = this.image(id);
          const sig = signature(id, displayPixels(image), rawSizes[id] ?? 0);
          const mask = image.getMask();
          if (mask) {
            try {
              sig.mask = signature(id, maskPixels(mask), 0);
            } finally {
              mask.destroy();
            }
          }
          this.signatures.set(id, sig);
        } catch (err) {
          console.warn(`Could not compare image ${id}:`, err);
        }
      }
      onProgress?.(i + 1, ids.length);
    });
    const sigs = ids.map((id) => this.signatures.get(id)).filter((s): s is Signature => !!s);
    return findMerges(sigs, minSimilarity);
  }

  /** The original image as RGBA for display. */
  displayOriginal(id: number): Pixels {
    return displayPixels(this.image(id));
  }

  /**
   * Decodes an encoded result exactly as a PDF reader would: it is embedded in a
   * scratch document (with the original colour space grafted in) and loaded back.
   */
  displayEncoded(id: number, enc: Encoded, target: ColorTarget): Pixels {
    const scratch = new mupdf.PDFDocument();
    try {
      const source = this.doc.newIndirect(id);
      const dict = scratch.newDictionary();
      const cs = colorSpaceFor(scratch, enc, target, () =>
        scratch.graftObject(originalBaseColorSpace(this.doc, source, enc.components)),
      );
      writeImageDict(scratch, dict, enc, cs);
      const ref = scratch.addRawStream(enc.data, dict);
      const image = scratch.loadImage(ref);
      try {
        return displayPixels(image);
      } finally {
        image.destroy();
      }
    } finally {
      scratch.destroy();
    }
  }

  /** Writes a new PDF with the replacements and options applied. The session's document is left untouched. */
  save(replacements: Replacement[], options: SaveOptions = DEFAULT_SAVE_OPTIONS): Uint8Array<ArrayBuffer> {
    const copy = mupdf.Document.openDocument(this.bytes, "application/pdf").asPDF()!;
    try {
      const mergedAway = new Map(options.merges);
      replaceReferences(copy, mergedAway);

      for (const { id, encoded, target, crop } of replacements) {
        if (mergedAway.has(id)) continue;
        const obj = copy.newIndirect(id);
        // Resolve the colour space before the dictionary is rewritten.
        const cs = colorSpaceFor(copy, encoded, target, () => originalBaseColorSpace(copy, obj, encoded.components));
        if (!crop) {
          obj.writeRawStream(encoded.data);
          writeImageDict(copy, obj, encoded, cs);
          continue;
        }
        const dict = copy.newDictionary();
        for (const key of ["Interpolate", "Intent"]) {
          const value = obj.get(key);
          if (!value.isNull()) dict.put(key, value);
        }
        writeImageDict(copy, dict, encoded, cs);
        const image = copy.addRawStream(encoded.data, dict);
        // Image rows run top to bottom; PDF's unit square has y pointing up.
        wrapAsCroppedForm(copy, obj, image, {
          x0: crop.x / crop.sourceWidth,
          x1: (crop.x + crop.width) / crop.sourceWidth,
          y0: 1 - (crop.y + crop.height) / crop.sourceHeight,
          y1: 1 - crop.y / crop.sourceHeight,
        });
      }

      if (options.removeAttachments) removeAttachments(copy);
      if (options.removeJavaScript) removeJavaScript(copy);
      if (options.removeAlternateImages) removeAlternateImages(copy);
      if (options.removeUnusedDestinations) removeUnusedDestinations(copy);
      if (options.leftovers) removeLeftovers(copy);

      // Pass 1 writes the edits without renumbering objects; pass 2 starts from a
      // freshly parsed document (no live JS handles) and compacts it.
      const edited = copy.saveToBuffer("garbage=yes");
      try {
        return finish(edited.asUint8Array(), options);
      } finally {
        edited.destroy();
      }
    } finally {
      copy.destroy();
    }
  }
}

/** Font subsetting, content cleaning and compaction, on a fresh parse of `bytes`. */
function finish(bytes: Uint8Array, options: SaveOptions): Uint8Array<ArrayBuffer> {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf").asPDF()!;
  try {
    if (options.subsetFonts) {
      try {
        doc.subsetFonts();
      } catch (err) {
        console.warn("Font subsetting failed; fonts left as they are:", err);
      }
    }
    const out = doc.saveToBuffer("garbage=deduplicate,compress,objstms" + (options.cleanContent ? ",sanitize" : ""));
    try {
      return new Uint8Array(out.asUint8Array());
    } finally {
      out.destroy();
    }
  } finally {
    doc.destroy();
  }
}

export const DEFAULT_SAVE_OPTIONS: SaveOptions = {
  subsetFonts: false,
  leftovers: false,
  cleanContent: false,
  removeAttachments: false,
  removeJavaScript: false,
  removeAlternateImages: false,
  removeUnusedDestinations: false,
  merges: [],
};

function cropPixels(px: Pixels, crop: CropRect): Pixels {
  const out = new Uint8ClampedArray(crop.width * crop.height * 4);
  for (let y = 0; y < crop.height; y++) {
    const start = ((crop.y + y) * px.width + crop.x) * 4;
    out.set(px.data.subarray(start, start + crop.width * 4), y * crop.width * 4);
  }
  return { data: out, width: crop.width, height: crop.height, channels: px.channels };
}

/** CMYK JPEG via mupdf's libjpeg (the MozJPEG build only takes RGBA). Values are stored uninverted. */
export function encodeCmykJpeg(px: Pixels, quality: number): Encoded {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceCMYK, [0, 0, px.width, px.height], false);
  try {
    pix.getPixels().set(px.data);
    const data = new Uint8Array(pix.asJPEG(quality, false));
    return { filter: "DCTDecode", data, width: px.width, height: px.height, bpc: 8, components: 4 };
  } finally {
    pix.destroy();
  }
}
