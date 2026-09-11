// src/lib/format.ts
// Shared value formatting for the CF usage metric displays. Born when the
// homepage CF pane became the second caller of a helper that used to live
// privately in adminViews (14-DESIGN-PRINCIPLES: one implementation).

/** "1179 B" / "12.3 KiB" / "1.0 GiB" for the *_bytes storage gauges. */
const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
};

/** Byte gauges get human units; everything else is a plain count. */
export const fmtMetricValue = (metric: string, n: number): string =>
  metric.endsWith('_bytes') ? fmtBytes(n) : n.toLocaleString();
