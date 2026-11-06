import { createSignal, Show } from "solid-js";
import styles from "./App.module.css";
import { ImageTable } from "./components/ImageTable";
import { Preview } from "./components/Preview";
import { Toolbar } from "./components/Toolbar";
import { EngineContext } from "./context";
import { createEngine } from "./lib/engine";

export function App() {
  const engine = createEngine();
  const [dragging, setDragging] = createSignal(false);

  const openFiles = (files: FileList | null | undefined) => {
    const file = files?.[0];
    if (file) void engine.open(file);
  };

  return (
    <EngineContext value={engine}>
      <div
        class={[styles.app, { [styles.dragging]: dragging() }]}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
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
              <p class={styles.empty}>Open a PDF, or drop one anywhere on this page.</p>
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
      </div>
    </EngineContext>
  );
}
