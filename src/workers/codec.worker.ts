/**
 * Stateless encode worker. Several run in parallel; cancelling a job terminates
 * its worker (the only way to stop running wasm), as Squoosh does.
 */
import * as Comlink from "comlink";
import { type CodecResult, encodeImage } from "../lib/codec";
import type { Pixels, Settings, Size } from "../lib/types";

const api = {
  async encode(px: Pixels, settings: Settings, target: Size): Promise<CodecResult> {
    const result = await encodeImage(px, settings, target);
    const buffer = "encoded" in result ? result.encoded.data.buffer : result.cmykJpeg.data.buffer;
    return Comlink.transfer(result, [buffer]);
  },
};

export type CodecApi = typeof api;

Comlink.expose(api);
