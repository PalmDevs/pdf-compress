import * as Comlink from "comlink";
import { createStore, flush, snapshot } from "solid-js";
import type { PdfApi } from "../workers/pdf.worker";
import { AbortedError, CodecPool } from "./pool";
import {
  colorTarget,
  cropRect,
  DEFAULT_DOC_OPTIONS,
  DEFAULT_PRESET,
  encodeKey,
  resolveSettings,
  targetSize,
} from "./settings";
import type {
  ColorTarget,
  CropRect,
  DocOptions,
  Encoded,
  ImageInfo,
  Replacement,
  SaveOptions,
  Settings,
  UnitRect,
} from "./types";

export type RowStatus = "kept" | "queued" | "working" | "done" | "error" | "merged";

export interface Row {
  info: ImageInfo;
  /** Per-image settings; null follows the preset. */
  custom: Settings | null;
  thumb: string | null;
  status: RowStatus;
  /** Why requested settings were overridden (e.g. colour space can't be kept). */
  note: string | null;
  error: string | null;
  /** Bytes the replacement stream would take, including an inline palette. */
  newSize: number | null;
  newWidth: number | null;
  newHeight: number | null;
  /** Identifies the encode currently shown; changes whenever the result does. */
  resultKey: string | null;
  /** Set when "merge similar images" replaces this image with another one. */
  mergedInto: number | null;
  /** How many other images are replaced by this one. */
  mergedCount: number;
  /** The current result is cropped to the visible area. */
  cropped: boolean;
}

export interface FileState {
  name: string;
  size: number;
  pageCount: number;
}

export interface State {
  file: FileState | null;
  /** Progress text while opening. */
  progress: string | null;
  error: string | null;
  preset: Settings;
  doc: DocOptions;
  /** Progress text while comparing images for merging. */
  comparing: string | null;
  rows: Row[];
  selected: number | null;
  saving: boolean;
  saved: { size: number; replaced: number } | null;
}

export interface EncodedResult {
  encoded: Encoded;
  target: ColorTarget;
  crop?: Replacement["crop"];
}

/** How many previous encodes to keep per image, so toggling settings back is instant. */
const CACHE_PER_IMAGE = 4;

export function encodedSize(e: Encoded): number {
  return e.data.byteLength + (e.palette?.byteLength ?? 0);
}

/** A replacement is only used when it is actually smaller than the original stream. */
export function isReplacement(row: Row): boolean {
  return row.status === "done" && row.newSize !== null && row.newSize < row.info.rawSize;
}

/** Writes fields leaf by leaf, so only readers of changed fields re-run. */
function assignLeaves<T extends object>(target: T, source: Partial<T>) {
  for (const key of Object.keys(source) as (keyof T)[]) {
    if (source[key] !== undefined && target[key] !== source[key]) target[key] = source[key]!;
  }
}

function unionRects(a: UnitRect, b: UnitRect): UnitRect {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

export function createEngine() {
  const pdfWorker = new Worker(new URL("../workers/pdf.worker.ts", import.meta.url), { type: "module" });
  const pdf = Comlink.wrap<PdfApi>(pdfWorker);
  const poolSize = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
  const pool = new CodecPool(poolSize);

  const [state, setState] = createStore<State>({
    file: null,
    progress: null,
    error: null,
    preset: { ...DEFAULT_PRESET.settings },
    doc: { ...DEFAULT_DOC_OPTIONS },
    comparing: null,
    rows: [],
    selected: null,
    saving: false,
    saved: null,
  });

  // Non-reactive bookkeeping.
  let generation = 0;
  const indexById = new Map<number, number>();
  const jobs = new Map<number, { key: string; controller: AbortController }>();
  const cache = new Map<number, Map<string, EncodedResult>>();
  const current = new Map<number, string>();
  /** merged-away image → image that replaces it */
  let merges = new Map<number, number>();
  let mergeToken = 0;
  let idleWaiters: (() => void)[] = [];

  function updateRow(id: number, fn: (row: Row) => void) {
    const index = indexById.get(id);
    if (index === undefined) return;
    setState((s) => {
      fn(s.rows[index]);
    });
  }

  function notifyIdle() {
    if (jobs.size > 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const w of waiters) w();
  }

  function whenIdle(): Promise<void> {
    if (jobs.size === 0) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
  }

  function cancel(id: number) {
    jobs.get(id)?.controller.abort();
    jobs.delete(id);
  }

  function remember(id: number, key: string, result: EncodedResult) {
    let perImage = cache.get(id);
    if (!perImage) cache.set(id, (perImage = new Map()));
    perImage.delete(key);
    perImage.set(key, result);
    while (perImage.size > CACHE_PER_IMAGE) perImage.delete(perImage.keys().next().value!);
  }

  function showResult(id: number, key: string, result: EncodedResult) {
    current.set(id, key);
    updateRow(id, (row) => {
      row.status = "done";
      row.error = null;
      row.newSize = encodedSize(result.encoded);
      row.newWidth = result.encoded.width;
      row.newHeight = result.encoded.height;
      row.resultKey = key;
      row.cropped = !!result.crop;
    });
  }

  async function run(
    info: ImageInfo,
    key: string,
    settings: Settings,
    crop: CropRect | null,
    signal: AbortSignal,
    gen: number,
  ) {
    try {
      const encoded = await pool.run(signal, async (codec) => {
        if (signal.aborted || gen !== generation) throw new AbortedError();
        updateRow(info.id, (row) => {
          row.status = "working";
        });
        const px = await pdf.pixels(info.id, settings.color, crop);
        if (signal.aborted) throw new AbortedError();
        const result = await codec.encode(
          Comlink.transfer(px, [px.data.buffer]),
          settings,
          targetSize(info, settings, crop),
        );
        if ("cmykJpeg" in result) {
          return pdf.cmykJpeg(Comlink.transfer(result.cmykJpeg, [result.cmykJpeg.data.buffer]), settings.quality);
        }
        return result.encoded;
      });
      if (gen !== generation || jobs.get(info.id)?.key !== key) return;
      jobs.delete(info.id);
      const result: EncodedResult = {
        encoded,
        target: colorTarget(settings.color),
        crop: crop ? { ...crop, sourceWidth: info.width, sourceHeight: info.height } : undefined,
      };
      remember(info.id, key, result);
      showResult(info.id, key, result);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      if (gen !== generation || jobs.get(info.id)?.key !== key) return;
      jobs.delete(info.id);
      console.error(`Encoding image ${info.id} failed:`, err);
      updateRow(info.id, (row) => {
        row.status = "error";
        row.error = err instanceof Error ? err.message : String(err);
        row.resultKey = null;
      });
    } finally {
      notifyIdle();
    }
  }

  /**
   * The image as the encoder should see it: an image that replaces merged copies
   * must cover their placements too (lowest DPI, union of visible areas).
   */
  function effectiveInfo(row: Row): ImageInfo {
    // Plain copies: store proxies can't be posted to workers.
    const info = snapshot(row.info) as ImageInfo;
    const members = state.rows.filter((r) => merges.get(r.info.id) === info.id).map((r) => r.info);
    let { dpi, visible } = info;
    for (const m of members) {
      if (m.dpi !== null) dpi = Math.min(dpi ?? Infinity, Math.round((m.dpi * info.width) / m.width));
      if (m.pages.length === 0) continue; // never drawn: doesn't affect what's visible
      visible = visible && m.visible ? unionRects(visible, m.visible) : null;
    }
    return { ...info, dpi, visible: info.pages.length === 0 && members.length ? null : visible };
  }

  /** Brings one image's result in line with its current settings. */
  function ensure(row: Row) {
    const info = effectiveInfo(row);
    const id = info.id;

    const mergedInto = merges.get(id) ?? null;
    if (mergedInto !== null) {
      cancel(id);
      current.delete(id);
      updateRow(id, (r) => {
        r.status = "merged";
        r.note = null;
        r.error = null;
        r.newSize = r.newWidth = r.newHeight = null;
        r.resultKey = null;
        r.cropped = false;
      });
      notifyIdle();
      return;
    }

    const { settings, note } = resolveSettings(info, { ...(snapshot(row.custom ?? state.preset) as Settings) });
    if (settings.mode === "keep") {
      cancel(id);
      current.delete(id);
      updateRow(id, (r) => {
        r.status = "kept";
        r.note = note;
        r.error = null;
        r.newSize = r.newWidth = r.newHeight = null;
        r.resultKey = null;
        r.cropped = false;
      });
      notifyIdle();
      return;
    }

    const crop = state.doc.cropToVisible ? cropRect(info, info.visible) : null;
    const key = encodeKey(info, settings, crop);
    const cached = cache.get(id)?.get(key);
    if (cached) {
      cancel(id);
      updateRow(id, (r) => {
        r.note = note;
      });
      showResult(id, key, cached);
      notifyIdle();
      return;
    }
    if (jobs.get(id)?.key === key) return;

    cancel(id);
    const controller = new AbortController();
    jobs.set(id, { key, controller });
    updateRow(id, (r) => {
      r.status = "queued";
      r.note = note;
      r.error = null;
    });
    void run(info, key, settings, crop, controller.signal, generation);
  }

  function ensureAll() {
    flush();
    for (const row of state.rows) ensure(row);
  }

  function reset() {
    generation++;
    for (const id of [...jobs.keys()]) cancel(id);
    notifyIdle();
    for (const row of state.rows) if (row.thumb) URL.revokeObjectURL(row.thumb);
    indexById.clear();
    cache.clear();
    current.clear();
    merges = new Map();
    mergeToken++;
  }

  async function loadThumbnails(gen: number) {
    for (const row of state.rows) {
      if (gen !== generation) return;
      try {
        const blob = await pdf.thumbnail(row.info.id, 96);
        if (gen !== generation) return;
        const url = URL.createObjectURL(blob);
        updateRow(row.info.id, (r) => {
          r.thumb = url;
        });
      } catch (err) {
        console.warn(`Thumbnail for image ${row.info.id} failed:`, err);
      }
    }
  }

  async function open(file: File) {
    reset();
    const gen = generation;
    setState((s) => {
      s.file = null;
      s.rows = [];
      s.selected = null;
      s.error = null;
      s.saved = null;
      s.progress = "Reading file…";
    });
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Progress messages can arrive after open() resolves; ignore those.
      let scanning = true;
      const onProgress = Comlink.proxy((done: number, total: number) => {
        if (gen !== generation || !scanning) return;
        setState((s) => {
          s.progress = `Scanning pages… ${done} / ${total}`;
        });
      });
      const { pageCount, images } = await pdf.open(Comlink.transfer(bytes, [bytes.buffer]), onProgress).finally(() => {
        scanning = false;
      });
      if (gen !== generation) return;

      images.forEach((info, i) => indexById.set(info.id, i));
      setState((s) => {
        s.file = { name: file.name, size: file.size, pageCount };
        s.progress = null;
        s.rows = images.map((info): Row => ({
          info,
          custom: null,
          thumb: null,
          status: "queued",
          note: null,
          error: null,
          newSize: null,
          newWidth: null,
          newHeight: null,
          resultKey: null,
          mergedInto: null,
          mergedCount: 0,
          cropped: false,
        }));
      });
      ensureAll();
      void loadThumbnails(gen);
      if (state.doc.mergeSimilar) void updateMerges();
    } catch (err) {
      if (gen !== generation) return;
      console.error(err);
      setState((s) => {
        s.progress = null;
        s.error = `Could not open "${file.name}": ${err instanceof Error ? err.message : String(err)}`;
      });
    }
  }

  function setPreset(settings: Settings) {
    setState((s) => {
      assignLeaves(s.preset, settings);
      s.saved = null;
    });
    ensureAll();
  }

  function setCustom(id: number, settings: Settings | null) {
    updateRow(id, (row) => {
      if (settings && row.custom) assignLeaves(row.custom, settings);
      else row.custom = settings ? { ...settings } : null;
    });
    setState((s) => {
      s.saved = null;
    });
    flush();
    const index = indexById.get(id);
    if (index !== undefined) ensure(state.rows[index]);
  }

  /** Applies settings to every image, dropping per-image overrides. */
  function applyToAll(settings: Settings) {
    setState((s) => {
      assignLeaves(s.preset, settings);
      for (const row of s.rows) row.custom = null;
      s.saved = null;
    });
    ensureAll();
  }

  function applyMerges(pairs: [number, number][]) {
    merges = new Map(pairs);
    const counts = new Map<number, number>();
    for (const target of merges.values()) counts.set(target, (counts.get(target) ?? 0) + 1);
    setState((s) => {
      for (const row of s.rows) {
        row.mergedInto = merges.get(row.info.id) ?? null;
        row.mergedCount = counts.get(row.info.id) ?? 0;
      }
    });
    ensureAll();
  }

  /** Recomputes which images are merged, from the current options. */
  async function updateMerges() {
    const token = ++mergeToken;
    if (!state.doc.mergeSimilar || !state.file) {
      applyMerges([]);
      return;
    }
    const candidates = state.rows.filter((r) => r.info.mergeable).map((r) => r.info);
    const rawSizes = Object.fromEntries(candidates.map((i) => [i.id, i.rawSize]));
    const onProgress = Comlink.proxy((done: number, total: number) => {
      if (token !== mergeToken) return;
      setState((s) => {
        s.comparing = done < total ? `Comparing images… ${done} / ${total}` : null;
      });
    });
    try {
      const pairs = await pdf.similarImages(
        candidates.map((i) => i.id),
        state.doc.similarity,
        rawSizes,
        onProgress,
      );
      if (token !== mergeToken) return;
      applyMerges(pairs);
    } catch (err) {
      console.error(err);
      if (token === mergeToken) {
        setState((s) => {
          s.error = `Comparing images failed: ${err instanceof Error ? err.message : String(err)}`;
        });
      }
    } finally {
      if (token === mergeToken) {
        setState((s) => {
          s.comparing = null;
        });
      }
    }
  }

  function setDocOptions(patch: Partial<DocOptions>) {
    setState((s) => {
      assignLeaves(s.doc, patch);
      s.saved = null;
    });
    flush();
    if ("mergeSimilar" in patch || "similarity" in patch) void updateMerges();
    else if ("cropToVisible" in patch) ensureAll();
  }

  function select(id: number | null) {
    setState((s) => {
      s.selected = id;
    });
  }

  function result(id: number): EncodedResult | null {
    const key = current.get(id);
    return (key && cache.get(id)?.get(key)) || null;
  }

  async function save() {
    const file = state.file;
    if (!file || state.saving) return;
    const gen = generation;
    setState((s) => {
      s.saving = true;
      s.error = null;
    });
    try {
      await whenIdle();
      flush();
      if (gen !== generation) return;
      const replacements: Replacement[] = state.rows
        .filter(isReplacement)
        .map((row) => ({ id: row.info.id, ...result(row.info.id)! }))
        .filter((r) => r.encoded);
      const doc = state.doc;
      const options: SaveOptions = {
        subsetFonts: doc.subsetFonts,
        leftovers: doc.leftovers,
        cleanContent: doc.cleanContent,
        removeAttachments: doc.removeAttachments,
        removeJavaScript: doc.removeJavaScript,
        removeAlternateImages: doc.removeAlternateImages,
        removeUnusedDestinations: doc.removeUnusedDestinations,
        merges: doc.mergeSimilar ? [...merges] : [],
      };
      const out = await pdf.save(replacements, options);
      if (gen !== generation) return;

      const url = URL.createObjectURL(new Blob([out], { type: "application/pdf" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = file.name.replace(/\.pdf$/i, "") + "-compressed.pdf";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setState((s) => {
        s.saved = { size: out.byteLength, replaced: replacements.length };
      });
    } catch (err) {
      console.error(err);
      setState((s) => {
        s.error = `Saving failed: ${err instanceof Error ? err.message : String(err)}`;
      });
    } finally {
      setState((s) => {
        s.saving = false;
      });
    }
  }

  return { state, pdf, open, setPreset, setCustom, applyToAll, setDocOptions, select, result, save };
}

export type Engine = ReturnType<typeof createEngine>;
