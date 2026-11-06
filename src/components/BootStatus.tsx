import { Match, Switch, useContext } from "solid-js";
import { EngineContext } from "../context";
import type { Boot } from "../lib/engine";
import { formatBytes } from "../lib/format";
import styles from "./BootStatus.module.css";

type Phase<P extends Boot["phase"]> = Extract<Boot, { phase: P }>;

/** Start-up progress: app download, engine start, then "ready". */
export function BootStatus() {
  const engine = useContext(EngineContext);
  // Accessors only; every read happens inside JSX so it stays tracked.
  const boot = () => engine.state.boot;
  const download = () => boot() as Phase<"downloading">;
  const ready = () => boot() as Phase<"ready">;
  const failure = () => boot() as Phase<"error">;

  return (
    <span class={styles.status} role="status" aria-live="polite">
      <Switch>
        <Match when={boot().phase === "downloading"}>
          <progress
            class={styles.bar}
            value={download().total ? download().done : undefined}
            max={download().total || undefined}
          />
          <span class={styles.muted}>
            Downloading app…
            {download().total ? ` ${formatBytes(download().done)} / ${formatBytes(download().total)}` : ""}
          </span>
        </Match>
        <Match when={boot().phase === "starting"}>
          <progress class={styles.bar} />
          <span class={styles.muted}>Starting PDF engine…</span>
        </Match>
        <Match when={boot().phase === "ready" && ready().offline}>
          <span class={styles.good}>✓ App ready to work offline</span>
        </Match>
        <Match when={boot().phase === "ready"}>
          <span class={styles.muted} title={ready().note ?? undefined}>
            ✓ Ready (online only)
          </span>
        </Match>
        <Match when={boot().phase === "error"}>
          <span class={styles.bad}>Couldn't load the app: {failure().message}</span>
          <button type="button" onClick={() => engine.retryBoot()}>
            Retry
          </button>
        </Match>
      </Switch>
    </span>
  );
}
