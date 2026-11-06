/** Owns the open document. One instance; calls are served one at a time. */
import * as Comlink from "comlink";
import type { PdfSession } from "../lib/pdf-core";
import type {
  ColorMode,
  ColorTarget,
  CropRect,
  Encoded,
  ImageInfo,
  Pixels,
  Replacement,
  SaveOptions,
} from "../lib/types";

// mupdf.js loads its wasm with top-level await. Importing it statically would delay
// Comlink.expose until that finishes, and messages arriving earlier would be lost.
const core = import("../lib/pdf-core");

let session: PdfSession | null = null;

function current(): PdfSession {
  if (!session) throw new Error("No document open");
  return session;
}

function toBitmap(px: Pixels, maxSize?: number): Promise<ImageBitmap> {
  const image = new ImageData(px.data, px.width, px.height);
  const scale = maxSize ? Math.min(1, maxSize / Math.max(px.width, px.height)) : 1;
  if (scale === 1) return createImageBitmap(image);
  return createImageBitmap(image, {
    resizeWidth: Math.max(1, Math.round(px.width * scale)),
    resizeHeight: Math.max(1, Math.round(px.height * scale)),
    resizeQuality: "medium",
  });
}

const api = {
  async open(
    bytes: Uint8Array,
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ pageCount: number; images: ImageInfo[] }> {
    const { PdfSession } = await core;
    session?.destroy();
    session = null;
    const opened = new PdfSession(bytes);
    session = opened;
    const images = opened.scan(onProgress);
    return { pageCount: opened.pageCount, images };
  },

  async thumbnail(id: number, size: number): Promise<Blob> {
    const bitmap = await toBitmap(current().displayOriginal(id), size);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    bitmap.close();
    return canvas.convertToBlob({ type: "image/png" });
  },

  pixels(id: number, color: ColorMode, crop: CropRect | null): Pixels {
    const px = current().pixels(id, color, crop);
    return Comlink.transfer(px, [px.data.buffer]);
  },

  async cmykJpeg(px: Pixels, quality: number): Promise<Encoded> {
    const { encodeCmykJpeg } = await core;
    const encoded = encodeCmykJpeg(px, quality);
    return Comlink.transfer(encoded, [encoded.data.buffer]);
  },

  async previewOriginal(id: number): Promise<ImageBitmap> {
    const bitmap = await toBitmap(current().displayOriginal(id));
    return Comlink.transfer(bitmap, [bitmap]);
  },

  async previewEncoded(id: number, encoded: Encoded, target: ColorTarget): Promise<ImageBitmap> {
    const bitmap = await toBitmap(current().displayEncoded(id, encoded, target));
    return Comlink.transfer(bitmap, [bitmap]);
  },

  similarImages(
    ids: number[],
    minSimilarity: number,
    rawSizes: Record<number, number>,
    onProgress?: (done: number, total: number) => void,
  ): [number, number][] {
    return current().similarImages(ids, minSimilarity, rawSizes, onProgress);
  },

  save(replacements: Replacement[], options: SaveOptions): Uint8Array<ArrayBuffer> {
    const out = current().save(replacements, options);
    return Comlink.transfer(out, [out.buffer]);
  },
};

export type PdfApi = typeof api;

Comlink.expose(api);
