import solid from "@solidjs/vite-plugin";
import { defineConfig } from "vite";

// The wasm packages locate their .wasm files with `new URL(..., import.meta.url)`.
// Pre-bundling would break those relative URLs, so they are excluded.
const wasmPackages = ["mupdf", "@jsquash/jpeg", "@jsquash/resize", "@jsquash/oxipng", "libimagequant-wasm"];

export default defineConfig({
  plugins: [solid()],
  // mupdf uses top-level await, so workers and the build need modern ES output.
  worker: { format: "es" },
  build: { target: "es2022" },
  optimizeDeps: { exclude: wasmPackages },
  css: { modules: { localsConvention: "camelCaseOnly" } },
});
