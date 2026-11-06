/** What happens to an image when the PDF is saved. */
export type Mode = "keep" | "jpeg" | "lossless" | "palette";

/** `keep` preserves the image's own colour space (CMYK stays CMYK, ICC stays ICC). */
export type ColorMode = "keep" | "rgb" | "gray";

export interface Settings {
  mode: Mode;
  /** JPEG quality, 1–100. */
  quality: number;
  /** Palette size for `palette` mode, 2–256. */
  colors: number;
  /** Dithering strength for `palette` mode, 0–1. */
  dither: number;
  /** Downsample images whose effective resolution is above this. 0 = never downsample. */
  maxDpi: number;
  color: ColorMode;
}

export type ColorKind = "gray" | "rgb" | "cmyk" | "lab" | "separation" | "devicen" | "unknown";

export interface ImageInfo {
  /** PDF object number of the image XObject. */
  id: number;
  width: number;
  height: number;
  bpc: number;
  /** Human-readable codec of the stored stream, e.g. "JPEG", "Flate", "JPEG 2000". */
  format: string;
  /** Human-readable colour space, e.g. "ICC RGB", "Indexed RGB", "DeviceCMYK". */
  colorSpace: string;
  /** Colour model after decoding (Indexed images are expanded to their base). */
  colorKind: ColorKind;
  /** Samples per pixel after decoding. */
  channels: number;
  /** Size of the stream as stored in the file, in bytes. */
  rawSize: number;
  /** 1-based page numbers the image is drawn on. */
  pages: number[];
  /** Lowest effective resolution over all placements; null when never drawn. */
  dpi: number | null;
  hasSoftMask: boolean;
  /** Set when the image must be left untouched, with the reason. */
  lockedReason: string | null;
  /**
   * Union of the parts of the image that are visible on any page, in image unit
   * space (0–1, origin top-left): [left, top, right, bottom]. null when the image
   * can't be cropped (fully visible, not drawn, masked, or used outside pages).
   */
  visible: UnitRect | null;
  /** Can be merged with a similar image (no masks, not locked). */
  mergeable: boolean;
}

/** [left, top, right, bottom] in image unit space, origin at the top-left pixel. */
export type UnitRect = [number, number, number, number];

/** A pixel rectangle of the original image (row 0 at the top). */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Document-wide options, applied when saving. */
export interface DocOptions {
  subsetFonts: boolean;
  /** Remove /PieceInfo, page thumbnails and XMP metadata (kept for PDF/A, PDF/UA, PDF/X). */
  leftovers: boolean;
  /** Rewrite page content streams without redundant operators (mupdf "sanitize"). */
  cleanContent: boolean;
  mergeSimilar: boolean;
  /** Minimum similarity for merging, 80–100 (%). */
  similarity: number;
  cropToVisible: boolean;
  removeAttachments: boolean;
  removeJavaScript: boolean;
  removeAlternateImages: boolean;
  removeUnusedDestinations: boolean;
}

/** Decoded pixels, always packed four bytes per pixel (RGBA layout, CMYK stored as C,M,Y,K). */
export interface Pixels {
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
  channels: 1 | 3 | 4;
}

/** A ready-to-embed image stream. */
export interface Encoded {
  filter: "DCTDecode" | "FlateDecode";
  data: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
  bpc: number;
  /** Colour components of the target colour space (the Indexed base when `palette` is set). */
  components: 1 | 3 | 4;
  /** Indexed lookup table, `components` bytes per entry. */
  palette?: Uint8Array<ArrayBuffer>;
  /** Flate data is PNG-predicted (DecodeParms /Predictor 15). */
  predictor?: boolean;
}

/** Which colour space the encoded stream is written in. */
export type ColorTarget = "original" | "DeviceRGB" | "DeviceGray";

export interface Size {
  width: number;
  height: number;
}

/** A replacement to apply when saving. */
export interface Replacement {
  id: number;
  encoded: Encoded;
  target: ColorTarget;
  /** The encoded pixels cover only this part of the original image. */
  crop?: CropRect & { sourceWidth: number; sourceHeight: number };
}

export type SaveOptions = Omit<DocOptions, "mergeSimilar" | "similarity" | "cropToVisible"> & {
  /** [merged-away image, image that replaces it] pairs. */
  merges: [number, number][];
};
