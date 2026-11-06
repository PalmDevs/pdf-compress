/** Makes the browser-oriented wasm codecs usable under `bun test`. */
import { readFileSync } from "node:fs";
import { init as initJpeg } from "@jsquash/jpeg/encode.js";
import { init as initOxipng } from "@jsquash/oxipng/optimise.js";
import { initResize } from "@jsquash/resize";
import initQuantizer from "libimagequant-wasm/wasm/libimagequant_wasm.js";

if (!("ImageData" in globalThis)) {
  class ImageDataPolyfill {
    readonly colorSpace = "srgb";
    constructor(
      readonly data: Uint8ClampedArray,
      readonly width: number,
      readonly height: number,
    ) {}
  }
  (globalThis as Record<string, unknown>).ImageData = ImageDataPolyfill;
}

const modules = new URL("../node_modules/", import.meta.url);
const wasm = (path: string) => readFileSync(new URL(path, modules));

await initJpeg({ wasmBinary: wasm("@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm") } as never);
await initOxipng(wasm("@jsquash/oxipng/codec/pkg/squoosh_oxipng_bg.wasm"));
await initResize(wasm("@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm"));
await initQuantizer({ module_or_path: wasm("libimagequant-wasm/dist/wasm/libimagequant_wasm_bg.wasm") });
