import { For, Match, Show, Switch, useContext } from "solid-js";
import { EngineContext } from "../context";
import { isReplacement, type Row } from "../lib/engine";
import { formatBytes, formatChange, formatPages } from "../lib/format";
import styles from "./ImageTable.module.css";
import { SettingsFields } from "./SettingsFields";

/** Must match the breakpoint in App.module.css where the preview becomes a bottom sheet. */
const SHEET_LAYOUT = "(max-width: 1200px)";

export function ResultCell(props: { row: Row }) {
  return (
    <Switch>
      <Match when={props.row.status === "kept"}>
        <span class={styles.muted}>Unchanged</span>
      </Match>
      <Match when={props.row.status === "merged"}>
        <span class={styles.good} title="Removed: pages show the similar image instead">
          Merged into #{props.row.mergedInto}
        </span>
      </Match>
      <Match when={props.row.status === "queued"}>
        <span class={styles.muted}>Queued</span>
      </Match>
      <Match when={props.row.status === "working"}>
        <span class={styles.muted}>Encoding…</span>
      </Match>
      <Match when={props.row.status === "error"}>
        <span class={styles.bad} title={props.row.error ?? undefined}>
          Failed
        </span>
      </Match>
      <Match when={props.row.status === "done"}>
        <Show
          when={isReplacement(props.row)}
          fallback={
            <span class={styles.muted} title="The re-encoded image was larger, so the original is kept">
              {formatBytes(props.row.newSize!)}
              <br />
              larger, original kept
            </span>
          }
        >
          <span>
            {formatBytes(props.row.newSize!)}{" "}
            <span class={styles.good}>{formatChange(props.row.info.rawSize, props.row.newSize!)}</span>
          </span>
        </Show>
      </Match>
    </Switch>
  );
}

export function ImageTable() {
  const engine = useContext(EngineContext);
  const state = engine.state;

  return (
    <table class={styles.table}>
      <thead>
        <tr>
          <th />
          <th>Object</th>
          <th>Pixels</th>
          <th title="Lowest effective resolution where the image is drawn">DPI</th>
          <th>Stored as</th>
          <th class={styles.num}>Size</th>
          <th>Settings</th>
          <th>Result</th>
        </tr>
      </thead>
      <tbody>
        <For each={state.rows}>
          {(row) => (
            <tr
              class={[styles.row, { [styles.selected]: state.selected === row.info.id }]}
              onClick={(e) => {
                const opening = state.selected !== row.info.id;
                engine.select(opening ? row.info.id : null);
                // Narrow layout: keep the tapped row visible above the preview sheet.
                const tr = e.currentTarget;
                if (opening && matchMedia(SHEET_LAYOUT).matches) {
                  requestAnimationFrame(() => tr.scrollIntoView({ block: "nearest", behavior: "smooth" }));
                }
              }}
            >
              <td class={styles.thumbCell}>
                <Show when={row.thumb} fallback={<div class={styles.thumbPlaceholder} />}>
                  {(src) => <img class={styles.thumb} src={src()} alt="" />}
                </Show>
              </td>
              <td class={styles.nowrap}>
                #{row.info.id}
                <div class={styles.muted} title="Pages the image is drawn on">
                  {row.info.pages.length ? `p. ${formatPages(row.info.pages)}` : "not drawn"}
                </div>
                <Show when={row.mergedCount > 0}>
                  <div class={styles.muted} title="Similar images replaced by this one">
                    +{row.mergedCount} merged
                  </div>
                </Show>
              </td>
              <td class={styles.nowrap}>
                {row.info.width}×{row.info.height}
                <Show when={row.newWidth !== null && (row.newWidth !== row.info.width || row.cropped)}>
                  <div class={styles.muted}>
                    → {row.newWidth}×{row.newHeight}
                    {row.cropped ? " cropped" : ""}
                  </div>
                </Show>
              </td>
              <td>{row.info.dpi ?? "—"}</td>
              <td>
                {row.info.format}
                <div class={styles.muted}>
                  {row.info.colorSpace}
                  {row.info.hasSoftMask ? " + alpha" : ""}
                </div>
              </td>
              <td class={styles.num}>{formatBytes(row.info.rawSize)}</td>
              <td onClick={(e) => e.stopPropagation()}>
                <Show
                  when={!row.info.lockedReason && row.mergedInto === null}
                  fallback={
                    <span class={styles.muted}>
                      {row.mergedInto !== null
                        ? `Pages use image #${row.mergedInto} instead`
                        : `Left as is: ${row.info.lockedReason}`}
                    </span>
                  }
                >
                  <div class={styles.settings}>
                    <SettingsFields
                      compact
                      value={row.custom ?? state.preset}
                      onChange={(s) => engine.setCustom(row.info.id, s)}
                    />
                    <Show when={row.custom}>
                      <button
                        type="button"
                        class={styles.reset}
                        title="Use the preset for this image"
                        onClick={() => engine.setCustom(row.info.id, null)}
                      >
                        Reset
                      </button>
                    </Show>
                  </div>
                  <Show when={row.note}>
                    <div class={styles.note}>{row.note}</div>
                  </Show>
                </Show>
              </td>
              <td class={styles.result}>
                <ResultCell row={row} />
              </td>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  );
}
