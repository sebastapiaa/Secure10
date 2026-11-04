import type { AxisReading, CardSide, CenteringResult, Edge, EdgeLines, Line, Measurement } from "./types";

export const CARD_WIDTH_MM = 63;
export const CARD_HEIGHT_MM = 88;

/**
 * Tolerances from PSA's Grading Standards, psacard.com/gradingstandards, read 2026-11-03.
 * Limit is the largest allowed share: 55 means 55/45. PSA 1 has no centering requirement.
 */
export const PSA_TOLERANCES: { grade: number; label: string; front: number; back: number }[] = [
  { grade: 10, label: "Gem Mint", front: 55, back: 75 },
  { grade: 9, label: "Mint", front: 60, back: 90 },
  { grade: 8, label: "NM-MT", front: 65, back: 90 },
  { grade: 7, label: "NM", front: 70, back: 90 },
  { grade: 6, label: "EX-MT", front: 80, back: 90 },
  { grade: 5, label: "EX", front: 85, back: 90 },
  { grade: 4, label: "VG-EX", front: 85, back: 90 },
  { grade: 3, label: "VG", front: 90, back: 90 },
  { grade: 2, label: "Good", front: 90, back: 90 },
  { grade: 1.5, label: "Fair", front: 90, back: 90 },
];

/** The highest PSA grade whose centering tolerance this share satisfies. */
export function scoreForShare(share: number, side: CardSide): number {
  for (const row of PSA_TOLERANCES) {
    if (share <= row[side]) return row.grade;
  }
  return 1;
}

export function lineAt(line: Line, u: number): number {
  return line.a + line.b * u;
}

/** Share of the two borders, measured from the far ends of the sampled span of the side. */
function readAxis(
  outerA: Line,
  innerA: Line,
  outerB: Line,
  innerB: Line,
  from: number,
  to: number,
  seA: number,
  seB: number,
): AxisReading {
  const widths = (u: number) => {
    const a = Math.max(0, lineAt(innerA, u) - lineAt(outerA, u));
    const b = Math.max(0, lineAt(outerB, u) - lineAt(innerB, u));
    return { a, b, share: a + b > 0 ? (Math.max(a, b) / (a + b)) * 100 : 100 };
  };
  const start = widths(from);
  const end = widths(to);
  const mid = widths((from + to) / 2);
  // Borders change linearly along the side, so the worst point is always at one end of the span.
  const worst = start.share >= end.share ? start : end;
  const total = worst.a + worst.b;
  const uncertainty =
    total > 0 ? (Math.hypot(worst.b * seA, worst.a * seB) / (total * total)) * 100 : 100;
  return { a: worst.a, b: worst.b, worst: worst.share, mid: mid.share, uncertainty };
}

function spanOf(edgeA: Line, edgeB: Line, crossAt: number): [number, number] {
  const a = lineAt(edgeA, crossAt);
  const b = lineAt(edgeB, crossAt);
  return [a + 0.14 * (b - a), a + 0.86 * (b - a)];
}

/** Lower bound on the error of any one edge: half a sensor element blurred by the scanner. */
const EDGE_NOISE_FLOOR_PX = 0.2;
/** A line placed by hand is only as good as the person's eye. */
const HAND_PLACED_SE_PX = 0.5;

export function computeCentering(m: Measurement, side: CardSide, pxPerMm: number): CenteringResult {
  const se = (edge: Edge) => {
    const fit = m.fits[edge];
    const inner = fit ? fit.se : HAND_PLACED_SE_PX;
    return Math.hypot(inner, EDGE_NOISE_FLOOR_PX);
  };
  const midX = (lineAt(m.outer.left, 0) + lineAt(m.outer.right, 0)) / 2;
  const midY = (lineAt(m.outer.top, 0) + lineAt(m.outer.bottom, 0)) / 2;
  const [yFrom, yTo] = spanOf(m.outer.top, m.outer.bottom, midX);
  const [xFrom, xTo] = spanOf(m.outer.left, m.outer.right, midY);

  const horizontal = readAxis(m.outer.left, m.inner.left, m.outer.right, m.inner.right, yFrom, yTo, se("left"), se("right"));
  const vertical = readAxis(m.outer.top, m.inner.top, m.outer.bottom, m.inner.bottom, xFrom, xTo, se("top"), se("bottom"));

  const limiting = horizontal.worst >= vertical.worst ? "horizontal" : "vertical";
  const axis = limiting === "horizontal" ? horizontal : vertical;
  const worst = axis.worst;
  const uncertainty = axis.uncertainty;
  const score = scoreForShare(worst, side);
  const scoreLow = scoreForShare(worst + uncertainty, side);
  const scoreHigh = scoreForShare(Math.max(50, worst - uncertainty), side);

  const border = (outer: Line, inner: Line, u: number) => Math.abs(lineAt(inner, u) - lineAt(outer, u)) / pxPerMm;
  const yMid = (yFrom + yTo) / 2;
  const xMid = (xFrom + xTo) / 2;
  const bordersMm: Record<Edge, number> = {
    left: border(m.outer.left, m.inner.left, yMid),
    right: border(m.outer.right, m.inner.right, yMid),
    top: border(m.outer.top, m.inner.top, xMid),
    bottom: border(m.outer.bottom, m.inner.bottom, xMid),
  };

  return {
    side,
    horizontal,
    vertical,
    limiting,
    worst,
    uncertainty,
    score,
    scoreLow,
    scoreHigh,
    borderline: scoreLow !== scoreHigh,
    bordersMm,
  };
}

/** Score for a whole card: PSA requires both sides to pass, so the lower one decides. */
export function combineScores(front: number | undefined, back: number | undefined): number | undefined {
  if (front === undefined) return back;
  if (back === undefined) return front;
  return Math.min(front, back);
}

export function isEdges(lines: EdgeLines): boolean {
  return Boolean(lines.left && lines.right && lines.top && lines.bottom);
}
