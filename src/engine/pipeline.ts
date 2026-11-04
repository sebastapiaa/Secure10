import { median, robustSigma } from "./color";
import { fitRobustLine } from "./fit";
import {
  bandProfile,
  crossingBefore,
  distanceSeries,
  findOuterEdges,
  locateCards,
  medianLab,
  type Frame,
  type SideLines,
} from "./locate";
import { CARD_HEIGHT_MM, CARD_WIDTH_MM, lineAt } from "./score";
import type { CardAnalysis, CardSide, Edge, EdgeLines, FitStats, Line, Raster, ScanMeta } from "./types";
import { EDGES } from "./types";

export class NoCardError extends Error {}

function intersect(vertical: Line, horizontal: Line): [number, number] {
  // x = a1 + b1*y and y = a2 + b2*x
  const y = (horizontal.a + horizontal.b * vertical.a) / (1 - horizontal.b * vertical.b);
  return [vertical.a + vertical.b * y, y];
}

/** Rebuilds the frame from fitted edges, removing the card's remaining rotation. */
function refineFrame(frame: Frame, lines: SideLines): Frame {
  const phi = (lines.top.b + lines.bottom.b - lines.left.b - lines.right.b) / 4;
  const corners = [
    intersect(lines.left, lines.top),
    intersect(lines.right, lines.top),
    intersect(lines.right, lines.bottom),
    intersect(lines.left, lines.bottom),
  ];
  const mx = corners.reduce((s, c) => s + c[0], 0) / 4;
  const my = corners.reduce((s, c) => s + c[1], 0) / 4;
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  const ex: [number, number] = [frame.ex[0] * c + frame.ey[0] * s, frame.ex[1] * c + frame.ey[1] * s];
  const ey: [number, number] = [-ex[1], ex[0]];
  const width = ((lines.right.a - lines.left.a) * c + (lines.right.a - lines.left.a)) / 2;
  const height = ((lines.bottom.a - lines.top.a) * c + (lines.bottom.a - lines.top.a)) / 2;
  return {
    cx: frame.cx + frame.ex[0] * mx + frame.ey[0] * my,
    cy: frame.cy + frame.ex[1] * mx + frame.ey[1] * my,
    ex,
    ey,
    w: width,
    h: height,
  };
}

function resampleCrop(src: Raster, frame: Frame, margin: number): Raster {
  const width = Math.round(frame.w + margin * 2);
  const height = Math.round(frame.h + margin * 2);
  const data = new Uint8ClampedArray(width * height * 4);
  const W = src.width;
  const H = src.height;
  const s = src.data;
  for (let y = 0; y < height; y++) {
    const fy = y + 0.5 - height / 2;
    for (let x = 0; x < width; x++) {
      const fx = x + 0.5 - width / 2;
      const sx = frame.cx + frame.ex[0] * fx + frame.ey[0] * fy - 0.5;
      const sy = frame.cy + frame.ex[1] * fx + frame.ey[1] * fy - 0.5;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const o = (y * width + x) * 4;
      data[o + 3] = 255;
      if (x0 < 0 || y0 < 0 || x0 >= W - 1 || y0 >= H - 1) {
        const cx = Math.max(0, Math.min(W - 1, Math.round(sx)));
        const cy = Math.max(0, Math.min(H - 1, Math.round(sy)));
        const p = (cy * W + cx) * 4;
        data[o] = s[p];
        data[o + 1] = s[p + 1];
        data[o + 2] = s[p + 2];
        continue;
      }
      const dx = sx - x0;
      const dy = sy - y0;
      const p = (y0 * W + x0) * 4;
      const q = p + W * 4;
      for (let c = 0; c < 3; c++) {
        data[o + c] =
          s[p + c] * (1 - dx) * (1 - dy) + s[p + 4 + c] * dx * (1 - dy) + s[q + c] * (1 - dx) * dy + s[q + 4 + c] * dx * dy;
      }
    }
  }
  return { width, height, data };
}

/** Frame-centred line to crop pixel coordinates. */
function toCropCoords(lines: SideLines, cx: number, cy: number): EdgeLines {
  const vertical = (l: Line): Line => ({ a: cx + l.a - l.b * cy, b: l.b });
  const horizontal = (l: Line): Line => ({ a: cy + l.a - l.b * cx, b: l.b });
  return {
    left: vertical(lines.left),
    right: vertical(lines.right),
    top: horizontal(lines.top),
    bottom: horizontal(lines.bottom),
  };
}

interface InnerResult {
  line: Line;
  stats: FitStats;
  contrast: number;
  /** Typical colour noise inside the border. Foil reads high, plain print low. */
  noise: number;
  /** Re-reads this side with the line's angle fixed, keeping only the position free. */
  refit: (slope: number, slopeError: number) => { line: Line; stats: FitStats; contrast: number };
}

/** The position of a line of known slope that the most readings agree on. */
function bestOffset(xs: number[], ys: number[], slope: number, threshold: number) {
  const residuals = xs.map((x, i) => ys[i] - slope * x);
  let bestCount = 0;
  let offset = median(residuals);
  for (const candidate of residuals) {
    const agreeing = residuals.filter((r) => Math.abs(r - candidate) <= threshold);
    if (agreeing.length > bestCount) {
      bestCount = agreeing.length;
      offset = agreeing.reduce((sum, r) => sum + r, 0) / agreeing.length;
    }
  }
  const inliers = residuals.filter((r) => Math.abs(r - offset) <= threshold);
  const rms = inliers.length ? Math.sqrt(inliers.reduce((sum, r) => sum + (r - offset) ** 2, 0) / inliers.length) : 0;
  return { offset, count: inliers.length, rms };
}

/**
 * Finds the inner frame line on one side of a straightened crop: the point where the printed border
 * stops. Takes the depth where most of the side changes colour together first, which small print in the
 * border cannot do, then locates the change at each station to sub-pixel accuracy.
 */
function findInnerEdge(crop: Raster, outer: EdgeLines, edge: Edge, pxPerMm: number): InnerResult | null {
  const horizontalEdge = edge === "top" || edge === "bottom";
  const inwardSign = edge === "left" || edge === "top" ? 1 : -1;
  const outerLine = outer[edge];
  const midCross = horizontalEdge
    ? (lineAt(outer.left, crop.height / 2) + lineAt(outer.right, crop.height / 2)) / 2
    : (lineAt(outer.top, crop.width / 2) + lineAt(outer.bottom, crop.width / 2)) / 2;
  const [crossA, crossB] = horizontalEdge ? [outer.left, outer.right] : [outer.top, outer.bottom];
  const from = lineAt(crossA, horizontalEdge ? crop.height / 2 : midCross);
  const to = lineAt(crossB, horizontalEdge ? crop.height / 2 : midCross);

  const stations = 56;
  const depth = Math.round(pxPerMm * 12);
  const band = Math.max(3, Math.round(pxPerMm * 0.5));
  const refFrom = Math.max(2, Math.round(pxPerMm * 0.35));
  const refTo = Math.max(refFrom + 3, Math.round(pxPerMm * 1));
  const hold = Math.round(pxPerMm * 1.2);

  const us: number[] = [];
  const series: Float32Array[] = [];
  const thresholds: number[] = [];
  for (let i = 0; i < stations; i++) {
    const u = from + (to - from) * (0.14 + (0.72 * i) / (stations - 1));
    const v0 = lineAt(outerLine, u);
    const profile = horizontalEdge
      ? bandProfile(crop, u, v0, 0, inwardSign, 1, 0, band, depth)
      : bandProfile(crop, v0, u, inwardSign, 0, 0, 1, band, depth);
    const ref = medianLab(profile, refFrom, refTo);
    const dist = distanceSeries(profile, ref);
    const smooth = new Float32Array(dist.length);
    for (let k = 0; k < dist.length; k++) {
      smooth[k] = (dist[Math.max(0, k - 1)] + 2 * dist[k] + dist[Math.min(dist.length - 1, k + 1)]) / 4;
    }
    series.push(smooth);
    us.push(u);
    thresholds.push(Math.max(5, Math.min(16, 4 * robustSigma(smooth.subarray(refFrom, refTo), 0))));
  }

  // The frame runs the whole side, so it must show up in at least two of three zones along it. Copyright
  // lines in the bottom border sit in the middle and fail this however much of the side they cover.
  const fraction = new Float32Array(depth);
  const zonesLit = new Uint8Array(depth);
  const zoneSize = Math.floor(stations / 3);
  for (let d = 0; d < depth; d++) {
    let n = 0;
    let lit = 0;
    for (let zone = 0; zone < 3; zone++) {
      let inZone = 0;
      const end = zone === 2 ? stations : (zone + 1) * zoneSize;
      for (let i = zone * zoneSize; i < end; i++) if (series[i][d] > thresholds[i]) inZone++;
      n += inZone;
      if (inZone / (end - zone * zoneSize) >= 0.6) lit++;
    }
    fraction[d] = n / stations;
    zonesLit[d] = lit;
  }
  let coarse = -1;
  for (let d = refFrom; d < depth - hold; d++) {
    if (fraction[d] < 0.55 || zonesLit[d] < 2) continue;
    let sum = 0;
    for (let k = d; k < d + hold; k++) sum += fraction[k];
    if (sum / hold >= 0.5) {
      coarse = d;
      break;
    }
  }
  if (coarse < 0) return null;

  const locate = (centerAt: (u: number) => number, reach: number) => {
    const xs: number[] = [];
    const ys: number[] = [];
    const plateaus: number[] = [];
    for (let i = 0; i < stations; i++) {
      const s = series[i];
      // Start past the frame and walk back to where this run of colour begins. Walking forward from the
      // outer edge would stop on any small print first.
      const lo = Math.max(1, Math.floor(centerAt(us[i]) - reach * 1.5));
      const hi = Math.min(depth - 3, Math.ceil(centerAt(us[i]) + reach));
      let start = hi;
      while (start > lo && s[start] <= thresholds[i]) start--;
      let hit = -1;
      if (start > lo) {
        hit = start;
        while (hit > lo && s[hit - 1] > thresholds[i]) hit--;
      }
      if (hit < 0) continue;
      const plateau = median(s.subarray(hit + 1, Math.min(depth, hit + 1 + Math.round(pxPerMm * 0.8))));
      xs.push(us[i]);
      ys.push(crossingBefore(s, hit + 1, plateau / 2, Math.max(0, lo - 2)));
      plateaus.push(plateau);
    }
    return { xs, ys, plateaus };
  };

  const threshold = Math.max(0.8, pxPerMm * 0.07);
  const first = locate(() => coarse, pxPerMm * 0.6);
  const roughFit = fitRobustLine(first.xs, first.ys, threshold * 1.5);
  if (!roughFit) return null;
  const second = locate((u) => lineAt(roughFit.line, u), Math.max(3, pxPerMm * 0.35));
  const fit = fitRobustLine(second.xs, second.ys, threshold);
  if (!fit) return null;

  // Depth readings back to absolute crop coordinates.
  const line: Line = {
    a: outerLine.a + inwardSign * fit.line.a,
    b: outerLine.b + inwardSign * fit.line.b,
  };
  const span = Math.abs(to - from);
  const refit: InnerResult["refit"] = (slope, slopeError) => {
    const depthSlope = inwardSign * (slope - outerLine.b);
    const rough = bestOffset(first.xs, first.ys, depthSlope, threshold * 1.5);
    const near = locate((u) => rough.offset + depthSlope * u, Math.max(3, pxPerMm * 0.35));
    const best = near.xs.length >= 4 ? bestOffset(near.xs, near.ys, depthSlope, threshold) : { ...rough, count: 0 };
    return {
      line: { a: outerLine.a + inwardSign * best.offset, b: slope },
      stats: {
        samples: stations,
        inlierRatio: best.count / stations,
        rms: best.rms,
        // The score reads this line near the ends of the span, so the shared angle's error counts too.
        se: Math.hypot(best.rms / Math.sqrt(Math.max(1, best.count)), slopeError * 0.36 * span),
      },
      contrast: near.plateaus.length ? median(near.plateaus) : 0,
    };
  };

  return {
    line,
    stats: { ...fit.stats, samples: stations, inlierRatio: fit.stats.inlierRatio * (second.xs.length / stations) },
    contrast: median(second.plateaus),
    noise: median(thresholds),
    refit,
  };
}

/** Slope that a tilt of phi gives a line on this edge. Top and bottom tilt opposite to left and right. */
function slopeFor(edge: Edge, phi: number): number {
  return edge === "top" || edge === "bottom" ? phi : -phi;
}

const FRAME_ANGLE_TOLERANCE = 0.0052; // 0.3 degrees

/**
 * The printed frame is one rectangle, so all four sides share one tilt. Takes it from the sides that read
 * cleanly and agree with each other. With no such agreement, foil or art has fooled the fit, so it falls
 * back on the angle of the cut, which real frames stay very close to.
 */
function frameTilt(found: Partial<Record<Edge, InnerResult>>, outer: EdgeLines, pxPerMm: number) {
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  const outerPhi = mean(EDGES.map((e) => (e === "top" || e === "bottom" ? outer[e].b : -outer[e].b)));
  const clean = EDGES.flatMap((edge) => {
    const r = found[edge];
    if (!r || r.stats.inlierRatio < 0.7 || r.stats.rms > Math.max(1, pxPerMm * 0.085)) return [];
    return [edge === "top" || edge === "bottom" ? r.line.b : -r.line.b];
  });
  let best: number[] = [];
  for (const candidate of clean) {
    const group = clean.filter((phi) => Math.abs(phi - candidate) <= FRAME_ANGLE_TOLERANCE);
    if (group.length > best.length || (group.length === best.length && Math.abs(mean(group) - outerPhi) < Math.abs(mean(best) - outerPhi))) {
      best = group;
    }
  }
  if (best.length < 2) return { phi: outerPhi, error: FRAME_ANGLE_TOLERANCE / 2 };
  return { phi: mean(best), error: Math.max(0.0005, (Math.max(...best) - Math.min(...best)) / 2) };
}

function guessSide(crop: Raster, outer: EdgeLines, inner: EdgeLines): CardSide {
  const sample = (x0: number, x1: number, y0: number, y1: number) => {
    const a: number[] = [];
    const b: number[] = [];
    for (let y = Math.round(y0); y < y1; y += 3) {
      const profile = bandProfile(crop, x0, y, 1, 0, 0, 0, 0, Math.max(1, Math.round((x1 - x0) / 3)));
      for (let k = 0; k < profile.length / 3; k++) {
        a.push(profile[k * 3 + 1]);
        b.push(profile[k * 3 + 2]);
      }
    }
    return { a: median(a), b: median(b) };
  };
  const midY = crop.height / 2;
  const borderLeft = sample(lineAt(outer.left, midY) + 2, lineAt(inner.left, midY) - 2, midY - 60, midY + 60);
  const interior = sample(
    lineAt(inner.left, midY) + 20,
    lineAt(inner.right, midY) - 20,
    lineAt(inner.top, crop.width / 2) + 20,
    lineAt(inner.bottom, crop.width / 2) - 20,
  );
  // No Pokémon front has a saturated blue border. The back's swirl scans as a greyer blue than a clean render.
  return borderLeft.b < -18 && interior.b < -2 ? "back" : "front";
}

export function analyzeScan(src: Raster, meta: ScanMeta): CardAnalysis[] {
  const located = locateCards(src);
  if (located.frames.length === 0) {
    throw new NoCardError(
      "Couldn't find a card in this scan. Scan on a plain background with the lid closed, and keep the whole card inside the scan area.",
    );
  }
  return located.frames.map((frame) => analyzeCard(src, frame, meta, located.tight, located.background.lab, located.frames.length > 1));
}

function analyzeCard(
  src: Raster,
  initial: Frame,
  meta: ScanMeta,
  tight: boolean,
  bgLab: [number, number, number],
  crowded: boolean,
): CardAnalysis {
  const warnings: string[] = [];
  let needsReview = false;

  let frame = initial;
  let crop: Raster;
  let outer: EdgeLines;
  let margin: number;

  if (tight) {
    margin = 0;
    crop = src;
    frame = { ...initial, w: src.width, h: src.height };
    outer = {
      left: { a: 0, b: 0 },
      right: { a: src.width, b: 0 },
      top: { a: 0, b: 0 },
      bottom: { a: src.height, b: 0 },
    };
    warnings.push("This file is already cropped to the card, so its edges were taken as the card's edges. Scan with some background around the card for a more accurate reading.");
    needsReview = true;
  } else {
    const roughPxPerMm = (initial.h / CARD_HEIGHT_MM + initial.w / CARD_WIDTH_MM) / 2;
    // A silver border on a white lid can read as background, leaving the first estimate at the art.
    // Starting well outside lets the walk from the background still find the true edge.
    const outside = Math.round(roughPxPerMm * (crowded ? 2.5 : 8));
    const inside = Math.round(roughPxPerMm * 3);
    let pass = findOuterEdges(src, frame, outside, inside, roughPxPerMm, bgLab);
    frame = refineFrame(frame, pass.lines);
    const pxPerMm = (frame.h / CARD_HEIGHT_MM + frame.w / CARD_WIDTH_MM) / 2;
    pass = findOuterEdges(src, frame, Math.round(pxPerMm * 2.5), Math.round(pxPerMm * 1.5), pxPerMm, bgLab);
    frame = refineFrame(frame, pass.lines);

    margin = Math.round(pxPerMm * 2.5);
    crop = resampleCrop(src, frame, margin);
    const center: Frame = { cx: crop.width / 2, cy: crop.height / 2, ex: [1, 0], ey: [0, 1], w: frame.w, h: frame.h };
    const finalPass = findOuterEdges(crop, center, margin - 2, Math.round(pxPerMm * 1.5), pxPerMm, bgLab);
    outer = toCropCoords(finalPass.lines, crop.width / 2, crop.height / 2);
    if (EDGES.some((e) => !finalPass.ok[e]) || finalPass.inlierRatio < 0.6) {
      warnings.push("One or more card edges were hard to separate from the background. Check the outer lines.");
      needsReview = true;
    }
  }

  const widthPx = lineAt(outer.right, crop.height / 2) - lineAt(outer.left, crop.height / 2);
  const heightPx = lineAt(outer.bottom, crop.width / 2) - lineAt(outer.top, crop.width / 2);
  const dpi = ((widthPx / CARD_WIDTH_MM + heightPx / CARD_HEIGHT_MM) / 2) * 25.4;
  const pxPerMm = dpi / 25.4;

  const inner = {} as EdgeLines;
  const fits: Partial<Record<Edge, FitStats>> = {};
  const readings: Partial<Record<Edge, InnerResult>> = {};
  for (const edge of EDGES) {
    const reading = findInnerEdge(crop, outer, edge, pxPerMm);
    if (reading) readings[edge] = reading;
  }
  const tilt = frameTilt(readings, outer, pxPerMm);
  const side = guessSide(crop, outer, {
    left: readings.left?.line ?? { a: outer.left.a + pxPerMm * 3, b: outer.left.b },
    right: readings.right?.line ?? { a: outer.right.a - pxPerMm * 3, b: outer.right.b },
    top: readings.top?.line ?? { a: outer.top.a + pxPerMm * 3, b: outer.top.b },
    bottom: readings.bottom?.line ?? { a: outer.bottom.a - pxPerMm * 3, b: outer.bottom.b },
  });
  const unclearEdges: Edge[] = [];
  for (const edge of EDGES) {
    const reading = readings[edge];
    if (reading) {
      const slope = slopeFor(edge, tilt.phi);
      const found = reading.refit(slope, tilt.error);
      inner[edge] = found.line;
      fits[edge] = found.stats;
      const wandered = Math.abs(reading.line.b - slope) > FRAME_ANGLE_TOLERANCE;
      const unclear = found.stats.inlierRatio < 0.55 || found.stats.rms > Math.max(1.2, pxPerMm * 0.1);
      // Backs aren't foil. Their frame is just a soft blue-on-blue edge, which reads fine.
      const foil = side !== "back" && (reading.noise >= 12 || found.contrast < 1.5 * reading.noise);
      if (wandered || unclear || foil) {
        unclearEdges.push(edge);
      }
    } else {
      const sign = edge === "left" || edge === "top" ? 1 : -1;
      inner[edge] = { a: outer[edge].a + sign * pxPerMm * 3, b: outer[edge].b };
      warnings.push(`No printed frame found on the ${edge}, as on a borderless card. Place that line by hand.`);
      needsReview = true;
    }
  }

  if (unclearEdges.length > 0) {
    const list = new Intl.ListFormat("en").format(unclearEdges);
    warnings.push(`No clear frame on the ${list}, which is common on foil and full-art cards. Check ${unclearEdges.length > 1 ? "those lines" : "that line"} by eye.`);
    needsReview = true;
  }

  // A cropped-looking file with no printed frame on most sides is not a scan of a card at all.
  if (tight && Object.keys(fits).length < 2) {
    throw new NoCardError("Couldn't find a card in this image. Scan the card on a plain background and keep the whole card in view.");
  }

  const expected = CARD_WIDTH_MM / CARD_HEIGHT_MM;
  const measured = widthPx / heightPx;
  const widthMm = widthPx / pxPerMm;
  const heightMm = heightPx / pxPerMm;
  if (Math.abs(measured - expected) / expected > 0.025) {
    warnings.push(`Card shape measures ${(heightPx / widthPx).toFixed(3)}:1 against 1.397:1 for a standard card. Check the outer lines.`);
    needsReview = true;
  }
  if (dpi < 285) {
    warnings.push(`This scan works out to about ${Math.round(dpi)} DPI. Rescan at 300 DPI or higher: each pixel lost widens the error on the ratio.`);
  }
  if (meta.metadataDpi && Math.abs(meta.metadataDpi - dpi) / dpi > 0.05 && !tight) {
    warnings.push(`The file says ${Math.round(meta.metadataDpi)} DPI but the card measures as ${Math.round(dpi)} DPI. The ratio is unaffected unless the image was stretched.`);
  }

  const measurement = { outer, inner, fits };

  const widthAt = (edge: Edge) => {
    const sign = edge === "left" || edge === "top" ? 1 : -1;
    const across = edge === "left" || edge === "right" ? crop.height / 2 : crop.width / 2;
    return (sign * (lineAt(inner[edge], across) - lineAt(outer[edge], across))) / pxPerMm;
  };

  // A miscut moves the print inside the cut but can't change how much border there is in total. Fronts
  // print about the same total both ways, and backs about 0.8 mm more down than across. A mismatch means a line landed on something other than the frame,
  // as on a silver Trainer card whose frame fades into its top panel.
  const totalAcross = widthAt("left") + widthAt("right");
  const totalDown = widthAt("top") + widthAt("bottom");
  const expectedExtraDown = side === "back" ? 0.8 : 0;
  if (Math.abs(totalDown - totalAcross - expectedExtraDown) > 0.45) {
    warnings.push(`The borders don't add up: ${totalAcross.toFixed(2)} mm across against ${totalDown.toFixed(2)} mm down, which doesn't match how this side is printed. A line is probably on the wrong feature, so check them all.`);
    needsReview = true;
  }

  // EX-era bottoms and e-card left strips are printed deep on purpose, which reads as a miscut.
  for (const edge of EDGES) {
    const others = EDGES.filter((e) => e !== edge).map(widthAt);
    if (widthAt(edge) > 3.8 && widthAt(edge) > 1.7 * median(others)) {
      warnings.push(`The ${edge} border is far deeper than the others. Some sets print it that way (EX-era bottoms, e-card left strips), so this may not be a miscut. Check that line.`);
      needsReview = true;
    }
  }
  const angle = (Math.atan2(frame.ex[1], frame.ex[0]) * 180) / Math.PI;

  return {
    crop,
    measurement,
    side,
    dpi,
    rotation: Math.abs(angle) > 45 ? angle - Math.sign(angle) * 90 : angle,
    widthMm,
    heightMm,
    warnings,
    needsReview,
  };
}
