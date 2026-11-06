/**
 * Writes the offline support files after a production build:
 *  - precache.json: every file the app needs, with sizes (drives the download progress bar);
 *  - sw.js: the service worker, stamped with a version derived from that list.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Plugin, ResolvedConfig } from "vite";

/** Files that are served but not part of the app itself. */
const SKIP = new Set(["sw.js", "precache.json", "_headers", "_redirects"]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

export function precache(): Plugin {
  let config: ResolvedConfig;
  return {
    name: "precache",
    apply: "build",
    configResolved(resolved) {
      config = resolved;
    },
    // closeBundle runs after the worker sub-builds have written their files too.
    closeBundle() {
      const outDir = config.build.outDir;
      const files = walk(outDir)
        .map((path) => ({ path: relative(outDir, path).split("\\").join("/"), size: statSync(path).size }))
        .filter((f) => !SKIP.has(f.path) && !f.path.endsWith(".map"))
        // index.html is requested as "./" (the page URL).
        .map((f) => ({ url: f.path === "index.html" ? "./" : f.path, size: f.size }))
        .sort((a, b) => a.url.localeCompare(b.url));

      const hash = createHash("sha256");
      for (const f of files) hash.update(`${f.url}:${f.size}\n`);
      hash.update(readFileSync(join(outDir, "index.html")));
      const version = hash.digest("hex").slice(0, 12);

      writeFileSync(join(outDir, "precache.json"), JSON.stringify({ version, files }, null, 2));
      const template = readFileSync(new URL("./sw.template.js", import.meta.url), "utf8");
      writeFileSync(join(outDir, "sw.js"), template.replace("__VERSION__", version));
    },
  };
}
