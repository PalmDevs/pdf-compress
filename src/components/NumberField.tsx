interface Props {
  value: number;
  min: number;
  max: number;
  step?: number;
  label: string;
  class?: string;
  onCommit: (value: number) => void;
}

/** Number input that commits on change (Enter / blur / spinner) and snaps to the valid range. */
export function NumberField(props: Props) {
  return (
    <input
      type="number"
      class={props.class}
      value={props.value}
      min={props.min}
      max={props.max}
      step={props.step ?? 1}
      aria-label={props.label}
      title={props.label}
      onChange={(e) => {
        const input = e.currentTarget;
        const parsed = Number(input.value);
        const next =
          Number.isFinite(parsed) && input.value !== ""
            ? Math.min(props.max, Math.max(props.min, parsed))
            : props.value;
        // Write back: if the committed value equals the current one the binding won't re-run.
        input.value = String(next);
        if (next !== props.value) props.onCommit(next);
      }}
    />
  );
}
