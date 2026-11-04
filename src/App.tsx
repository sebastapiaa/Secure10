import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CurrentPanel } from "./components/CurrentPanel";
import { HistoryPanel } from "./components/HistoryPanel";
import { ImportPanel } from "./components/ImportPanel";
import type { CardSide, Measurement } from "./engine/types";
import { deleteScan, loadScans, saveScan, type ScanRecord, type SideScan } from "./store";
import type { WorkerCard, WorkerReply } from "./worker";

function newId(): string {
  return crypto.randomUUID();
}

function cleanName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || "Untitled scan";
}

function toSide(card: WorkerCard, fileName: string): SideScan {
  return {
    crop: card.crop,
    thumb: card.thumb,
    cropWidth: card.cropWidth,
    cropHeight: card.cropHeight,
    measurement: card.measurement,
    autoMeasurement: card.measurement,
    dpi: card.dpi,
    rotation: card.rotation,
    widthMm: card.widthMm,
    heightMm: card.heightMm,
    warnings: card.warnings,
    needsReview: card.needsReview,
    adjusted: false,
    fileName,
  };
}

function majoritySide(cards: { side: CardSide }[]): CardSide {
  const fronts = cards.filter((c) => c.side === "front").length;
  return fronts * 2 >= cards.length ? "front" : "back";
}

/**
 * Finds an earlier multi-card scan that this one is the other side of: same number of cards, the opposite
 * side, and none of them matched yet. Returns its records in slot order, which lines up with `cards`
 * because both scans number their cards top to bottom, left to right.
 */
function findOtherSideScan(records: ScanRecord[], cards: WorkerCard[], fileName: string): ScanRecord[] | null {
  if (cards.length < 2) return null;
  const side = majoritySide(cards);
  const seen = new Set<string>();
  for (const record of records) {
    const source = record.layout?.fileName;
    if (!source || source === fileName || seen.has(source)) continue;
    seen.add(source);
    const group = records.filter((r) => r.layout?.fileName === source);
    if (group.length !== cards.length || group[0].layout!.total !== cards.length) continue;
    if (group.some((r) => r.sides.front && r.sides.back)) continue;
    const groupSide = majoritySide(group.map((r) => ({ side: r.sides.front ? ("front" as const) : ("back" as const) })));
    if (groupSide === side) continue;
    return group.sort((a, b) => a.layout!.slot - b.layout!.slot);
  }
  return null;
}

function useMeasureWorker() {
  const workerRef = useRef<Worker | null>(null);
  const pending = useRef(new Map<number, (reply: WorkerReply) => void>());
  const nextId = useRef(1);

  useEffect(() => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      pending.current.get(event.data.id)?.(event.data);
      pending.current.delete(event.data.id);
    };
    workerRef.current = worker;
    return () => worker.terminate();
  }, []);

  return useCallback((file: File) => {
    return new Promise<WorkerReply>((resolve) => {
      const id = nextId.current++;
      pending.current.set(id, resolve);
      workerRef.current!.postMessage({ id, file });
    });
  }, []);
}

export default function App() {
  const [records, setRecords] = useState<ScanRecord[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [activeSide, setActiveSide] = useState<CardSide>("front");
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [storageFailed, setStorageFailed] = useState(false);
  const measure = useMeasureWorker();

  useEffect(() => {
    loadScans()
      .then((rows) => {
        setRecords(rows);
        if (rows[0]) {
          setCurrentId(rows[0].id);
          setActiveSide(rows[0].sides.front ? "front" : "back");
        }
      })
      .catch(() => setStorageFailed(true));
  }, []);

  const current = useMemo(() => records.find((r) => r.id === currentId) ?? null, [records, currentId]);

  // Importing awaits between files, so matching has to see records saved earlier in the same loop.
  const latest = useRef<ScanRecord[]>([]);
  latest.current = records;

  const persist = useCallback((record: ScanRecord) => {
    latest.current = [record, ...latest.current.filter((r) => r.id !== record.id)];
    setRecords((rows) => {
      const others = rows.filter((r) => r.id !== record.id);
      return [record, ...others].sort((a, b) => b.createdAt - a.createdAt);
    });
    saveScan(record).catch(() => setStorageFailed(true));
  }, []);

  const importFiles = useCallback(
    async (files: File[]) => {
      setErrors([]);
      setNotice(null);
      let last: ScanRecord | null = null;
      let lastSide: CardSide = "front";
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setBusy(files.length > 1 ? `Measuring ${i + 1} of ${files.length}: ${file.name}` : `Measuring ${file.name}`);
        const reply = await measure(file);
        if (reply.error !== undefined) {
          setErrors((e) => [...e, reply.error]);
          continue;
        }
        const cards = reply.cards;
        const matches = findOtherSideScan(latest.current, cards, file.name);
        if (matches) {
          matches.forEach((record, slot) => {
            const existing: CardSide = record.sides.front ? "front" : "back";
            const side: CardSide = existing === "front" ? "back" : "front";
            const merged: ScanRecord = { ...record, layout: undefined, sides: { ...record.sides, [side]: toSide(cards[slot], file.name) } };
            persist(merged);
            last = merged;
            lastSide = "front";
          });
          setNotice(`Matched ${cards.length} cards with ${matches[0].layout!.fileName} by their position on the scan. Check each pair looks right.`);
          continue;
        }
        // A front and a back on one bed are almost certainly the same card.
        const isPair = cards.length === 2 && cards[0].side !== cards[1].side;
        const groups = isPair ? [cards] : cards.map((c) => [c]);
        groups.forEach((group, g) => {
          const sides: ScanRecord["sides"] = {};
          for (const card of group) sides[card.side] = toSide(card, file.name);
          const suffix = groups.length > 1 ? ` (${g + 1})` : "";
          const record: ScanRecord = {
            id: newId(),
            name: cleanName(file.name) + suffix,
            createdAt: Date.now() + g,
            sides,
            layout: groups.length > 1 ? { fileName: file.name, slot: g, total: groups.length } : undefined,
          };
          persist(record);
          last = record;
          lastSide = group[0].side;
        });
      }
      setBusy(null);
      if (last) {
        setCurrentId((last as ScanRecord).id);
        setActiveSide(lastSide);
      }
    },
    [measure, persist],
  );

  const addOtherSide = useCallback(
    async (file: File, side: CardSide) => {
      if (!current) return;
      setErrors([]);
      setBusy(`Measuring ${file.name}`);
      const reply = await measure(file);
      setBusy(null);
      if (reply.error !== undefined) {
        setErrors([reply.error]);
        return;
      }
      // The person chose which side this is, which outranks the colour guess.
      persist({ ...current, sides: { ...current.sides, [side]: toSide(reply.cards[0], file.name) } });
      setActiveSide(side);
    },
    [current, measure, persist],
  );

  const updateMeasurement = useCallback(
    (side: CardSide, measurement: Measurement, adjusted: boolean) => {
      if (!current) return;
      const scan = current.sides[side];
      if (!scan) return;
      persist({ ...current, sides: { ...current.sides, [side]: { ...scan, measurement, adjusted } } });
    },
    [current, persist],
  );

  const swapSide = useCallback(
    (from: CardSide) => {
      if (!current) return;
      const to: CardSide = from === "front" ? "back" : "front";
      const sides: ScanRecord["sides"] = {};
      if (current.sides[from]) sides[to] = current.sides[from];
      if (current.sides[to]) sides[from] = current.sides[to];
      persist({ ...current, sides });
      setActiveSide(to);
    },
    [current, persist],
  );

  const separate = useCallback(() => {
    if (!current?.sides.front || !current.sides.back) return;
    const back: ScanRecord = { id: newId(), name: `${current.name} back`, createdAt: current.createdAt - 1, sides: { back: current.sides.back } };
    persist({ ...current, sides: { front: current.sides.front } });
    persist(back);
    setActiveSide("front");
  }, [current, persist]);

  const rename = useCallback(
    (name: string) => {
      if (current) persist({ ...current, name });
    },
    [current, persist],
  );

  const select = useCallback((record: ScanRecord) => {
    setCurrentId(record.id);
    setActiveSide(record.sides.front ? "front" : "back");
  }, []);

  const remove = useCallback(
    (id: string) => {
      setRecords((rows) => {
        const rest = rows.filter((r) => r.id !== id);
        if (id === currentId) {
          setCurrentId(rest[0]?.id ?? null);
          if (rest[0]) setActiveSide(rest[0].sides.front ? "front" : "back");
        }
        return rest;
      });
      deleteScan(id).catch(() => setStorageFailed(true));
    },
    [currentId],
  );

  return (
    <div className="app">
      <header className="masthead">
        <div className="wordmark">
          Secure<span>10</span>
        </div>
        <p className="masthead-note">Centering only, measured against PSA's published tolerances</p>
      </header>
      <aside className="rail">
        <ImportPanel busy={busy} errors={errors} notice={notice} onFiles={importFiles} />
        <HistoryPanel records={records} currentId={currentId} onSelect={select} onDelete={remove} />
      </aside>
      <main className="stage">
        <CurrentPanel
          record={current}
          activeSide={activeSide}
          onActiveSide={setActiveSide}
          onMeasurement={updateMeasurement}
          onSwapSide={swapSide}
          onSeparate={separate}
          onAddSide={addOtherSide}
          onRename={rename}
          busy={busy}
        />
        {storageFailed && (
          <p className="storage-warning" role="alert">
            This browser blocked local storage, so scans won't be here after you close the tab.
          </p>
        )}
      </main>
    </div>
  );
}
