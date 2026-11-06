import { createSignal, type Element, Show, useContext } from "solid-js";
import { EngineContext } from "../context";
import type { DocOptions } from "../lib/types";
import styles from "./DocumentOptions.module.css";

type Flag = { [K in keyof DocOptions]: DocOptions[K] extends boolean ? K : never }[keyof DocOptions];

function Check(props: { flag: Flag; label: string; title: string; children?: Element }) {
  const engine = useContext(EngineContext);
  return (
    <label class={styles.check} title={props.title}>
      <input
        type="checkbox"
        checked={engine.state.doc[props.flag]}
        onChange={(e) => engine.setDocOptions({ [props.flag]: e.currentTarget.checked })}
      />
      {props.label}
      {props.children}
    </label>
  );
}

export function DocumentOptions() {
  const engine = useContext(EngineContext);
  // Shown while dragging; committed on release so images are compared once.
  const [dragging, setDragging] = createSignal<number | null>(null);
  const merged = () => engine.state.rows.filter((r) => r.mergedInto !== null).length;

  return (
    <div class={styles.options}>
      <fieldset class={styles.group}>
        <legend>Document</legend>
        <Check flag="subsetFonts" label="Subset fonts" title="Keep only the glyphs each embedded font actually uses" />
        <Check
          flag="leftovers"
          label="Remove editor leftovers"
          title="Editor private data (/PieceInfo), page thumbnails and XMP metadata. Document metadata is kept for PDF/A, PDF/UA and PDF/X files."
        />
        <Check
          flag="cleanContent"
          label="Clean content streams"
          title="Rewrite page drawing commands without redundant operators"
        />
      </fieldset>

      <fieldset class={styles.group}>
        <legend>Images</legend>
        <Check
          flag="mergeSimilar"
          label="Merge similar images"
          title="Store one copy of images that look the same (e.g. one photo embedded several times at different qualities)"
        />
        <Show when={engine.state.doc.mergeSimilar}>
          <label class={styles.slider} title="How alike two images must be, judged by their most different region">
            <input
              type="range"
              min={80}
              max={100}
              step={0.5}
              value={engine.state.doc.similarity}
              onInput={(e) => setDragging(Number(e.currentTarget.value))}
              onChange={(e) => {
                setDragging(null);
                engine.setDocOptions({ similarity: Number(e.currentTarget.value) });
              }}
            />
            <span class={styles.value}>≥ {(dragging() ?? engine.state.doc.similarity).toFixed(1)}%</span>
            <span class={styles.muted}>{engine.state.comparing ?? `${merged()} merged`}</span>
          </label>
        </Show>
        <Check
          flag="cropToVisible"
          label="Crop to visible area"
          title="Drop the parts of re-encoded images that are clipped away on every page"
        />
      </fieldset>

      <fieldset class={styles.group}>
        <legend>Remove (optional)</legend>
        <Check flag="removeAttachments" label="Attachments" title="Embedded files and file-attachment annotations" />
        <Check flag="removeJavaScript" label="JavaScript" title="Document scripts and JavaScript actions" />
        <Check
          flag="removeAlternateImages"
          label="Alternate images"
          title="Extra versions of images meant for other output devices"
        />
        <Check
          flag="removeUnusedDestinations"
          label="Unused named destinations"
          title="Link targets nothing in this document points to (links from other documents to them will stop working)"
        />
      </fieldset>
    </div>
  );
}
