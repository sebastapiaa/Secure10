# Secure10

Measures the centering of a Pokémon card from a flatbed scan and scores it against PSA's published tolerances. Centering only: it says nothing about corners, edges or surface.

Everything runs in the browser. Scans never leave your computer, and past scans are stored in that browser's IndexedDB, so they don't follow you to another device and clearing site data removes them.

## Run it

```bash
npm install
npm run dev
```

`npm test` runs the engine checks against synthetic scans with known borders.

## Deploy to Vercel

Push to GitHub and import the repository in Vercel. It's a static Vite site, and `vercel.json` has the settings, so no environment variables or server are needed.

## Scanning for the best reading

- 300 DPI or higher. 600 DPI halves the error from each pixel.
- JPG, PNG, WEBP or TIFF. PDF isn't supported.
- Lid closed and some background visible around the whole card. Several cards on one scan is fine, and each becomes its own entry. A front and a back on the same scan are paired.
- To pair several cards, make one scan of the fronts and one of the backs with the cards in the same layout, then upload both. Cards are numbered top to bottom, left to right, and matched by that number. If you flip cards over in place, left and right swap, so put them back in the original layout before scanning the other side.
- Take the card out of its sleeve or toploader, since their edges read as the card's edge.

## How the score works

| PSA grade | Front | Back |
|---|---|---|
| 10 | 55/45 | 75/25 |
| 9 | 60/40 | 90/10 |
| 8 | 65/35 | 90/10 |
| 7 | 70/30 | 90/10 |
| 6 | 80/20 | 90/10 |
| 5, 4 | 85/15 | 90/10 |
| 3, 2, 1.5 | 90/10 | 90/10 |

Source: [PSA Grading Standards](https://www.psacard.com/gradingstandards), read 2026-11-03. Limits live in `src/engine/score.ts`, so a change at PSA is a one-line edit.

The score is the highest PSA grade whose limit the card meets, on its worse axis, read at the worst point along the side. PSA's own wording says these limits are approximate and that graders may allow small exceptions for eye appeal, so a reading near a limit is marked borderline instead of being treated as exact. With both sides scanned, the whole-card score is the lower of the two.

## How the measurement works

1. Finds the card by flood-filling the background in from the edges of the scan, then fits a rectangle to whatever is left.
2. Walks in from the background at 44 points per side and fits a line through the card edge, ignoring dust and chips.
3. Straightens the card at its original resolution.
4. Finds the printed frame at 56 points per side. A line must span most of the side to count, so copyright text in the bottom border doesn't. The frame is one printed rectangle, so all four lines share one angle, taken from the sides that read cleanly.
5. Reads both axes from the fitted lines and reports the error from the fit.
6. Cross-checks the result. A miscut can't change the total border, so if the total across and the total down disagree, a line is probably wrong and the score is marked provisional.

## Known limits

- **Cards without a clear border**, such as some full arts and rainbow rares, may have no line to find. These are flagged as provisional, and you can drag the lines into place.
- **Sets with a deep border by design**, such as EX-era bottoms and e-card left strips, read as off-center. These are flagged too.
- **A centering score isn't a PSA decision.** Graders work from the physical card and use judgment.
