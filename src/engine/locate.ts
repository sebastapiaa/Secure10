import { median, rgbToLab, robustSigma } from "./color";
import { fitRobustLine } from "./fit";
import { CARD_HEIGHT_MM, CARD_WIDTH_MM } from "./score";
import type { Edge, Line, Raster } from "./types";
import { EDGES } from "./types";

/** An oriented card rectangle. ey runs along the long side; ey = rot90(ex). */
export interface Frame {
  cx: number;
  cy: number;
  ex: [number, number];
  ey: [number, number];
  w: number;
  h: number;
}

const CARD_ASPECT = CARD_HEIGHT_MM / CARD_WIDTH_MM;

interface Small {
  w: number;
  h: number;
  scale: number;
  lab: Float32Array;
}

function shrink(src: Raster, maxDim: number): Small {
  const scale = Math.max(1, Math.ceil(Math.max(src.width, src.height) / maxDim));
  const w = Math.floor(src.width / scale);
  const h = Math.floor(src.height / scale);
  const lab = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < scale; j++) {
        let p = ((y * scale + j) * src.width + x * scale) * 4;
        for (let i = 0; i < scale; i++, p += 4) {
          r += src.data[p];
          g += src.data[p + 1];
          b += src.data[p + 2];
        }
      }
      const n = scale * scale;
      rgbToLab(r / n, g / n, b / n, lab, (y * w + x) * 3);
    }
  }
  return { w, h, scale, lab };
}

function perimeterIndices(w: number, h: number, band: number): number[] {
  const out: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < band || y < band || x >= w - band || y >= h - band) out.push(y * w + x);
    }
  }
  return out;
}

export interface Background {
  lab: [number, number, number];
  chroma: number;
  noise: number;
}

function estimateBackground(s: Small): Background {
  const idx = perimeterIndices(s.w, s.h, Math.max(2, Math.round(Math.min(s.w, s.h) * 0.012)));
  const channel = (c: number) => median(Float64Array.from(idx, (i) => s.lab[i * 3 + c]));
  const lab: [number, number, number] = [channel(0), channel(1), channel(2)];
  const dist = Float64Array.from(idx, (i) =>
    Math.hypot(s.lab[i * 3] - lab[0], s.lab[i * 3 + 1] - lab[1], s.lab[i * 3 + 2] - lab[2]),
  );
  return { lab, chroma: Math.hypot(lab[1], lab[2]), noise: robustSigma(dist, 0) };
}

/** Everything not reachable from the scan's perimeter through background colour. */
function foregroundMask(s: Small, bg: Background): Uint8Array {
  const threshold = Math.max(6, 4 * bg.noise);
  const n = s.w * s.h;
  const isBg = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(s.lab[i * 3] - bg.lab[0], s.lab[i * 3 + 1] - bg.lab[1], s.lab[i * 3 + 2] - bg.lab[2]);
    if (d < threshold) isBg[i] = 1;
  }
  const seen = new Uint8Array(n);
  const stack: number[] = [];
  for (const i of perimeterIndices(s.w, s.h, 1)) {
    if (isBg[i]) {
      seen[i] = 1;
      stack.push(i);
    }
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % s.w;
    const y = (i - x) / s.w;
    const visit = (j: number) => {
      if (!seen[j] && isBg[j]) {
        seen[j] = 1;
        stack.push(j);
      }
    };
    if (x > 0) visit(i - 1);
    if (x < s.w - 1) visit(i + 1);
    if (y > 0) visit(i - s.w);
    if (y < s.h - 1) visit(i + s.w);
  }
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = seen[i] ? 0 : 1;
  return mask;
}

/** Morphological opening: removes shadows and specks, and separates cards joined by a thin bridge. */
function open(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  const step = (input: Uint8Array, keepIfAll: boolean) => {
    const out = new Uint8Array(input.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let hit = keepIfAll ? 1 : 0;
        for (let dy = -radius; dy <= radius && hit === (keepIfAll ? 1 : 0); dy++) {
          const yy = y + dy;
          for (let dx = -radius; dx <= radius; dx++) {
            const xx = x + dx;
            const v = xx >= 0 && yy >= 0 && xx < w && yy < h ? input[yy * w + xx] : 0;
            if (keepIfAll && !v) {
              hit = 0;
              break;
            }
            if (!keepIfAll && v) {
              hit = 1;
              break;
            }
          }
        }
        out[y * w + x] = hit;
      }
    }
    return out;
  };
  return step(step(mask, true), false);
}

interface Component {
  area: number;
  boundary: [number, number][];
}

function components(mask: Uint8Array, w: number, h: number): Component[] {
  const label = new Uint8Array(mask.length);
  const out: Component[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start]) continue;
    const stack = [start];
    label[start] = 1;
    let area = 0;
    const boundary: [number, number][] = [];
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w;
      const y = (i - x) / w;
      area++;
      let edge = false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h || !mask[yy * w + xx]) {
          edge = true;
          continue;
        }
        const j = yy * w + xx;
        if (!label[j]) {
          label[j] = 1;
          stack.push(j);
        }
      }
      if (edge) boundary.push([x, y]);
    }
    out.push({ area, boundary });
  }
  return out;
}

function minAreaRect(points: [number, number][]): { angle: number; a: number; b: number; cu: number; cv: number } {
  const evalAt = (deg: number) => {
    const t = (deg * Math.PI) / 180;
    const c = Math.cos(t);
    const s = Math.sin(t);
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const [x, y] of points) {
      const u = c * x + s * y;
      const v = -s * x + c * y;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    return { angle: deg, a: maxU - minU, b: maxV - minV, cu: (minU + maxU) / 2, cv: (minV + maxV) / 2 };
  };
  let best = evalAt(0);
  for (let d = -45; d < 45; d += 1) {
    const r = evalAt(d);
    if (r.a * r.b < best.a * best.b) best = r;
  }
  const center = best.angle;
  for (let d = center - 1; d <= center + 1; d += 0.05) {
    const r = evalAt(d);
    if (r.a * r.b < best.a * best.b) best = r;
  }
  return best;
}

export interface Located {
  frames: Frame[];
  /** No background visible: the file is already cropped to the card. */
  tight: boolean;
  background: Background;
}

function wholeImageFrame(src: Raster): Frame {
  return { cx: src.width / 2, cy: src.height / 2, ex: [1, 0], ey: [0, 1], w: src.width, h: src.height };
}

export function locateCards(src: Raster): Located {
  const small = shrink(src, 1000);
  const background = estimateBackground(small);
  const raw = foregroundMask(small, background);
  const radius = Math.max(1, Math.round(Math.max(small.w, small.h) / 400));
  const mask = open(raw, small.w, small.h, radius);
  const total = small.w * small.h;
  const imageAspect = Math.max(src.width, src.height) / Math.min(src.width, src.height);
  const imageIsCardShaped = Math.abs(imageAspect - CARD_ASPECT) / CARD_ASPECT < 0.06;

  // A saturated perimeter on a card-shaped file means we are looking at the card's own border.
  if (imageIsCardShaped && background.chroma > 14) {
    return { frames: [wholeImageFrame(src)], tight: true, background };
  }

  const candidates: { frame: Frame; area: number }[] = [];
  for (const comp of components(mask, small.w, small.h)) {
    if (comp.area < total * 0.012 || comp.boundary.length < 40) continue;
    const r = minAreaRect(comp.boundary);
    const long = Math.max(r.a, r.b);
    const short = Math.min(r.a, r.b);
    const aspect = long / short;
    if (aspect < 1.15 || aspect > 1.65) continue;
    if (comp.area / (r.a * r.b) < 0.72) continue;
    if (short * small.scale < 120) continue;
    const t = (r.angle * Math.PI) / 180;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const e1: [number, number] = [c, s];
    const e2: [number, number] = [-s, c];
    const cxSmall = c * r.cu - s * r.cv;
    const cySmall = s * r.cu + c * r.cv;
    // A card lying on its side keeps ey on the long side, so the crop always comes out portrait.
    const portrait = r.b >= r.a;
    const ey = portrait ? e2 : e1;
    const ex: [number, number] = portrait ? e1 : [ey[1], -ey[0]];
    candidates.push({
      area: comp.area,
      frame: {
        cx: (cxSmall + 0.5) * small.scale,
        cy: (cySmall + 0.5) * small.scale,
        ex,
        ey,
        w: short * small.scale,
        h: long * small.scale,
      },
    });
  }

  if (candidates.length === 0) {
    return imageIsCardShaped
      ? { frames: [wholeImageFrame(src)], tight: true, background }
      : { frames: [], tight: false, background };
  }

  const largest = Math.max(...candidates.map((c) => c.area));
  const frames = candidates
    .filter((c) => c.area >= largest * 0.55)
    .map((c) => c.frame)
    .sort((a, b) => a.cy - b.cy || a.cx - b.cx);
  return { frames, tight: false, background };
}

const scratch = new Float32Array(3);

/**
 * Lab profile walking from (px, py) along (nx, ny), one pixel per step, averaged across a band
 * perpendicular to the walk. The band averages away halftone dots so edges are not fooled by print screen.
 */
export function bandProfile(
  src: Raster,
  px: number,
  py: number,
  nx: number,
  ny: number,
  tx: number,
  ty: number,
  band: number,
  count: number,
): Float32Array {
  const out = new Float32Array(count * 3);
  const { width: W, height: H, data } = src;
  for (let k = 0; k < count; k++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let j = -band; j <= band; j++) {
      const x = px + nx * k + tx * j;
      const y = py + ny * k + ty * j;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      if (x0 < 0 || y0 < 0 || x0 >= W - 1 || y0 >= H - 1) continue;
      const fx = x - x0;
      const fy = y - y0;
      const p = (y0 * W + x0) * 4;
      const q = p + W * 4;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      r += data[p] * w00 + data[p + 4] * w10 + data[q] * w01 + data[q + 4] * w11;
      g += data[p + 1] * w00 + data[p + 5] * w10 + data[q + 1] * w01 + data[q + 5] * w11;
      b += data[p + 2] * w00 + data[p + 6] * w10 + data[q + 2] * w01 + data[q + 6] * w11;
      n++;
    }
    if (n === 0) {
      out[k * 3] = out[k * 3 + 1] = out[k * 3 + 2] = NaN;
    } else {
      rgbToLab(r / n, g / n, b / n, scratch);
      out[k * 3] = scratch[0];
      out[k * 3 + 1] = scratch[1];
      out[k * 3 + 2] = scratch[2];
    }
  }
  return out;
}

export function medianLab(profile: Float32Array, from: number, to: number): [number, number, number] {
  const pick = (c: number) => {
    const values: number[] = [];
    for (let k = from; k < to; k++) {
      const v = profile[k * 3 + c];
      if (!Number.isNaN(v)) values.push(v);
    }
    return median(values);
  };
  return [pick(0), pick(1), pick(2)];
}

export function distanceSeries(profile: Float32Array, ref: [number, number, number]): Float32Array {
  const count = profile.length / 3;
  const out = new Float32Array(count);
  for (let k = 0; k < count; k++) {
    const d = Math.hypot(profile[k * 3] - ref[0], profile[k * 3 + 1] - ref[1], profile[k * 3 + 2] - ref[2]);
    out[k] = Number.isNaN(d) ? 0 : d;
  }
  return out;
}

/** Sub-pixel position where the series first rises through `level`, walking back from `from`. */
export function crossingBefore(series: Float32Array, from: number, level: number, lowest = 0): number {
  for (let k = Math.min(from, series.length - 1); k > lowest; k--) {
    if (series[k - 1] < level && series[k] >= level) {
      return k - 1 + (level - series[k - 1]) / (series[k] - series[k - 1]);
    }
  }
  return from;
}

export type SideLines = Record<Edge, Line>;

export interface OuterResult {
  lines: SideLines;
  ok: Record<Edge, boolean>;
  inlierRatio: number;
}

/** Fits the four physical card edges in frame coordinates, by walking in from the background. */
export function findOuterEdges(
  src: Raster,
  frame: Frame,
  outside: number,
  inside: number,
  pxPerMm: number,
  globalBg: [number, number, number],
): OuterResult {
  const { ex, ey } = frame;
  const lines = {} as SideLines;
  const ok = {} as Record<Edge, boolean>;
  const inlierRatios: number[] = [];
  const band = Math.max(3, Math.round(pxPerMm * 0.6));

  for (const edge of EDGES) {
    const horizontalEdge = edge === "top" || edge === "bottom";
    const sign = edge === "left" || edge === "top" ? -1 : 1;
    const normalAxis = horizontalEdge ? ey : ex;
    const alongAxis = horizontalEdge ? ex : ey;
    const half = horizontalEdge ? frame.h / 2 : frame.w / 2;
    const alongHalf = horizontalEdge ? frame.w / 2 : frame.h / 2;
    const nOut: [number, number] = [normalAxis[0] * sign, normalAxis[1] * sign];

    const us: number[] = [];
    const vs: number[] = [];
    const stations = 44;
    for (let i = 0; i < stations; i++) {
      const u = alongHalf * (-0.76 + (1.52 * i) / (stations - 1));
      const baseX = frame.cx + alongAxis[0] * u + nOut[0] * half;
      const baseY = frame.cy + alongAxis[1] * u + nOut[1] * half;

      // Stop the walk just short of the file's edge, where scanners often leave a dark sliver.
      let out = outside;
      const margin = 3 + band * Math.max(Math.abs(alongAxis[0]), Math.abs(alongAxis[1]));
      for (const [pos, n, limit] of [
        [baseX, nOut[0], src.width],
        [baseY, nOut[1], src.height],
      ] as const) {
        if (n > 1e-6) out = Math.min(out, (limit - 1 - margin - pos) / n);
        if (n < -1e-6) out = Math.min(out, (margin - pos) / n);
      }
      out = Math.floor(out);
      if (out < 3) continue;
      const count = out + inside;
      const profile = bandProfile(
        src,
        baseX + nOut[0] * out,
        baseY + nOut[1] * out,
        -nOut[0],
        -nOut[1],
        alongAxis[0],
        alongAxis[1],
        band,
        count,
      );
      const refLen = Math.min(Math.round(pxPerMm * 1.5), Math.floor(out * 0.5));
      const ref = refLen >= 4 ? medianLab(profile, 0, refLen) : globalBg;
      const dist = distanceSeries(profile, ref);
      const noise = refLen >= 4 ? robustSigma(dist.subarray(0, refLen), 0) : 1;
      const threshold = Math.max(3.5, 4 * noise);

      let hit = -1;
      for (let k = Math.max(1, refLen); k < count - 3; k++) {
        if (dist[k] > threshold && dist[k + 1] > threshold && dist[k + 2] > threshold) {
          hit = k;
          break;
        }
      }
      if (hit < 0) continue;
      const plateau = median(dist.subarray(hit + 2, Math.min(count, hit + 2 + Math.round(pxPerMm * 0.8))));
      const position = crossingBefore(dist, hit + 2, plateau / 2, Math.max(0, hit - Math.round(pxPerMm)));
      // Distance inward from the frame's side, converted to the signed frame coordinate.
      const inward = position - out;
      us.push(u);
      vs.push(sign * (half - inward));
    }
    const fit = fitRobustLine(us, vs, Math.max(0.9, pxPerMm * 0.1));
    if (fit && fit.stats.inlierRatio >= 0.4) {
      lines[edge] = fit.line;
      ok[edge] = true;
      inlierRatios.push(fit.stats.inlierRatio);
    } else {
      lines[edge] = { a: sign * half, b: 0 };
      ok[edge] = false;
    }
  }
  return {
    lines,
    ok,
    inlierRatio: inlierRatios.length ? Math.min(...inlierRatios) : 0,
  };
}
