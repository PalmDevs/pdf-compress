import { createMemo, Show, useContext } from "solid-js";
import { EngineContext } from "../context";
import { isReplacement } from "../lib/engine";
import { formatBytes, formatChange } from "../lib/format";
import { PRESETS, presetFor } from "../lib/settings";
import { install, installable } from "../lib/pwa";
import { BootStatus } from "./BootStatus";
import { DocumentOptions } from "./DocumentOptions";
import { Select } from "./Select";
import { SettingsFields } from "./SettingsFields";
import styles from "./Toolbar.module.css";

const CUSTOM = "custom";

export function Toolbar(props: { onOpen: (files: FileList | null) => void }) {
  const engine = useContext(EngineContext);
  const state = engine.state;
  let fileInput!: HTMLInputElement;

  const presetId = createMemo(() => presetFor(state.preset)?.id ?? CUSTOM);
  const presetOptions = createMemo(() => [
    ...PRESETS.map((p) => ({ value: p.id, label: p.label })),
    ...(presetId() === CUSTOM ? [{ value: CUSTOM, label: "Custom" }] : []),
  ]);

  const totals = createMemo(() => {
    let saved = 0;
    let pending = 0;
    let custom = 0;
    for (const row of state.rows) {
      if (row.status === "queued" || row.status === "working") pending++;
      if (row.custom) custom++;
      if (isReplacement(row)) saved += row.info.rawSize - row.newSize!;
      else if (row.mergedInto !== null) saved += row.info.rawSize;
    }
    const original = state.file?.size ?? 0;
    return { original, estimate: original - saved, pending, custom };
  });

  return (
    <header class={styles.toolbar}>
      <div class={styles.row}>
        <button
          type="button"
          disabled={state.boot.phase !== "ready"}
          title={state.boot.phase === "ready" ? undefined : "Available once the app has loaded"}
          onClick={() => fileInput.click()}
        >
          Open PDF…
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(e) => {
            props.onOpen(e.currentTarget.files);
            e.currentTarget.value = "";
          }}
        />
        <Show when={state.file}>
          {(file) => (
            <span class={styles.file}>
              <strong>{file().name}</strong> · {formatBytes(file().size)} · {file().pageCount} page
              {file().pageCount === 1 ? "" : "s"} · {state.rows.length} image
              {state.rows.length === 1 ? "" : "s"}
            </span>
          )}
        </Show>
        <BootStatus />
        <Show when={installable()}>
          <button type="button" class={styles.secondary} onClick={() => void install()}>
            Install app
          </button>
        </Show>
      </div>

      <Show when={state.file}>
        <Show when={state.rows.length > 0}>
          <div class={styles.row}>
            <label class={styles.preset}>
              <span class={styles.label}>Preset (all images)</span>
              <Select
                label="Preset"
                value={presetId()}
                options={presetOptions()}
                onChange={(id) => {
                  const preset = PRESETS.find((p) => p.id === id);
                  if (preset) engine.setPreset(preset.settings);
                }}
              />
            </label>
            <SettingsFields value={state.preset} onChange={(s) => engine.setPreset(s)} />
            <Show when={totals().custom > 0}>
              <button
                type="button"
                class={styles.secondary}
                title="Drop per-image settings so every image follows the preset"
                onClick={() => engine.applyToAll(state.preset)}
              >
                Reset {totals().custom} custom image
                {totals().custom === 1 ? "" : "s"}
              </button>
            </Show>
          </div>
        </Show>

        <DocumentOptions />

        <div class={styles.row}>
          <span
            class={styles.total}
            title="Counts image changes only. Font subsetting and the other document options are applied when saving."
          >
            Estimated size (images): {formatBytes(totals().original)} →{" "}
            <strong>{formatBytes(totals().estimate)}</strong>{" "}
            <span class={totals().estimate < totals().original ? styles.good : undefined}>
              ({formatChange(totals().original, totals().estimate) || "0%"})
            </span>
          </span>
          <Show when={totals().pending > 0}>
            <span class={styles.muted}>Encoding {totals().pending}…</span>
          </Show>
          <button type="button" class={styles.primary} disabled={state.saving} onClick={() => void engine.save()}>
            {state.saving ? (totals().pending > 0 ? "Waiting for encodes…" : "Saving…") : "Save compressed PDF"}
          </button>
          <Show when={state.saved}>
            {(saved) => (
              <span class={styles.muted}>
                Saved {formatBytes(saved().size)} ({formatChange(totals().original, saved().size)}), {saved().replaced}{" "}
                image{saved().replaced === 1 ? "" : "s"} replaced.
              </span>
            )}
          </Show>
        </div>
      </Show>
    </header>
  );
}
