/**
 * Works out which part of each image is actually visible, from the clip stack a
 * mupdf device sees while a page is run. Everything is conservative: whenever a
 * clip's shape isn't known exactly, it is treated as not restricting anything.
 */
import type * as mupdf from "mupdf";
import type { UnitRect } from "./types";

/** [x0, y0, x1, y1] in device space. */
type Rect = [number, number, number, number];

const EVERYTHING: Rect = [-Infinity, -Infinity, Infinity, Infinity];

function intersect(a: Rect, b: Rect): Rect {
  return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
}

function isEmpty(r: Rect): boolean {
  return r[0] >= r[2] || r[1] >= r[3];
}

function apply(m: mupdf.Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function boundsOf(points: [number, number][]): Rect {
  const r: Rect = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of points) {
    r[0] = Math.min(r[0], x);
    r[1] = Math.min(r[1], y);
    r[2] = Math.max(r[2], x);
    r[3] = Math.max(r[3], y);
  }
  return r;
}

function unitSquareBounds(ctm: mupdf.Matrix): Rect {
  return boundsOf([apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 0, 1), apply(ctm, 1, 1)]);
}

function pathBounds(path: mupdf.Path, ctm: mupdf.Matrix): Rect {
  const points: [number, number][] = [];
  const add = (x: number, y: number) => points.push(apply(ctm, x, y));
  path.walk({
    moveTo: add,
    lineTo: add,
    // Control points bound the curve, so their box is a safe superset.
    curveTo: (x1, y1, x2, y2, x3, y3) => {
      add(x1, y1);
      add(x2, y2);
      add(x3, y3);
    },
  });
  return points.length ? boundsOf(points) : [0, 0, 0, 0];
}

/** The subset of mupdf's (unexported) DeviceFunctions used here. */
export interface VisibilityCallbacks {
  fillImage(image: mupdf.Image, ctm: mupdf.Matrix, alpha: number): void;
  clipPath(path: mupdf.Path, evenOdd: boolean, ctm: mupdf.Matrix): void;
  clipStrokePath(): void;
  clipText(): void;
  clipStrokeText(): void;
  clipImageMask(image: mupdf.Image, ctm: mupdf.Matrix): void;
  popClip(): void;
  beginMask(area: mupdf.Rect): void;
  endMask(): void;
  beginTile(): number;
  endTile(): void;
}

/** Result for one placement of an image. */
export type Placement = { kind: "full" } | { kind: "hidden" } | { kind: "part"; rect: UnitRect };

/** Device callbacks that track the clip region; `onImage` receives each placement. */
export function visibilityDevice(
  pageBounds: Rect,
  onImage: (image: mupdf.Image, ctm: mupdf.Matrix, placement: Placement) => void,
): VisibilityCallbacks {
  const clips: Rect[] = [];
  const maskAreas: Rect[] = [];
  let maskDepth = 0;
  let tileDepth = 0;

  const current = () => intersect(clips.at(-1) ?? EVERYTHING, pageBounds);
  const push = (rect: Rect | null) => clips.push(rect ? intersect(current(), rect) : current());

  function placement(ctm: mupdf.Matrix): Placement {
    // Images drawn into a soft mask or a repeating pattern: don't try to be clever.
    if (maskDepth > 0 || tileDepth > 0) return { kind: "full" };
    const imageBox = unitSquareBounds(ctm);
    const visible = intersect(current(), imageBox);
    if (isEmpty(visible)) return { kind: "hidden" };

    const det = ctm[0] * ctm[3] - ctm[1] * ctm[2];
    if (Math.abs(det) < 1e-9) return { kind: "full" };
    const inverse: mupdf.Matrix = [
      ctm[3] / det,
      -ctm[1] / det,
      -ctm[2] / det,
      ctm[0] / det,
      (ctm[2] * ctm[5] - ctm[3] * ctm[4]) / det,
      (ctm[1] * ctm[4] - ctm[0] * ctm[5]) / det,
    ];
    const [x0, y0, x1, y1] = visible;
    const unit = boundsOf([
      apply(inverse, x0, y0),
      apply(inverse, x1, y0),
      apply(inverse, x0, y1),
      apply(inverse, x1, y1),
    ]);
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    return { kind: "part", rect: [clamp(unit[0]), clamp(unit[1]), clamp(unit[2]), clamp(unit[3])] };
  }

  return {
    fillImage(image, ctm) {
      onImage(image, ctm, placement(ctm));
    },
    clipPath(path, _evenOdd, ctm) {
      push(pathBounds(path, ctm));
    },
    clipStrokePath() {
      push(null);
    },
    clipText() {
      push(null);
    },
    clipStrokeText() {
      push(null);
    },
    clipImageMask(image, ctm) {
      image.destroy();
      push(unitSquareBounds(ctm));
    },
    popClip() {
      clips.pop();
    },
    beginMask(area) {
      maskDepth++;
      maskAreas.push(area as Rect);
    },
    endMask() {
      maskDepth--;
      // The finished mask acts as a clip until the matching popClip.
      push(maskAreas.pop() ?? null);
    },
    beginTile() {
      tileDepth++;
      return 0;
    },
    endTile() {
      tileDepth--;
    },
  };
}

/** Accumulates placements of one image across all pages. */
export class VisibleArea {
  private full = false;
  private rect: UnitRect | null = null;

  add(p: Placement) {
    if (p.kind === "full") this.full = true;
    else if (p.kind === "part") {
      const r = p.rect;
      this.rect = this.rect
        ? [
            Math.min(this.rect[0], r[0]),
            Math.min(this.rect[1], r[1]),
            Math.max(this.rect[2], r[2]),
            Math.max(this.rect[3], r[3]),
          ]
        : r;
    }
  }

  /** The visible union, or null when the whole image may be visible (or nothing is). */
  result(): UnitRect | null {
    if (this.full || !this.rect) return null;
    const [x0, y0, x1, y1] = this.rect;
    if ((x1 - x0) * (y1 - y0) > 0.999) return null;
    return this.rect;
  }
}
