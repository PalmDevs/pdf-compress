import { createContext } from "solid-js";
import type { Engine } from "./lib/engine";

/** The app engine; provided once by <App>. */
export const EngineContext = createContext<Engine>();
