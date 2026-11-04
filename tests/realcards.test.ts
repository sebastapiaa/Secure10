import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { analyzeScan } from "../src/engine/pipeline";
import { computeCentering } from "../src/engine/score";
import type { Raster } from "../src/engine/types";

// Optional accuracy check on real card art. Point REAL_CARDS_DIR at a folder of straight-on card PNGs.
// Each is re-cut by a known amount, as a miscut sheet would, then laid rotated on a virtual scanner bed.
const dir = process.env.REAL_CARDS_DIR;
const overlayDir = process.env.OVERLAY_DIR;

function readPng(file: string): Raster {
  const png = PNG.sync.read(fs.readFileSync(file));
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
}

function layOnBed(card: Raster, opts: { dx: number; dy: number; rotation: number; bed: number; scale: number }): Raster {
  const dpi = 300;
  const cw = (63 / 25.4) * dpi;
  const ch = (88 / 25.4) * dpi;
  const W = Math.round(cw + 500);
  const H = Math.round(ch + 500);
  const data = new Uint8ClampedArray(W * H * 4);
  const t = (opts.rotation * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const sx = card.width / cw;
  const sy = card.height / ch;
  const r = (3 / 25.4) * dpi;
  let seed = 99;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const ox = cos * (x - W / 2) + sin * (y - H / 2) + cw / 2;
      const oy = -sin * (x - W / 2) + cos * (y - H / 2) + ch / 2;
      const p = (y * W + x) * 4;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const noise = (seed / 4294967296 - 0.5) * 4;
      const ddx = ox < r ? r - ox : ox > cw - r ? ox - (cw - r) : 0;
      const ddy = oy < r ? r - oy : oy > ch - r ? oy - (ch - r) : 0;
      const inside = ox >= 0 && oy >= 0 && ox <= cw && oy <= ch && ddx * ddx + ddy * ddy <= r * r;
      if (!inside) {
        data[p] = data[p + 1] = data[p + 2] = opts.bed + noise;
      } else {
        // Shifting the print inside the cut: samples past the source mirror back into the border, which
        // keeps its real texture. Renders have clear corners, so stay a few pixels off the very edge.
        const inset = 3;
        const mirror = (v: number, size: number) => (v < inset ? 2 * inset - v : v > size - 1 - inset ? 2 * (size - 1 - inset) - v : v);
        const ix = mirror(Math.round((ox - opts.dx) * sx), card.width);
        const iy = mirror(Math.round((oy - opts.dy) * sy), card.height);
        const q = (iy * card.width + ix) * 4;
        data[p] = card.data[q] + noise;
        data[p + 1] = card.data[q + 1] + noise;
        data[p + 2] = card.data[q + 2] + noise;
      }
      data[p + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}

function saveOverlay(name: string, crop: Raster, m: ReturnType<typeof analyzeScan>[number]["measurement"]) {
  if (!overlayDir) return;
  const png = new PNG({ width: crop.width, height: crop.height });
  png.data.set(crop.data);
  const paint = (x: number, y: number, c: number[]) => {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= crop.width || iy >= crop.height) return;
    png.data.set(c, (iy * crop.width + ix) * 4);
  };
  const outerC = [255, 0, 200, 255];
  const innerC = [0, 240, 255, 255];
  for (let y = 0; y < crop.height; y++) {
    for (const [l, c] of [[m.outer.left, outerC], [m.outer.right, outerC], [m.inner.left, innerC], [m.inner.right, innerC]] as const) paint(l.a + l.b * y, y, c as number[]);
  }
  for (let x = 0; x < crop.width; x++) {
    for (const [l, c] of [[m.outer.top, outerC], [m.outer.bottom, outerC], [m.inner.top, innerC], [m.inner.bottom, innerC]] as const) paint(x, l.a + l.b * x, c as number[]);
  }
  fs.mkdirSync(overlayDir, { recursive: true });
  fs.writeFileSync(path.join(overlayDir, name + ".png"), PNG.sync.write(png));
}

describe.skipIf(!dir)("real card art", () => {
  const files = dir ? fs.readdirSync(dir).filter((f) => f.endsWith(".png")) : [];
  for (const file of files) {
    it(file, () => {
      const card = readPng(path.join(dir!, file));
      const name = file.replace(".png", "");
      const base = analyzeScan(layOnBed(card, { dx: 0, dy: 0, rotation: 0, bed: 245, scale: 1 }), { metadataDpi: 300 })[0];
      const pxPerMm = base.dpi / 25.4;
      const r0 = computeCentering(base.measurement, base.side, pxPerMm);
      saveOverlay(name, base.crop, base.measurement);

      // Known miscut: 0.5 mm right, 0.35 mm down, rotated, dark lid. Compare with what geometry predicts.
      const dx = 0.5 * pxPerMm;
      const dy = 0.35 * pxPerMm;
      const moved = analyzeScan(layOnBed(card, { dx, dy, rotation: 2.3, bed: 30, scale: 1 }), { metadataDpi: 300 })[0];
      const r1 = computeCentering(moved.measurement, moved.side, pxPerMm);
      const b = r0.bordersMm;
      const expectH = ((b.left + 0.5) / (b.left + b.right)) * 100;
      const expectV = ((b.top + 0.35) / (b.top + b.bottom)) * 100;
      const hErr = r1.bordersMm.left / (r1.bordersMm.left + r1.bordersMm.right) * 100 - expectH;
      const vErr = r1.bordersMm.top / (r1.bordersMm.top + r1.bordersMm.bottom) * 100 - expectV;
      console.log(
        `${name.padEnd(16)} L${b.left.toFixed(2)} R${b.right.toFixed(2)} T${b.top.toFixed(2)} B${b.bottom.toFixed(2)} ` +
          `score ${r0.score} side ${base.side} review ${base.needsReview ? "Y" : "n"} | miscut err H ${hErr.toFixed(2)} V ${vErr.toFixed(2)}`,
      );
      // Only readings the engine stands behind have to be right. The rest must be flagged for review.
      if (!base.needsReview && !moved.needsReview) {
        expect(Math.abs(hErr / 100) * (b.left + b.right)).toBeLessThan(0.1);
        expect(Math.abs(vErr / 100) * (b.top + b.bottom)).toBeLessThan(0.1);
      }
    }, 60000);
  }
});
