const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linear(v: number): number {
  const lo = Math.max(0, Math.min(255, Math.floor(v)));
  const hi = Math.min(255, lo + 1);
  return SRGB_TO_LINEAR[lo] + (SRGB_TO_LINEAR[hi] - SRGB_TO_LINEAR[lo]) * (v - lo);
}

function f(t: number): number {
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}

/** Writes CIE Lab (D65) for an sRGB colour into out[offset..offset+2]. */
export function rgbToLab(r: number, g: number, b: number, out: Float32Array | number[], offset = 0): void {
  const lr = linear(r);
  const lg = linear(g);
  const lb = linear(b);
  const x = f((0.4124 * lr + 0.3576 * lg + 0.1805 * lb) / 0.95047);
  const y = f(0.2126 * lr + 0.7152 * lg + 0.0722 * lb);
  const z = f((0.0193 * lr + 0.1192 * lg + 0.9505 * lb) / 1.08883);
  out[offset] = 116 * y - 16;
  out[offset + 1] = 500 * (x - y);
  out[offset + 2] = 200 * (y - z);
}

export function median(values: ArrayLike<number>): number {
  const sorted = Float64Array.from(values as ArrayLike<number>).sort();
  if (sorted.length === 0) return NaN;
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

/** Median absolute deviation scaled to approximate a standard deviation. */
export function robustSigma(values: ArrayLike<number>, center = median(values)): number {
  const dev = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) dev[i] = Math.abs(values[i] - center);
  return 1.4826 * median(dev);
}
