import { useEffect, useRef, useState } from "react";
import { PSA_TOLERANCES, combineScores, computeCentering } from "../engine/score";
import type { AxisReading, CardSide, CenteringResult, Measurement } from "../engine/types";
import type { ScanRecord, SideScan } from "../store";
import { CardView } from "./CardView";
import { formatRatio, formatScore } from "./format";

function useObjectUrl(blob: Blob | undefined) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) {
      setUrl(undefined);
      return;
    }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

function AxisRow({ label, sides, axis, limiting, mmA, mmB }: { label: string; sides: [string, string]; axis: AxisReading; limiting: boolean; mmA: number; mmB: number }) {
  const shareA = axis.a + axis.b > 0 ? (axis.a / (axis.a + axis.b)) * 100 : 50;
  return (
    <div className={"axis" + (limiting ? " limiting" : "")}>
      <div className="axis-head">
        <span>{label}</span>
        {limiting && <span className="tag">Decides score</span>}
      </div>
      <div className="axis-ratio">{formatRatio(axis.worst)}</div>
      <div className="axis-bar" role="img" aria-label={`${sides[0]} ${shareA.toFixed(1)} percent, ${sides[1]} ${(100 - shareA).toFixed(1)} percent`}>
        <span style={{ width: `${shareA}%` }} />
        <i />
      </div>
      <div className="axis-sides">
        <span>
          {sides[0]} {mmA.toFixed(2)} mm
        </span>
        <span>
          {mmB.toFixed(2)} mm {sides[1]}
        </span>
      </div>
      <div className="axis-note">
        Worst point. Midpoint reads {formatRatio(axis.mid)}, ±{axis.uncertainty.toFixed(1)} points
      </div>
    </div>
  );
}

function Ladder({ side, score }: { side: CardSide; score: number }) {
  return (
    <details className="ladder">
      <summary>PSA tolerances</summary>
      <table>
        <thead>
          <tr>
            <th scope="col">Grade</th>
            <th scope="col">{side === "front" ? "Front limit" : "Back limit"}</th>
          </tr>
        </thead>
        <tbody>
          {PSA_TOLERANCES.map((row) => (
            <tr key={row.grade} className={row.grade === score ? "here" : ""}>
              <td>
                {row.grade} {row.label}
              </td>
              <td>
                {row[side]}/{100 - row[side]}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        From <a href="https://www.psacard.com/gradingstandards" target="_blank" rel="noreferrer">PSA's Grading Standards</a>, which call most of these limits approximate and allow small exceptions for eye appeal.
      </p>
    </details>
  );
}

function ScoreBlock({ result, scan, provisional }: { result: CenteringResult; scan: SideScan; provisional: boolean }) {
  return (
    <div className="score-block">
      <div className={"score-number" + (provisional ? " provisional" : "")}>{result.score}</div>
      <div className="score-caption">
        <strong>{result.side === "front" ? "Front" : "Back"} centering score</strong>
        <span>Highest PSA grade this {result.side}'s centering allows</span>
        {result.borderline && !provisional && (
          <span className="pill warn">
            Borderline: could read {result.scoreHigh} or {result.scoreLow}
          </span>
        )}
        {provisional && <span className="pill warn">Provisional: check the lines</span>}
        {scan.adjusted && <span className="pill">Adjusted by hand</span>}
      </div>
    </div>
  );
}

interface Props {
  record: ScanRecord | null;
  activeSide: CardSide;
  onActiveSide: (side: CardSide) => void;
  onMeasurement: (side: CardSide, m: Measurement, adjusted: boolean) => void;
  onSwapSide: (from: CardSide) => void;
  onAddSide: (file: File, side: CardSide) => void;
  onRename: (name: string) => void;
  busy: string | null;
}

export function CurrentPanel({ record, activeSide, onActiveSide, onMeasurement, onSwapSide, onAddSide, onRename, busy }: Props) {
  const scan = record?.sides[activeSide];
  const url = useObjectUrl(scan?.crop);
  const [live, setLive] = useState<Measurement | null>(null);
  const otherInput = useRef<HTMLInputElement>(null);

  useEffect(() => setLive(null), [record?.id, activeSide, scan?.adjusted]);

  if (!record) {
    return (
      <section className="panel current empty" aria-labelledby="current-title">
        <h2 id="current-title">Current scan</h2>
        <div className="empty-body">
          <div className="empty-card" aria-hidden="true">
            <i />
          </div>
          <p>Import a scan and the card's measurements appear here.</p>
          <ol>
            <li>Finds the card on the scan and straightens it</li>
            <li>Fits the card edges and the printed frame on all four sides</li>
            <li>Reads left/right and top/bottom at the most off-center point</li>
            <li>Scores the result against PSA's front or back limits</li>
          </ol>
        </div>
      </section>
    );
  }

  const pxPerMm = scan ? scan.dpi / 25.4 : 11.8;
  const measurement = live ?? scan?.measurement;
  const result = scan && measurement ? computeCentering(measurement, activeSide, pxPerMm) : null;
  const scoreOf = (side: CardSide) => {
    const s = record.sides[side];
    return s ? computeCentering(side === activeSide && live ? live : s.measurement, side, s.dpi / 25.4).score : undefined;
  };
  const front = scoreOf("front");
  const back = scoreOf("back");
  const cardScore = combineScores(front, back);
  const otherSide: CardSide = activeSide === "front" ? "back" : "front";
  const provisional = Boolean(scan?.needsReview && !scan.adjusted);

  return (
    <section className="panel current" aria-labelledby="current-title">
      <div className="current-head">
        <div>
          <h2 id="current-title">Current scan</h2>
          <input className="name-input" aria-label="Scan name" value={record.name} onChange={(e) => onRename(e.target.value)} />
        </div>
        <div className="side-tabs" role="tablist" aria-label="Card side">
          {(["front", "back"] as const).map((side) => (
            <button key={side} type="button" role="tab" aria-selected={activeSide === side} className={activeSide === side ? "on" : ""} onClick={() => onActiveSide(side)}>
              {side === "front" ? "Front" : "Back"}
              <span className="tab-score">{formatScore(side === "front" ? front : back)}</span>
            </button>
          ))}
        </div>
      </div>

      {scan && url && measurement && result ? (
        <div className="workspace">
          <div className="card-column">
            <CardView
              url={url}
              width={scan.cropWidth}
              height={scan.cropHeight}
              measurement={measurement}
              onChange={(m, final) => {
                if (final) {
                  setLive(null);
                  onMeasurement(activeSide, m, true);
                } else {
                  setLive(m);
                }
              }}
            />
            <div className="card-legend">
              <span>
                <i className="swatch outer" /> Card edge
              </span>
              <span>
                <i className="swatch inner" /> Printed frame
              </span>
              <span className="legend-hint">Drag a line to correct it, or focus it and use the arrow keys</span>
            </div>
          </div>
          <div className="readout">
            <ScoreBlock result={result} scan={scan} provisional={provisional} />

            {front !== undefined && back !== undefined && (
              <div className="whole-card">
                <span>Whole card, front and back</span>
                <strong>{cardScore}</strong>
              </div>
            )}

            {scan.warnings.length > 0 && (
              <ul className="warnings">
                {scan.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}

            <AxisRow label="Left / right" sides={["L", "R"]} axis={result.horizontal} limiting={result.limiting === "horizontal"} mmA={result.bordersMm.left} mmB={result.bordersMm.right} />
            <AxisRow label="Top / bottom" sides={["T", "B"]} axis={result.vertical} limiting={result.limiting === "vertical"} mmA={result.bordersMm.top} mmB={result.bordersMm.bottom} />

            <dl className="facts">
              <div>
                <dt>Resolution</dt>
                <dd>{Math.round(scan.dpi)} DPI</dd>
              </div>
              <div>
                <dt>Straightened</dt>
                <dd>{Math.abs(scan.rotation).toFixed(2)}°</dd>
              </div>
              <div>
                <dt>Card size</dt>
                <dd>
                  {scan.widthMm.toFixed(1)} × {scan.heightMm.toFixed(1)} mm
                </dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd title={scan.fileName}>{scan.fileName}</dd>
              </div>
            </dl>

            <div className="actions">
              {!record.sides[otherSide] && (
                <button type="button" className="primary" disabled={Boolean(busy)} onClick={() => otherInput.current?.click()}>
                  Add {otherSide} scan
                </button>
              )}
              <button type="button" onClick={() => onSwapSide(activeSide)}>
                This is the {otherSide}
              </button>
              {scan.adjusted && (
                <button type="button" onClick={() => onMeasurement(activeSide, scan.autoMeasurement, false)}>
                  Reset lines
                </button>
              )}
            </div>

            <Ladder side={activeSide} score={result.score} />
          </div>
        </div>
      ) : (
        <div className="side-empty">
          <p>No {activeSide} scan for this card yet. PSA holds the two sides to different limits, so the whole-card score needs both.</p>
          <button type="button" className="primary" disabled={Boolean(busy)} onClick={() => otherInput.current?.click()}>
            Add {activeSide} scan
          </button>
        </div>
      )}
      <input
        ref={otherInput}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/tiff,image/bmp,.tif,.tiff"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onAddSide(file, scan ? otherSide : activeSide);
          e.target.value = "";
        }}
      />
    </section>
  );
}
