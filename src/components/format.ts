export function formatScore(score: number | undefined): string {
  return score === undefined ? "–" : String(score);
}

/** "56.2 / 43.8". One decimal, because at 300 DPI one pixel moves the ratio by about one point. */
export function formatRatio(share: number): string {
  return `${share.toFixed(1)} / ${(100 - share).toFixed(1)}`;
}
