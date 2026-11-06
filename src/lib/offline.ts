/**
 * Offline support. The page downloads every app file listed in precache.json into
 * Cache Storage itself (so it can report progress), and sw.js serves them from there.
 */

interface Manifest {
  version: string;
  files: { url: string; size: number }[];
}

export type OfflineResult =
  /** Every file is cached and the service worker is active. */
  | { offline: true }
  /** Not available here (development server, unsupported browser, insecure origin). */
  | { offline: false; reason: string };

const CACHE_PREFIX = "pdf-image-compress-";
const PARALLEL_DOWNLOADS = 4;

async function download(cache: Cache, url: string, onBytes: (n: number) => void): Promise<void> {
  // Default cache mode: the download also fills the HTTP cache, so the workers'
  // own requests for these files (before the service worker takes over) are free.
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as Uint8Array<ArrayBuffer>);
    onBytes(value.byteLength);
  }
  // The body is already decoded, so encoding/length headers must not be copied over.
  const headers = new Headers();
  const type = response.headers.get("Content-Type");
  if (type) headers.set("Content-Type", type);
  await cache.put(url, new Response(new Blob(chunks), { headers }));
}

/**
 * Makes sure the app is cached for offline use, reporting download progress in bytes.
 * Resolves quickly when everything is already cached.
 */
export async function prepareOffline(onProgress: (done: number, total: number) => void): Promise<OfflineResult> {
  if (import.meta.env.DEV) return { offline: false, reason: "Offline use is only set up in production builds." };
  if (!("serviceWorker" in navigator) || !("caches" in window)) {
    return { offline: false, reason: "This browser can't store the app for offline use." };
  }

  const registration = navigator.serviceWorker.register(new URL("sw.js", document.baseURI), { scope: "./" });

  const hasCachedApp = async () =>
    !!navigator.serviceWorker.controller && (await caches.keys()).some((k) => k.startsWith(CACHE_PREFIX));
  // Known to be offline: don't even try to check for updates.
  if (!navigator.onLine && (await hasCachedApp())) return { offline: true };

  let manifest: Manifest;
  try {
    const response = await fetch(new URL("precache.json", document.baseURI), { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    manifest = (await response.json()) as Manifest;
  } catch (err) {
    // Offline: fine as long as a previous visit cached the app.
    if (await hasCachedApp()) return { offline: true };
    throw new Error(`Could not check the app files: ${err instanceof Error ? err.message : String(err)}`);
  }

  const name = CACHE_PREFIX + manifest.version;
  const cache = await caches.open(name);
  const total = manifest.files.reduce((sum, f) => sum + f.size, 0);
  let done = 0;
  const missing: Manifest["files"] = [];
  for (const file of manifest.files) {
    if (await cache.match(file.url)) done += file.size;
    else missing.push(file);
  }
  onProgress(done, total);

  // A few downloads at a time; each file's bytes count as they arrive.
  const queue = [...missing];
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL_DOWNLOADS, queue.length) }, async () => {
      for (let file = queue.shift(); file; file = queue.shift()) {
        let received = 0;
        await download(cache, file.url, (n) => {
          received += n;
          done += n;
          onProgress(Math.min(done, total), total);
        });
        // Compressed vs. listed sizes can differ slightly; settle on the listed size.
        done += file.size - received;
        onProgress(Math.min(done, total), total);
      }
    }),
  );

  // Older versions are no longer needed.
  for (const key of await caches.keys()) {
    if (key.startsWith(CACHE_PREFIX) && key !== name) await caches.delete(key);
  }
  await registration;
  await navigator.serviceWorker.ready;
  return { offline: true };
}
