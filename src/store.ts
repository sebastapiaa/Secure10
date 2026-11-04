import type { CardSide, Measurement } from "./engine/types";

export interface SideScan {
  crop: Blob;
  thumb: Blob;
  cropWidth: number;
  cropHeight: number;
  measurement: Measurement;
  /** The engine's own reading, kept so hand edits can be undone. */
  autoMeasurement: Measurement;
  dpi: number;
  rotation: number;
  widthMm: number;
  heightMm: number;
  warnings: string[];
  needsReview: boolean;
  adjusted: boolean;
  fileName: string;
}

export interface ScanRecord {
  id: string;
  name: string;
  createdAt: number;
  sides: Partial<Record<CardSide, SideScan>>;
  /** Where this card sat on a multi-card scan, used to match it with the scan of the other side. */
  layout?: { fileName: string; slot: number; total: number };
}

const DB_NAME = "secure10";
const STORE = "scans";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run<T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = body(tx.objectStore(STORE));
        tx.oncomplete = () => {
          db.close();
          resolve(req.result);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error);
        };
      }),
  );
}

export function loadScans(): Promise<ScanRecord[]> {
  return run<ScanRecord[]>("readonly", (s) => s.getAll()).then((rows) => rows.sort((a, b) => b.createdAt - a.createdAt));
}

export function saveScan(record: ScanRecord): Promise<IDBValidKey> {
  return run("readwrite", (s) => s.put(record));
}

export function deleteScan(id: string): Promise<undefined> {
  return run("readwrite", (s) => s.delete(id));
}
