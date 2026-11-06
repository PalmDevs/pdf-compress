/** Resize + encode for one image. Runs inside the codec workers (and under `bun test`). */
import encodeJpeg from "@jsquash/jpeg/encode.js";
import optimisePng from "@jsquash/oxipng/optimise.js";
import resize from "@jsquash/resize";
import initQuantizer, { ImageQuantizer } from "libimagequant-wasm/wasm/libimagequant_wasm.js";
import { flateEncode, parsePng, pngToEncoded, unpackSamples } from "./flate";
import type { Encoded, Pixels, Settings, Size } from "./types";

/** MozJpegColorSpace.GRAYSCALE (a const enum, so it can't be imported at runtime). */
const MOZJPEG_GRAYSCALE = 1;

let quantizerReady: Promise<unknown> | undefined;

async function quantize(image: ImageData, colors: number, dither: number): Promise<ImageData> {
  quantizerReady ??= initQuantizer();
  await quantizerReady;
  const quantizer = new ImageQuantizer();
  try {
    quantizer.setMaxColors(colors);
    quantizer.setSpeed(4);
    quantizer.setQuality(0, 100);
    const result = quantizer.quantizeImage(image.data, image.width, image.height);
    try {
      result.setDithering(dither);
      const remapped = result.remapImage(image.data, image.width, image.height);
      return new ImageData(remapped, image.width, image.height);
    } finally {
      result.free();
    }
  } finally {
    quantizer.free();
  }
}

async function lossless(image: ImageData, channels: 1 | 3 | 4): Promise<Encoded> {
  if (channels !== 4) {
    // Every pixel is opaque, so OxiPNG reduces to gray, RGB or palette — all expressible in PDF.
    const png = await optimisePng(image, { level: 2, interlace: false, optimiseAlpha: false });
    const encoded = pngToEncoded(parsePng(new Uint8Array(png)), channels);
    if (encoded) return encoded;
  }
  return flateEncode(unpackSamples(image.data, channels), image.width, image.height, channels);
}

/** CMYK JPEG needs mupdf (MozJPEG here only takes RGBA), so it is handed back to the PDF worker. */
export type CodecResult = { encoded: Encoded } | { cmykJpeg: Pixels };

export async function encodeImage(px: Pixels, settings: Settings, target: Size): Promise<CodecResult> {
  let image = new ImageData(px.data, px.width, px.height);
  if (target.width < px.width || target.height < px.height) {
    image = await resize(image, {
      width: target.width,
      height: target.height,
      method: "lanczos3",
      fitMethod: "stretch",
      premultiply: false,
      // Only RGB/gray samples are gamma-encoded light; CMYK channels are not.
      linearRGB: px.channels !== 4,
    });
  }
  const { width, height } = image;

  switch (settings.mode) {
    case "jpeg": {
      if (px.channels === 4) {
        return { cmykJpeg: { data: image.data as Uint8ClampedArray<ArrayBuffer>, width, height, channels: 4 } };
      }
      const gray = px.channels === 1;
      const jpeg = await encodeJpeg(image, {
        quality: settings.quality,
        ...(gray ? { color_space: MOZJPEG_GRAYSCALE } : {}),
      });
      return {
        encoded: { filter: "DCTDecode", data: new Uint8Array(jpeg), width, height, bpc: 8, components: gray ? 1 : 3 },
      };
    }
    case "lossless":
      return { encoded: await lossless(image, px.channels) };
    case "palette":
      if (px.channels === 4) throw new Error("Palette mode needs RGB or gray input");
      return { encoded: await lossless(await quantize(image, settings.colors, settings.dither), px.channels) };
    default:
      throw new Error(`Nothing to encode for mode "${settings.mode}"`);
  }
}
