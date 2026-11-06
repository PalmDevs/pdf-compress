import { render } from "@solidjs/web";
import { App } from "./App";
import "./global.css";
import "./lib/pwa";

render(() => <App />, document.getElementById("root")!);
