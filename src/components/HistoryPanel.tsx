import { useEffect, useState } from "react";
import { combineScores, computeCentering } from "../engine/score";
import type { ScanRecord } from "../store";
import { formatScore } from "./format";

function recordScore(record: ScanRecord): number | undefined {
  const score = (side: "front" | "back") => {
    const s = record.sides[side];
    return s ? computeCentering(s.measurement, side, s.dpi / 25.4).score : undefined;
  };
  return combineScores(score("front"), score("back"));
}

function Thumb({ record }: { record: ScanRecord }) {
  const [url, setUrl] = useState<string>();
  const blob = (record.sides.front ?? record.sides.back)?.thumb;
  useEffect(() => {
    if (!blob) return;
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url ? <img className="thumb" src={url} alt="" /> : <span className="thumb" />;
}

interface Props {
  records: ScanRecord[];
  currentId: string | null;
  onSelect: (record: ScanRecord) => void;
  onDelete: (id: string) => void;
}

export function HistoryPanel({ records, currentId, onSelect, onDelete }: Props) {
  const [confirming, setConfirming] = useState<string | null>(null);

  return (
    <section className="panel history" aria-labelledby="history-title">
      <h2 id="history-title">
        Past scans {records.length > 0 && <span className="count">{records.length}</span>}
      </h2>
      {records.length === 0 ? (
        <p className="hint">Scans you measure stay here, in this browser.</p>
      ) : (
        <ul>
          {records.map((record) => {
            const score = recordScore(record);
            const review = Object.values(record.sides).some((s) => s.needsReview && !s.adjusted);
            const both = record.sides.front && record.sides.back;
            return (
              <li key={record.id} className={record.id === currentId ? "active" : ""}>
                <button type="button" className="history-row" onClick={() => onSelect(record)} aria-current={record.id === currentId}>
                  <Thumb record={record} />
                  <span className="history-text">
                    <span className="history-name">{record.name}</span>
                    <span className="history-meta">
                      {new Date(record.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                      {" · "}
                      {both ? "Front + back" : record.sides.front ? "Front" : "Back"}
                    </span>
                    {review && <span className="history-flag">Check lines</span>}
                  </span>
                  <span className="history-score" aria-label={`Centering score ${formatScore(score)}`}>
                    {formatScore(score)}
                  </span>
                </button>
                {confirming === record.id ? (
                  <span className="delete-confirm">
                    <button
                      type="button"
                      onClick={() => {
                        onDelete(record.id);
                        setConfirming(null);
                      }}
                    >
                      Delete
                    </button>
                    <button type="button" onClick={() => setConfirming(null)}>
                      Keep
                    </button>
                  </span>
                ) : (
                  <button type="button" className="delete" aria-label={`Delete ${record.name}`} onClick={() => setConfirming(record.id)}>
                    ×
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
