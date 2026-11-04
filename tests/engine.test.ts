import { describe, expect, it } from "vitest";
import { analyzeScan } from "../src/engine/pipeline";
import { readingOrder, type Frame } from "../src/engine/locate";
import { combineScores, computeCentering, scoreForShare } from "../src/engine/score";
import type { Raster } from "../src/engine/types";
import { share, synthScan, type SynthOptions } from "./synth";

const YELLOW: [number, number, number] = [236, 202, 72];
const SILVER: [number, number, number] = [196, 198, 204];
const BLUE: [number, number, number] = [32, 72, 158];
const ART: [number, number, number] = [150, 110, 90];
const WHITE: [number, number, number] = [250, 250, 250];
const BLACK: [number, number, number] = [18, 18, 20];

function run(o: SynthOptions) {
  const scan = synthScan(o);
  const [card] = analyzeScan(scan, { metadataDpi: o.dpi });
  return { card, result: computeCentering(card.measurement, card.side, card.dpi / 25.4) };
}

const base: SynthOptions = {
  dpi: 300,
  left: 3.1,
  right: 2.5,
  top: 3.4,
  bottom: 3.0,
  rotation: 0,
  bed: WHITE,
  border: YELLOW,
  art: ART,
  noise: 3,
};

describe("PSA score table", () => {
  it("matches PSA's published front limits", () => {
    expect(scoreForShare(50, "front")).toBe(10);
    expect(scoreForShare(55, "front")).toBe(10);
    expect(scoreForShare(55.1, "front")).toBe(9);
    expect(scoreForShare(60, "front")).toBe(9);
    expect(scoreForShare(65, "front")).toBe(8);
    expect(scoreForShare(70, "front")).toBe(7);
    expect(scoreForShare(80, "front")).toBe(6);
    expect(scoreForShare(85, "front")).toBe(5);
    expect(scoreForShare(90, "front")).toBe(3);
    expect(scoreForShare(90.1, "front")).toBe(1);
  });
  it("matches PSA's published back limits", () => {
    expect(scoreForShare(75, "back")).toBe(10);
    expect(scoreForShare(75.1, "back")).toBe(9);
    expect(scoreForShare(90, "back")).toBe(9);
    expect(scoreForShare(90.1, "back")).toBe(1);
  });
  it("uses the lower side for a whole card", () => {
    expect(combineScores(10, 9)).toBe(9);
    expect(combineScores(8, undefined)).toBe(8);
    expect(combineScores(undefined, 9)).toBe(9);
  });
});

describe("card location and measurement at 300 DPI", () => {
  const cases: [string, Partial<SynthOptions>][] = [
    ["straight, white lid", {}],
    ["rotated 2.7°, white lid", { rotation: 2.7 }],
    ["rotated -6°, black lid", { rotation: -6, bed: BLACK }],
    ["rotated 14°, in a corner of the bed", { rotation: 14, cardX: 620, cardY: 720, bedH: 1800 }],
    ["silver border on a white lid", { border: SILVER, rotation: 1.2 }],
    ["silver border on a black lid", { border: SILVER, bed: BLACK, rotation: -1.5 }],
    ["small print in the bottom border", { smallPrint: true, bottom: 3.6, top: 3.0 }],
    ["heavy scanner noise", { noise: 10, rotation: 0.8 }],
    ["badly off-centre, 80/20", { left: 4.48, right: 1.12, rotation: 1 }],
    ["card lying sideways", { rotation: 90 }],
  ];

  for (const [name, extra] of cases) {
    it(name, () => {
      const o = { ...base, ...extra };
      const { card, result } = run(o);
      expect(Math.abs(card.dpi - 300)).toBeLessThan(4);
      expect(Math.abs(result.horizontal.worst - share(o.left, o.right))).toBeLessThan(1);
      expect(Math.abs(result.vertical.worst - share(o.top, o.bottom))).toBeLessThan(1);
    });
  }

  it("reports millimetres within a tenth of a millimetre", () => {
    const { result } = run({ ...base, rotation: 1.1 });
    const mm = result.bordersMm;
    const shortSide = Math.max(Math.abs(mm.left - base.left), Math.abs(mm.right - base.right));
    expect(shortSide).toBeLessThan(0.1);
  });

  it("scores at the worst point of a tilted frame, not the midpoint", () => {
    const { result } = run({ ...base, left: 2.8, right: 2.8, top: 3.2, bottom: 3.2, frameTilt: 0.35 });
    expect(result.horizontal.mid).toBeLessThan(51);
    expect(result.horizontal.worst).toBeGreaterThan(result.horizontal.mid + 1.5);
  });

  it("recognises a card back by its blue border", () => {
    const { card } = run({ ...base, border: BLUE, art: [40, 90, 190] });
    expect(card.side).toBe("back");
  });

  it("recognises a real scanned back, whose swirl is a greyer blue", () => {
    const { card } = run({ ...base, border: [24, 66, 132], art: [120, 134, 158] });
    expect(card.side).toBe("back");
  });

  it("recognises a front with a yellow border", () => {
    const { card } = run(base);
    expect(card.side).toBe("front");
  });

  it("flags a scan under 300 DPI", () => {
    const { card } = run({ ...base, dpi: 150, noise: 1 });
    expect(card.warnings.some((w) => w.includes("DPI"))).toBe(true);
  });

  it("finds each card when a scan holds two", () => {
    const left = synthScan({ ...base, bedW: 2550, bedH: 1500, cardX: 620, cardY: 750 });
    const right = synthScan({ ...base, left: 2.2, right: 3.4, border: BLUE, art: [40, 90, 190], bedW: 2550, bedH: 1500, cardX: 1800, cardY: 750 });
    const merged: Raster = { width: 2550, height: 1500, data: new Uint8ClampedArray(left.data) };
    for (let y = 0; y < 1500; y++) {
      for (let x = 1275; x < 2550; x++) {
        const p = (y * 2550 + x) * 4;
        merged.data[p] = right.data[p];
        merged.data[p + 1] = right.data[p + 1];
        merged.data[p + 2] = right.data[p + 2];
      }
    }
    const cards = analyzeScan(merged, { metadataDpi: 300 });
    expect(cards.length).toBe(2);
    const sides = cards.map((c) => c.side).sort();
    expect(sides).toEqual(["back", "front"]);
  });

  it("flags a reading whose borders don't add up", () => {
    const flagged = run({ ...base, left: 3.1, right: 3.1, top: 2, bottom: 2 }).card;
    expect(flagged.needsReview).toBe(true);
    const consistent = run({ ...base, left: 3.3, right: 2.3, top: 2.0, bottom: 3.6 }).card;
    expect(consistent.needsReview).toBe(false);
  });

  it("gives up cleanly on an image with no card", () => {
    const blank: Raster = { width: 800, height: 600, data: new Uint8ClampedArray(800 * 600 * 4).fill(240) };
    expect(() => analyzeScan(blank, { metadataDpi: null })).toThrow();
  });
});

describe("frame fitting", () => {
  it("keeps all four frame lines square to each other", () => {
    const { card } = run({ ...base, frameTilt: 0.3, rotation: 1 });
    const { left, right, top, bottom } = card.measurement.inner;
    expect(left.b).toBeCloseTo(right.b, 6);
    expect(top.b).toBeCloseTo(bottom.b, 6);
    expect(top.b).toBeCloseTo(-left.b, 6);
  });
});

describe("card order on a scan", () => {
  const at = (cx: number, cy: number): Frame => ({ cx, cy, ex: [1, 0], ey: [0, 1], w: 744, h: 1039 });
  const order = (frames: Frame[]) => readingOrder(frames).map((f) => f.cx);

  it("numbers hand-placed cards the same on the front and back scans", () => {
    // Positions measured from a real pair of scans: two cards up top, not level, and one below.
    expect(order([at(530, 660), at(1470, 680), at(1100, 1920)])).toEqual([530, 1470, 1100]);
    expect(order([at(1660, 945), at(745, 810), at(1060, 2000)])).toEqual([745, 1660, 1060]);
  });
});

describe("other resolutions", () => {
  it("measures a 600 DPI scan", () => {
    const o = { ...base, dpi: 600, rotation: 1.4, bedW: 2000, bedH: 2600 };
    const { card, result } = run(o);
    expect(Math.abs(card.dpi - 600)).toBeLessThan(8);
    expect(Math.abs(result.horizontal.worst - share(o.left, o.right))).toBeLessThan(0.6);
    expect(Math.abs(result.vertical.worst - share(o.top, o.bottom))).toBeLessThan(0.6);
    expect(card.warnings.some((w) => w.includes("DPI"))).toBe(false);
  }, 60000);
});
