import type { Raster } from "../src/engine/types";

export interface SynthOptions {
  dpi: number;
  /** Border widths in mm. */
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** Degrees of card rotation on the bed. */
  rotation: number;
  /** Degrees the printed frame is tilted relative to the cut, as on a diamond cut. */
  frameTilt?: number;
  bed: [number, number, number];
  border: [number, number, number];
  art: [number, number, number];
  noise: number;
  smallPrint?: boolean;
  bedW?: number;
  bedH?: number;
  cardX?: number;
  cardY?: number;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Card coordinate is inside the rounded rectangle of the cut card. */
function insideCard(x: number, y: number, w: number, h: number, r: number): boolean {
  if (x < 0 || y < 0 || x > w || y > h) return false;
  const dx = x < r ? r - x : x > w - r ? x - (w - r) : 0;
  const dy = y < r ? r - y : y > h - r ? y - (h - r) : 0;
  return dx * dx + dy * dy <= r * r;
}

/** Renders a flatbed scan of a card with known borders, supersampled to mimic optical blur. */
export function synthScan(o: SynthOptions): Raster {
  const mm = o.dpi / 25.4;
  const W = o.bedW ?? Math.round(8.5 * o.dpi);
  const H = o.bedH ?? Math.round(6 * o.dpi);
  const cw = 63 * mm;
  const ch = 88 * mm;
  const cx = o.cardX ?? W / 2;
  const cy = o.cardY ?? H / 2;
  const t = (o.rotation * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const tilt = ((o.frameTilt ?? 0) * Math.PI) / 180;
  const radius = 3 * mm;
  const data = new Uint8ClampedArray(W * H * 4);
  const random = rng(12345);

  const inL = o.left * mm;
  const inR = cw - o.right * mm;
  const inT = o.top * mm;
  const inB = ch - o.bottom * mm;
  const SS = 3;

  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const dx = px + (sx + 0.5) / SS - cx;
          const dy = py + (sy + 0.5) / SS - cy;
          const x = cos * dx + sin * dy + cw / 2;
          const y = -sin * dx + cos * dy + ch / 2;
          let c = o.bed;
          if (insideCard(x, y, cw, ch, radius)) {
            const fx = x + (y - ch / 2) * tilt;
            const fy = y - (x - cw / 2) * tilt;
            const inFrame = fx >= inL && fx <= inR && fy >= inT && fy <= inB;
            c = inFrame ? o.art : o.border;
            if (inFrame) {
              // Coarse art texture so the interior is not a flat colour.
              const wave = 18 * Math.sin(x / (mm * 3.1)) * Math.cos(y / (mm * 2.3));
              c = [c[0] + wave, c[1] + wave, c[2] + wave];
            } else if (o.smallPrint && y > ch - o.bottom * mm * 0.7 && y < ch - o.bottom * mm * 0.35) {
              // Dark small print in the bottom border, broken into words.
              const word = Math.floor(x / (mm * 1.2)) % 3 !== 0 && x > cw * 0.3 && x < cw * 0.7;
              if (word && Math.floor(x / (mm * 0.3)) % 2 === 0) c = [40, 40, 40];
            }
          }
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const n = SS * SS;
      const jitter = (random() - 0.5) * 2 * o.noise;
      const p = (py * W + px) * 4;
      data[p] = r / n + jitter;
      data[p + 1] = g / n + jitter;
      data[p + 2] = b / n + jitter;
      data[p + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}

export function share(a: number, b: number): number {
  return (Math.max(a, b) / (a + b)) * 100;
}
