/** Writes the test fixture to disk for trying the app by hand: `bun run fixture [out.pdf]`. */
import { makeFixture } from "../test/fixture";

const out = process.argv[2] ?? "fixture.pdf";
await Bun.write(out, makeFixture().bytes);
console.log(`Wrote ${out}`);
