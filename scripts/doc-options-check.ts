/**
 * Checks that the document options leave rendering and text unchanged on real PDFs:
 * `bun scripts/doc-options-check.ts <dir>`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as mupdf from "mupdf";
import { DEFAULT_SAVE_OPTIONS, PdfSession } from "../src/lib/pdf-core";
import type { SaveOptions } from "../src/lib/types";

const dir = process.argv[2];
if (!dir) throw new Error("usage: bun scripts/doc-options-check.ts <dir>");

const variants: [string, Partial<SaveOptions>][] = [
  ["defaults", { subsetFonts: true, leftovers: true, cleanContent: true }],
  [
    "everything",
    {
      subsetFonts: true,
      leftovers: true,
      cleanContent: true,
      removeAttachments: true,
      removeJavaScript: true,
      removeAlternateImages: true,
      removeUnusedDestinations: true,
    },
  ],
];

function pages(bytes: Uint8Array) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  const out: { pixels: Uint8Array; text: string }[] = [];
  for (let p = 0; p < Math.min(4, doc.countPages()); p++) {
    const page = doc.loadPage(p);
    const pix = page.toPixmap(mupdf.Matrix.scale(0.5, 0.5), mupdf.ColorSpace.DeviceRGB);
    out.push({ pixels: new Uint8Array(pix.getPixels()), text: page.toStructuredText("preserve-whitespace").asText() });
    pix.destroy();
    page.destroy();
  }
  doc.destroy();
  return out;
}

let problems = 0;
for (const name of readdirSync(dir)
  .filter((n) => n.endsWith(".pdf"))
  .sort()) {
  const bytes = new Uint8Array(readFileSync(join(dir, name)));
  let session: PdfSession;
  let before: ReturnType<typeof pages>;
  try {
    session = new PdfSession(bytes);
    before = pages(bytes);
  } catch {
    continue;
  }
  const report: string[] = [];
  for (const [label, options] of variants) {
    try {
      const out = session.save([], { ...DEFAULT_SAVE_OPTIONS, ...options });
      const after = pages(out);
      const issues: string[] = [];
      before.forEach((b, i) => {
        const a = after[i];
        if (!a || a.pixels.length !== b.pixels.length) return issues.push(`p${i + 1} size`);
        let diff = 0;
        for (let k = 0; k < b.pixels.length; k++) diff += Math.abs(a.pixels[k] - b.pixels[k]);
        diff /= b.pixels.length;
        if (diff > 0.5) issues.push(`p${i + 1} pixels ${diff.toFixed(2)}`);
        if (a.text !== b.text) issues.push(`p${i + 1} text`);
      });
      report.push(
        `${label} ${Math.round((out.byteLength / bytes.byteLength) * 100)}%${issues.length ? " ISSUES " + issues.join(",") : ""}`,
      );
      problems += issues.length;
    } catch (err) {
      report.push(`${label} FAILED ${(err as Error).message}`);
      problems++;
    }
  }
  console.log(`${name}: ${report.join(" | ")}`);
  session.destroy();
}
console.log(problems ? `${problems} problems` : "No problems.");
