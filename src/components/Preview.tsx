import { createEffect, createMemo, createSignal, Errored, Loading, Show, useContext } from "solid-js";
import { EngineContext } from "../context";
import type { Row } from "../lib/engine";
import { formatBytes, formatPages } from "../lib/format";
import { ResultCell } from "./ImageTable";
import styles from "./Preview.module.css";
import { Select } from "./Select";
import { SettingsFields } from "./SettingsFields";

type Zoom = "fit" | "actual";

function BitmapCanvas(props: { bitmap: ImageBitmap; width: number | null }) {
  let canvas!: HTMLCanvasElement;
  createEffect(
    () => props.bitmap,
    (bitmap) => {
      if (bitmap.width > 0) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
      }
      return () => bitmap.close();
    },
  );
  return (
    <canvas
      ref={canvas}
      class={[styles.canvas, { [styles.fit]: props.width === null }]}
      style={props.width === null ? undefined : { width: `${props.width}px` }}
    />
  );
}

function PreviewBody(props: { row: Row }) {
  const engine = useContext(EngineContext);
  const [zoom, setZoom] = createSignal<Zoom>("fit");
  const id = () => props.row.info.id;

  const original = createMemo(() => engine.pdf.previewOriginal(id()));
  const compressed = createMemo(() => {
    if (!props.row.resultKey) return null;
    const result = engine.result(id());
    return result ? engine.pdf.previewEncoded(id(), result.encoded, result.target) : null;
  });

  // Both panes are drawn at the original's width so downsampling shows as it will on the page.
  const displayWidth = () => (zoom() === "actual" ? props.row.info.width : null);

  const panes: HTMLDivElement[] = [];
  let syncing = false;
  const syncScroll = (from: HTMLDivElement) => {
    if (syncing) return;
    syncing = true;
    for (const pane of panes) {
      if (pane === from) continue;
      pane.scrollTop = from.scrollTop;
      pane.scrollLeft = from.scrollLeft;
    }
    syncing = false;
  };
  const pane = (el: HTMLDivElement) => {
    panes.push(el);
  };

  const info = () => props.row.info;

  return (
    <div class={styles.preview}>
      <div class={styles.header}>
        <h2 class={styles.title}>Image #{info().id}</h2>
        <button type="button" onClick={() => engine.select(null)} aria-label="Close preview">
          Close
        </button>
      </div>

      <dl class={styles.details}>
        <dt>Pixels</dt>
        <dd>
          {info().width}×{info().height}, {info().bpc} bit
        </dd>
        <dt>Stored as</dt>
        <dd>
          {info().format}, {info().colorSpace}
          {info().hasSoftMask ? " (has a transparency mask, kept as is)" : ""}
        </dd>
        <dt>Size</dt>
        <dd>{formatBytes(info().rawSize)}</dd>
        <dt>Pages</dt>
        <dd>{formatPages(info().pages)}</dd>
        <dt>Effective DPI</dt>
        <dd>{info().dpi ?? "not drawn on any page"}</dd>
        <dt>Result</dt>
        <dd>
          <ResultCell row={props.row} />
          <Show when={props.row.error}>{(error) => <div class={styles.bad}>{error()}</div>}</Show>
        </dd>
      </dl>

      <Show
        when={!info().lockedReason && props.row.mergedInto === null}
        fallback={
          <p class={styles.bad}>
            {props.row.mergedInto !== null
              ? `Merged: pages use image #${props.row.mergedInto} instead.`
              : `Left as is: ${info().lockedReason}`}
          </p>
        }
      >
        <div class={styles.settings}>
          <label class={styles.checkbox}>
            <input
              type="checkbox"
              checked={props.row.custom === null}
              onChange={(e) => engine.setCustom(id(), e.currentTarget.checked ? null : { ...engine.state.preset })}
            />
            Follow preset
          </label>
          <SettingsFields value={props.row.custom ?? engine.state.preset} onChange={(s) => engine.setCustom(id(), s)} />
          <Show when={props.row.note}>{(note) => <p class={styles.bad}>{note()}</p>}</Show>
        </div>
      </Show>

      <div class={styles.compareHeader}>
        <span>Original ({formatBytes(info().rawSize)})</span>
        <Select
          label="Zoom"
          value={zoom()}
          options={[
            { value: "fit", label: "Fit" },
            { value: "actual", label: "100%" },
          ]}
          onChange={setZoom}
        />
        <span>
          Compressed{props.row.cropped ? ", cropped" : ""}
          <Show when={props.row.status === "done" && props.row.newSize !== null}>
            {" "}
            ({formatBytes(props.row.newSize!)})
          </Show>
        </span>
      </div>
      <div class={styles.compare}>
        <div class={styles.pane} ref={pane} onScroll={(e) => syncScroll(e.currentTarget)}>
          <Errored fallback={(err) => <p class={styles.bad}>Preview failed: {String(err())}</p>}>
            <Loading fallback={<p class={styles.muted}>Decoding…</p>}>
              <BitmapCanvas bitmap={original()} width={displayWidth()} />
            </Loading>
          </Errored>
        </div>
        <div class={styles.pane} ref={pane} onScroll={(e) => syncScroll(e.currentTarget)}>
          <Errored fallback={(err) => <p class={styles.bad}>Preview failed: {String(err())}</p>}>
            <Loading fallback={<p class={styles.muted}>Decoding…</p>}>
              <Show
                when={compressed()}
                fallback={
                  <p class={styles.muted}>
                    {props.row.status === "kept"
                      ? "Unchanged"
                      : props.row.status === "merged"
                        ? `Replaced by image #${props.row.mergedInto}`
                        : props.row.status === "error"
                          ? "—"
                          : "Encoding…"}
                  </p>
                }
              >
                {(bitmap) => <BitmapCanvas bitmap={bitmap()} width={displayWidth()} />}
              </Show>
            </Loading>
          </Errored>
        </div>
      </div>
    </div>
  );
}

export function Preview() {
  const engine = useContext(EngineContext);
  const row = createMemo(() => engine.state.rows.find((r) => r.info.id === engine.state.selected) ?? null);
  return <Show when={row()}>{(r) => <PreviewBody row={r()} />}</Show>;
}
