import * as Comlink from "comlink";
import type { CodecApi } from "../workers/codec.worker";

/** Idle workers are terminated after this long, freeing their wasm memory. */
const IDLE_TIMEOUT = 15_000;

interface Slot {
  worker: Worker | null;
  api: Comlink.Remote<CodecApi> | null;
  busy: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
}

export class AbortedError extends Error {
  constructor() {
    super("Aborted");
    this.name = "AbortError";
  }
}

/** A fixed set of codec workers. Jobs wait for a free slot, FIFO. */
export class CodecPool {
  private readonly slots: Slot[];
  private readonly waiting: ((slot: Slot) => void)[] = [];

  constructor(size: number) {
    this.slots = Array.from({ length: size }, () => ({ worker: null, api: null, busy: false }));
  }

  private start(slot: Slot) {
    slot.worker = new Worker(new URL("../workers/codec.worker.ts", import.meta.url), { type: "module" });
    slot.api = Comlink.wrap<CodecApi>(slot.worker);
  }

  private terminate(slot: Slot) {
    slot.worker?.terminate();
    slot.worker = null;
    slot.api = null;
  }

  private acquire(signal: AbortSignal): Promise<Slot> {
    const free = this.slots.find((s) => !s.busy);
    if (free) {
      free.busy = true;
      return Promise.resolve(free);
    }
    return new Promise((resolve, reject) => {
      const take = (slot: Slot) => {
        signal.removeEventListener("abort", onAbort);
        resolve(slot);
      };
      const onAbort = () => {
        this.waiting.splice(this.waiting.indexOf(take), 1);
        reject(new AbortedError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(take);
    });
  }

  private release(slot: Slot) {
    const next = this.waiting.shift();
    if (next) {
      next(slot);
      return;
    }
    slot.busy = false;
    clearTimeout(slot.idleTimer);
    slot.idleTimer = setTimeout(() => {
      if (!slot.busy) this.terminate(slot);
    }, IDLE_TIMEOUT);
  }

  /**
   * Runs `job` on a free worker. If `signal` aborts while the job runs, the
   * worker is terminated and the returned promise rejects with AbortedError.
   */
  async run<T>(signal: AbortSignal, job: (api: Comlink.Remote<CodecApi>) => Promise<T>): Promise<T> {
    if (signal.aborted) throw new AbortedError();
    const slot = await this.acquire(signal);
    clearTimeout(slot.idleTimer);
    if (signal.aborted) {
      this.release(slot);
      throw new AbortedError();
    }
    if (!slot.api) this.start(slot);

    let onAbort: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => {
          this.terminate(slot);
          reject(new AbortedError());
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });
      return await Promise.race([job(slot.api!), aborted]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
      this.release(slot);
    }
  }
}
