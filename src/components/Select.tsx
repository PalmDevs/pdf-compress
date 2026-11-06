import { createEffect, For } from "solid-js";

export interface Option<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

interface Props<T extends string> {
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  label?: string;
  class?: string;
  disabled?: boolean;
}

/**
 * A <select> whose value is applied after its options exist, so dynamic option
 * lists never leave it showing the wrong entry.
 */
export function Select<T extends string>(props: Props<T>) {
  let el!: HTMLSelectElement;
  createEffect(
    () => [props.value, props.options.length] as const,
    ([value]) => {
      el.value = value;
    },
  );
  return (
    <select
      ref={el}
      class={props.class}
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.currentTarget.value as T)}
    >
      <For each={props.options} keyed={(option) => option.value}>
        {(option) => (
          <option value={option().value} disabled={option().disabled}>
            {option().label}
          </option>
        )}
      </For>
    </select>
  );
}
