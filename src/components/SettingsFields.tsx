import { type Element, Show } from "solid-js";
import { clampSettings, COLOR_LABELS, MODE_LABELS } from "../lib/settings";
import type { ColorMode, Mode, Settings } from "../lib/types";
import { NumberField } from "./NumberField";
import { Select } from "./Select";
import styles from "./SettingsFields.module.css";

const MODE_OPTIONS = (Object.keys(MODE_LABELS) as Mode[]).map((value) => ({ value, label: MODE_LABELS[value] }));
const COLOR_OPTIONS = (Object.keys(COLOR_LABELS) as ColorMode[]).map((value) => ({
  value,
  label: COLOR_LABELS[value],
}));

function Field(props: { label: string; compact?: boolean; children: Element }) {
  return (
    <label class={styles.field}>
      <Show when={!props.compact}>
        <span class={styles.label}>{props.label}</span>
      </Show>
      {props.children}
    </label>
  );
}

interface Props {
  value: Settings;
  onChange: (settings: Settings) => void;
  /** Table-row variant: no visible labels, no dither field. */
  compact?: boolean;
}

export function SettingsFields(props: Props) {
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    props.onChange(clampSettings({ ...props.value, [key]: value }));

  return (
    <div class={[styles.fields, { [styles.compact]: !!props.compact }]}>
      <Field label="Mode" compact={props.compact}>
        <Select label="Mode" value={props.value.mode} options={MODE_OPTIONS} onChange={(v) => set("mode", v)} />
      </Field>
      <Show when={props.value.mode === "jpeg"}>
        <Field label="Quality" compact={props.compact}>
          <NumberField
            class={styles.number}
            label="JPEG quality (1–100)"
            value={props.value.quality}
            min={1}
            max={100}
            onCommit={(v) => set("quality", v)}
          />
        </Field>
      </Show>
      <Show when={props.value.mode === "palette"}>
        <Field label="Colours" compact={props.compact}>
          <NumberField
            class={styles.number}
            label="Palette colours (2–256)"
            value={props.value.colors}
            min={2}
            max={256}
            onCommit={(v) => set("colors", v)}
          />
        </Field>
        <Show when={!props.compact}>
          <Field label="Dither">
            <NumberField
              class={styles.number}
              label="Dithering (0–1)"
              value={props.value.dither}
              min={0}
              max={1}
              step={0.1}
              onCommit={(v) => set("dither", v)}
            />
          </Field>
        </Show>
      </Show>
      <Show when={props.value.mode !== "keep"}>
        <Field label="Max DPI" compact={props.compact}>
          <NumberField
            class={styles.number}
            label="Downsample above this effective DPI (0 = never)"
            value={props.value.maxDpi}
            min={0}
            max={2400}
            step={10}
            onCommit={(v) => set("maxDpi", v)}
          />
        </Field>
        <Field label="Colour" compact={props.compact}>
          <Select label="Colour" value={props.value.color} options={COLOR_OPTIONS} onChange={(v) => set("color", v)} />
        </Field>
      </Show>
    </div>
  );
}
