import type { FitStats, Line } from "./types";

export interface RobustFit {
  line: Line;
  stats: FitStats;
}

function leastSquares(xs: number[], ys: number[], use: boolean[]): { line: Line; se: number; rms: number; n: number } {
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < xs.length; i++) {
    if (!use[i]) continue;
    n++;
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    if (!use[i]) continue;
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  const b = sxx > 0 ? sxy / sxx : 0;
  const a = my - b * mx;
  let rss = 0;
  for (let i = 0; i < xs.length; i++) {
    if (use[i]) rss += (ys[i] - (a + b * xs[i])) ** 2;
  }
  const rms = Math.sqrt(rss / Math.max(1, n));
  // Worst-point readings sit at the ends of the span, so report the error there, not at the centre.
  const halfSpan = Math.sqrt(sxx / Math.max(1, n)) * 1.73;
  const sigma2 = rss / Math.max(1, n - 2);
  const se = Math.sqrt(sigma2 / Math.max(1, n) + (sxx > 0 ? (sigma2 * halfSpan * halfSpan) / sxx : 0));
  return { line: { a, b }, se, rms, n };
}

/**
 * RANSAC line fit followed by least squares on the readings that agree. Stations that land on small
 * print, foil sparkle or a dust speck fall out as outliers. Deterministic, so a rescan of the same
 * file always gives the same reading.
 */
export function fitRobustLine(xs: number[], ys: number[], threshold: number): RobustFit | null {
  const count = xs.length;
  if (count < 6) return null;
  let seed = 0x2f6e2b1;
  const next = (limit: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % limit;
  };
  let best: boolean[] | null = null;
  let bestCount = 0;
  for (let it = 0; it < 300; it++) {
    const i = next(count);
    const j = next(count);
    if (i === j || xs[i] === xs[j]) continue;
    const b = (ys[j] - ys[i]) / (xs[j] - xs[i]);
    const a = ys[i] - b * xs[i];
    const use = xs.map((x, k) => Math.abs(ys[k] - (a + b * x)) <= threshold);
    const n = use.reduce((sum, u) => sum + (u ? 1 : 0), 0);
    if (n > bestCount) {
      bestCount = n;
      best = use;
    }
  }
  if (!best || bestCount < 4) return null;
  let fit = leastSquares(xs, ys, best);
  for (let pass = 0; pass < 3; pass++) {
    const use = xs.map((x, k) => Math.abs(ys[k] - (fit.line.a + fit.line.b * x)) <= threshold);
    if (use.filter(Boolean).length < 4) break;
    fit = leastSquares(xs, ys, use);
  }
  return {
    line: fit.line,
    stats: { samples: count, inlierRatio: fit.n / count, rms: fit.rms, se: fit.se },
  };
}
