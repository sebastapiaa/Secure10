export interface Raster {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  data: Uint8ClampedArray;
}

/** v = a + b * u. Left/right edges use x = a + b*y; top/bottom edges use y = a + b*x. */
export interface Line {
  a: number;
  b: number;
}

export type Edge = "left" | "right" | "top" | "bottom";
export const EDGES: Edge[] = ["left", "right", "top", "bottom"];

export type EdgeLines = Record<Edge, Line>;

export interface FitStats {
  /** Stations that produced a usable edge reading. */
  samples: number;
  /** Share of readings that agree with the fitted line. */
  inlierRatio: number;
  /** Residual of the agreeing readings, px. */
  rms: number;
  /** Standard error of the line near the middle of the side, px. */
  se: number;
}

export type CardSide = "front" | "back";

export interface Measurement {
  outer: EdgeLines;
  inner: EdgeLines;
  /** Fit quality of each inner frame line. Absent once a line is moved by hand. */
  fits: Partial<Record<Edge, FitStats>>;
}

export interface AxisReading {
  /** Border widths at the worst point along this axis, px. */
  a: number;
  b: number;
  /** Larger share at the worst point, e.g. 56.2 for 56.2/43.8. */
  worst: number;
  /** Larger share halfway along the side. */
  mid: number;
  /** Measurement uncertainty on the share, in percentage points. */
  uncertainty: number;
}

export interface CenteringResult {
  side: CardSide;
  horizontal: AxisReading;
  vertical: AxisReading;
  /** The axis that decides the score. */
  limiting: "horizontal" | "vertical";
  /** Larger share on the limiting axis. */
  worst: number;
  uncertainty: number;
  score: number;
  /** Scores reachable within the measurement uncertainty. */
  scoreLow: number;
  scoreHigh: number;
  borderline: boolean;
  bordersMm: Record<Edge, number>;
}

export interface CardAnalysis {
  crop: Raster;
  measurement: Measurement;
  side: CardSide;
  dpi: number;
  /** Rotation removed from the scan, degrees. */
  rotation: number;
  widthMm: number;
  heightMm: number;
  warnings: string[];
  /** True if the automatic reading should be checked by eye before trusting it. */
  needsReview: boolean;
}

export interface ScanMeta {
  /** Resolution stored in the file, if any. */
  metadataDpi: number | null;
}
