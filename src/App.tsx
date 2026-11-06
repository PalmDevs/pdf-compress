import { createSignal, Show } from "solid-js";
import styles from "./App.module.css";
import { ImageTable } from "./components/ImageTable";
import { Preview } from "./components/Preview";
import { Toolbar } from "./components/Toolbar";
import { EngineContext } from "./context";
import { createEngine } from "./lib/engine";
import { handleLaunchFiles } from "./lib/pwa";

export function App() {
  const engine = createEngine();
  const [dragging, setDragging] = createSignal(false);
  handleLaunchFiles((file) => engine.openWhenReady(file));

  const openFiles = (files: FileList | null | undefined) => {
    const file = files?.[0];
    if (file && engine.state.boot.phase === "ready") void engine.open(file);
  };

  return (
    <EngineContext value={engine}>
      <div
        class={[styles.app, { [styles.dragging]: dragging() }]}
        onDragOver={(e) => {
          e.preventDefault();
          if (engine.state.boot.phase === "ready") setDragging(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          openFiles(e.dataTransfer?.files);
        }}
      >
        <Toolbar onOpen={openFiles} />

        <Show when={engine.state.error}>{(error) => <p class={styles.error}>{error()}</p>}</Show>

        <Show when={engine.state.progress}>{(progress) => <p class={styles.status}>{progress()}</p>}</Show>

        <Show
          when={engine.state.file}
          fallback={
            <Show when={!engine.state.progress}>
              <p class={styles.empty}>
                {engine.state.boot.phase === "ready"
                  ? "Open a PDF, or drop one anywhere on this page."
                  : "Loading the app — you can open a PDF once it's ready."}
              </p>
            </Show>
          }
        >
          <Show
            when={engine.state.rows.length > 0}
            fallback={
              <p class={styles.empty}>
                This PDF has no images that can be recompressed. The document options above still apply when saving.
              </p>
            }
          >
            <main class={styles.main}>
              <section class={styles.table}>
                <ImageTable />
              </section>
              <Show when={engine.state.selected !== null}>
                <aside class={styles.preview}>
                  <Preview />
                </aside>
              </Show>
            </main>
          </Show>
        </Show>
        <footer class={styles.footer}>
          <p>Licensed under AGPL-3.0</p>
          <a target="_blank" rel="noopener noreferrer" href="https://github.com/PalmDevs/pdf-compress">Source code</a>
        </footer>
      </div>
    </EngineContext>
  );
}
