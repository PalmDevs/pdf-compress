/**
 * Runs the whole pipeline over a folder of PDFs with every non-trivial mode:
 * `bun scripts/corpus.ts <dir>`. Reports crashes, failed encodes and broken output.
 */
import "../test/setup";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as mupdf from "mupdf";
import { encodeImage } from "../src/lib/codec";
import { encodeCmykJpeg, PdfSession } from "../src/lib/pdf-core";
import { colorTarget, PRESETS, resolveSettings, targetSize } from "../src/lib/settings";
import type { Replacement, Settings } from "../src/lib/types";

const dir = process.argv[2];
if (!dir) throw new Error("usage: bun scripts/corpus.ts <dir>");

const medium = PRESETS.find((p) => p.id === "medium")!.settings;
const variants: [string, Settings][] = [
  ["medium", medium],
  ["lossless", { ...medium, mode: "lossless" }],
  ["palette", { ...medium, mode: "palette", colors: 64, color: "rgb" }],
  ["gray", { ...medium, color: "gray" }],
];

let failures = 0;
for (const name of readdirSync(dir)
  .filter((n) => n.endsWith(".pdf"))
  .sort()) {
  const bytes = readFileSync(join(dir, name));
  let session: PdfSession;
  try {
    session = new PdfSession(new Uint8Array(bytes));
  } catch (err) {
    console.log(`${name}: cannot open (${(err as Error).message})`);
    continue;
  }
  const images = session.scan();
  if (images.length === 0) {
    session.destroy();
    continue;
  }
  const summary: string[] = [];
  for (const [label, requested] of variants) {
    const replacements: Replacement[] = [];
    const errors: string[] = [];
    for (const info of images) {
      const { settings } = resolveSettings(info, requested);
      if (settings.mode === "keep") continue;
      try {
        const px = session.pixels(info.id, settings.color);
        const result = await encodeImage(px, settings, targetSize(info, settings));
        const encoded = "encoded" in result ? result.encoded : encodeCmykJpeg(result.cmykJpeg, settings.quality);
        if (encoded.data.byteLength + (encoded.palette?.byteLength ?? 0) < info.rawSize) {
          replacements.push({ id: info.id, encoded, target: colorTarget(settings.color) });
        }
        session.displayEncoded(info.id, encoded, colorTarget(settings.color));
      } catch (err) {
        errors.push(`#${info.id} ${info.format}/${info.colorSpace}: ${(err as Error).message}`);
      }
    }
    try {
      const out = session.save(replacements);
      const doc = mupdf.Document.openDocument(out, "application/pdf");
      for (let p = 0; p < Math.min(3, doc.countPages()); p++) {
        doc.loadPage(p).toPixmap(mupdf.Matrix.scale(0.2, 0.2), mupdf.ColorSpace.DeviceRGB).destroy();
      }
      doc.destroy();
      summary.push(`${label} ${replacements.length} repl → ${Math.round((out.byteLength / bytes.byteLength) * 100)}%`);
    } catch (err) {
      errors.push(`save/reopen: ${(err as Error).message}`);
    }
    if (errors.length) {
      failures += errors.length;
      console.log(`${name} [${label}] ERRORS:\n  ${errors.join("\n  ")}`);
    }
  }
  const kinds = [...new Set(images.map((i) => `${i.format}/${i.colorSpace}`))].join(", ");
  console.log(`${name}: ${images.length} images (${kinds}) | ${summary.join(" | ")}`);
  session.destroy();
}
console.log(failures ? `${failures} failures` : "No failures.");
