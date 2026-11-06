/**
 * Installable-app glue: the browser's install prompt, and PDFs the OS opens
 * with the installed app (manifest "file_handlers").
 */
import { createSignal } from "solid-js";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

interface LaunchParams {
  files: readonly FileSystemFileHandle[];
}

declare global {
  interface Window {
    launchQueue?: { setConsumer(consumer: (params: LaunchParams) => void): void };
  }
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
// Client-only app: one module-level signal is enough here.
const [installable, setInstallable] = createSignal(false);
export { installable };

// Registered at start-up (main.tsx imports this module): the event can fire early.
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault(); // we show our own "Install app" button instead of the mini-infobar
  deferredPrompt = event as BeforeInstallPromptEvent;
  setInstallable(true);
});
window.addEventListener("appinstalled", () => {
  deferredPrompt = null;
  setInstallable(false);
});

/** Shows the browser's install dialog. */
export async function install(): Promise<void> {
  const prompt = deferredPrompt;
  if (!prompt) return;
  deferredPrompt = null;
  setInstallable(false);
  await prompt.prompt();
  await prompt.userChoice;
}

/** Calls `open` with each PDF the installed app is launched with ("Open with…"). */
export function handleLaunchFiles(open: (file: File) => void) {
  window.launchQueue?.setConsumer((params) => {
    // The consumer may run synchronously inside setConsumer; defer so the caller's
    // setup phase never sees state writes.
    setTimeout(async () => {
      for (const handle of params.files) {
        const file = await handle.getFile();
        if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
          open(file);
          return; // one document at a time
        }
      }
    });
  });
}
