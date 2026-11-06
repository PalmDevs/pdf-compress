/**
 * Writes the app icons: `bun scripts/make-icons.ts`.
 *
 * The artwork is defined once as paths on a 512×512 canvas (y pointing down) and
 * emitted both as SVG (public/icon.svg, the favicon) and as PDF drawing commands,
 * which mupdf renders to the PNG icons (mupdf.js has no SVG support). The letters
 * are drawn as strokes, so no font is involved anywhere.
 */
import * as mupdf from "mupdf";

const BLUE = "#1f5fbf";
const FOLD = "#c9d9f2";
const WHITE = "#ffffff";

type Cmd = ["M" | "L", number, number] | ["C", number, number, number, number, number, number] | ["Z"];
type Shape = { path: Cmd[]; fill?: string; stroke?: string; width?: number };

const K = 0.5523; // Bézier handle length for a quarter circle, as a fraction of the radius

function roundRect(x: number, y: number, w: number, h: number, r: number): Cmd[] {
  const k = r * K;
  return [
    ["M", x + r, y],
    ["L", x + w - r, y],
    ["C", x + w - r + k, y, x + w, y + r - k, x + w, y + r],
    ["L", x + w, y + h - r],
    ["C", x + w, y + h - r + k, x + w - r + k, y + h, x + w - r, y + h],
    ["L", x + r, y + h],
    ["C", x + r - k, y + h, x, y + h - r + k, x, y + h - r],
    ["L", x, y + r],
    ["C", x, y + r - k, x + r - k, y, x + r, y],
    ["Z"],
  ];
}

const k = 24 * K;
/** A page with a folded top-right corner; the "PDF" letters; a squeeze chevron. */
const artwork: Shape[] = [
  {
    fill: WHITE,
    path: [
      ["M", 156, 88],
      ["L", 302, 88],
      ["L", 376, 162],
      ["L", 376, 424],
      ["C", 376, 424 + k, 352 + k, 448, 352, 448],
      ["L", 156, 448],
      ["C", 156 - k, 448, 132, 424 + k, 132, 424],
      ["L", 132, 112],
      ["C", 132, 112 - k, 156 - k, 88, 156, 88],
      ["Z"],
    ],
  },
  {
    fill: FOLD,
    path: [["M", 302, 88], ["L", 302, 138], ["C", 302, 138 + k, 326 - k, 162, 326, 162], ["L", 376, 162], ["Z"]],
  },
  // P
  {
    stroke: BLUE,
    width: 20,
    path: [
      ["M", 160, 288],
      ["L", 160, 200],
      ["L", 184, 200],
      ["C", 202, 200, 212, 211, 212, 226],
      ["C", 212, 241, 202, 252, 184, 252],
      ["L", 160, 252],
    ],
  },
  // D
  {
    stroke: BLUE,
    width: 20,
    path: [
      ["M", 230, 200],
      ["L", 230, 288],
      ["L", 252, 288],
      ["C", 274, 288, 286, 270, 286, 244],
      ["C", 286, 218, 274, 200, 252, 200],
      ["Z"],
    ],
  },
  // F
  { stroke: BLUE, width: 20, path: [["M", 352, 200], ["L", 304, 200], ["L", 304, 288], ["M", 304, 244], ["L", 342, 244]] },
  // Chevron
  { stroke: BLUE, width: 20, path: [["M", 204, 344], ["L", 256, 374], ["L", 308, 344]] },
];

const background = (maskable: boolean): Shape => ({
  fill: BLUE,
  path: maskable ? roundRect(0, 0, 512, 512, 0) : roundRect(0, 0, 512, 512, 104),
});

// --- SVG ------------------------------------------------------------------------------

const svgPath = (path: Cmd[]) => path.map(([op, ...n]) => op + n.map((v) => +v.toFixed(2)).join(" ")).join("");

function svg(): string {
  const shapes = [background(false), ...artwork].map((s) =>
    s.stroke
      ? `<path d="${svgPath(s.path)}" fill="none" stroke="${s.stroke}" stroke-width="${s.width}" stroke-linecap="round" stroke-linejoin="round"/>`
      : `<path d="${svgPath(s.path)}" fill="${s.fill}"/>`,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${shapes.join("")}</svg>\n`;
}

// --- PDF → PNG ------------------------------------------------------------------------

const rgb = (hex: string) => [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(4)).join(" ");
const pdfOps: Record<Cmd[0], string> = { M: "m", L: "l", C: "c", Z: "h" };
const pdfPath = (path: Cmd[]) => path.map(([op, ...n]) => [...n.map((v) => +v.toFixed(2)), pdfOps[op]].join(" ")).join(" ");

function pdfShape(s: Shape): string {
  return s.stroke
    ? `${rgb(s.stroke)} RG ${s.width} w 1 J 1 j ${pdfPath(s.path)} S`
    : `${rgb(s.fill!)} rg ${pdfPath(s.path)} f`;
}

function png(maskable: boolean, size: number): Uint8Array {
  const doc = new mupdf.PDFDocument();
  // Flip to y-down so the coordinates match the SVG. Maskable icons keep the artwork in
  // the central 80% "safe zone", so any mask shape leaves it intact.
  const content = [
    "1 0 0 -1 0 512 cm",
    pdfShape(background(maskable)),
    maskable ? "0.8 0 0 0.8 51.2 51.2 cm" : "",
    ...artwork.map(pdfShape),
  ].join("\n");
  doc.insertPage(-1, doc.addPage([0, 0, 512, 512], 0, doc.newDictionary(), content));
  const pix = doc.loadPage(0).toPixmap(mupdf.Matrix.scale(size / 512, size / 512), mupdf.ColorSpace.DeviceRGB, true);
  const out = new Uint8Array(pix.asPNG());
  pix.destroy();
  doc.destroy();
  return out;
}

await Bun.write("public/icon.svg", svg());
await Bun.write("public/icons/icon-192.png", png(false, 192));
await Bun.write("public/icons/icon-512.png", png(false, 512));
await Bun.write("public/icons/maskable-512.png", png(true, 512));
// iOS draws its own rounded corners and wants an opaque square.
await Bun.write("public/icons/apple-touch-icon.png", png(true, 180));
console.log("Icons written.");
