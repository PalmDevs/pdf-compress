export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** "-42%" style change from `before` to `after`. */
export function formatChange(before: number, after: number): string {
  if (before === 0) return "";
  const pct = Math.round(((after - before) / before) * 100);
  return pct > 0 ? `+${pct}%` : `${pct}%`;
}

/** Compresses sorted page numbers into ranges: [1,2,3,5] → "1–3, 5". */
export function formatPages(pages: number[]): string {
  if (pages.length === 0) return "—";
  const parts: string[] = [];
  let start = pages[0];
  let prev = start;
  for (const p of [...pages.slice(1), Infinity]) {
    if (p === prev + 1) {
      prev = p;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = prev = p;
  }
  return parts.join(", ");
}
