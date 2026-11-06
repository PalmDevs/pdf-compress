import type { ColorTarget, CropRect, DocOptions, ImageInfo, Settings, Size, UnitRect } from "./types";

export interface Preset {
  id: string;
  label: string;
  settings: Settings;
}

const base: Settings = { mode: "jpeg", quality: 75, colors: 256, dither: 1, maxDpi: 0, color: "keep" };

export const PRESETS: Preset[] = [
  { id: "original", label: "Original (no changes)", settings: { ...base, mode: "keep" } },
  { id: "lossless", label: "Lossless", settings: { ...base, mode: "lossless" } },
  { id: "high", label: "High — JPEG 85, 300 DPI", settings: { ...base, quality: 85, maxDpi: 300 } },
  { id: "medium", label: "Medium — JPEG 72, 200 DPI", settings: { ...base, quality: 72, maxDpi: 200 } },
  { id: "low", label: "Low — JPEG 55, 150 DPI", settings: { ...base, quality: 55, maxDpi: 150 } },
  { id: "minimum", label: "Minimum — JPEG 40, 96 DPI", settings: { ...base, quality: 40, maxDpi: 96 } },
];

export const DEFAULT_PRESET = PRESETS.find((p) => p.id === "medium")!;

export const MODE_LABELS: Record<Settings["mode"], string> = {
  keep: "Keep",
  jpeg: "JPEG",
  lossless: "Lossless",
  palette: "Palette",
};

export const COLOR_LABELS: Record<Settings["color"], string> = {
  keep: "Keep colours",
  rgb: "Convert to RGB",
  gray: "Grayscale",
};

export function sameSettings(a: Settings, b: Settings): boolean {
  return (
    a.mode === b.mode &&
    a.quality === b.quality &&
    a.colors === b.colors &&
    a.dither === b.dither &&
    a.maxDpi === b.maxDpi &&
    a.color === b.color
  );
}

export function presetFor(settings: Settings): Preset | undefined {
  return PRESETS.find((p) => sameSettings(p.settings, settings));
}

/** Samples per pixel the encoder will receive for this colour choice. */
export function outputChannels(info: ImageInfo, color: Settings["color"]): number {
  if (color === "rgb") return 3;
  if (color === "gray") return 1;
  return info.channels;
}

export function colorTarget(color: Settings["color"]): ColorTarget {
  if (color === "rgb") return "DeviceRGB";
  if (color === "gray") return "DeviceGray";
  return "original";
}

export interface Resolved {
  /** Settings that will actually be used; `mode` is "keep" when the request can't be honoured. */
  settings: Settings;
  /** Why the requested settings were overridden, if they were. */
  note: string | null;
}

/** Applies per-image constraints to the requested settings. */
export function resolveSettings(info: ImageInfo, requested: Settings): Resolved {
  const keep = (note: string | null): Resolved => ({ settings: { ...requested, mode: "keep" }, note });

  if (requested.mode === "keep") return keep(null);
  if (info.lockedReason) return keep(info.lockedReason);

  if (requested.color === "keep") {
    if (info.colorKind === "lab") return keep("Lab colour can't be kept; choose RGB or Grayscale");
    if (![1, 3, 4].includes(info.channels)) {
      return keep(`${info.channels}-channel colour can't be kept; choose RGB or Grayscale`);
    }
  }
  const channels = outputChannels(info, requested.color);
  if (requested.mode === "palette" && channels === 4) {
    return keep("Palette needs RGB or Grayscale colour");
  }
  return { settings: requested, note: null };
}

/** Pixel size after cropping and applying the DPI limit. Never upscales. */
export function targetSize(info: ImageInfo, settings: Settings, crop: CropRect | null = null): Size {
  const { width, height } = crop ?? info;
  if (!settings.maxDpi || !info.dpi || info.dpi <= settings.maxDpi) return { width, height };
  const scale = settings.maxDpi / info.dpi;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Cropping only pays off when it removes a meaningful part of the image. */
const MIN_CROP_SAVING = 0.1;

/** Pixel rectangle covering `visible` (with a 1 px margin), or null when not worth cropping. */
export function cropRect(info: ImageInfo, visible: UnitRect | null): CropRect | null {
  if (!visible) return null;
  const x0 = Math.max(0, Math.floor(visible[0] * info.width) - 1);
  const y0 = Math.max(0, Math.floor(visible[1] * info.height) - 1);
  const x1 = Math.min(info.width, Math.ceil(visible[2] * info.width) + 1);
  const y1 = Math.min(info.height, Math.ceil(visible[3] * info.height) + 1);
  if (x1 <= x0 || y1 <= y0) return null;
  const kept = ((x1 - x0) * (y1 - y0)) / (info.width * info.height);
  return kept > 1 - MIN_CROP_SAVING ? null : { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Cache key for an encode: everything that affects the output bytes. */
export function encodeKey(info: ImageInfo, s: Settings, crop: CropRect | null = null): string {
  const size = targetSize(info, s, crop);
  const parts: (string | number)[] = [info.id, s.mode, s.color, size.width, size.height];
  if (crop) parts.push(`crop:${crop.x},${crop.y},${crop.width},${crop.height}`);
  if (s.mode === "jpeg") parts.push(s.quality);
  if (s.mode === "palette") parts.push(s.colors, s.dither);
  return parts.join("|");
}

export function clampSettings(s: Settings): Settings {
  const clamp = (v: number, lo: number, hi: number, fallback: number) =>
    Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
  return {
    ...s,
    quality: Math.round(clamp(s.quality, 1, 100, 75)),
    colors: Math.round(clamp(s.colors, 2, 256, 256)),
    dither: clamp(s.dither, 0, 1, 1),
    maxDpi: Math.round(clamp(s.maxDpi, 0, 2400, 0)),
  };
}

export const DEFAULT_DOC_OPTIONS: DocOptions = {
  subsetFonts: true,
  leftovers: true,
  cleanContent: true,
  mergeSimilar: false,
  similarity: 98,
  cropToVisible: false,
  removeAttachments: false,
  removeJavaScript: false,
  removeAlternateImages: false,
  removeUnusedDestinations: false,
};
