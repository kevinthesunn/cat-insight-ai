// Offline queue (§3 crew flow: offline: queue locally, sync later).
// IndexedDB store of pending submissions; each carries a client-generated
// idempotency key so syncs are exactly-once server-side (§8).

const DB_NAME = "sitememory-queue";
const STORE = "pending";

export type QueuedSubmission = {
  idempotencyKey: string;
  machineId: string;
  kind: "voice_note" | "repair" | "inspection" | "sensor_alarm";
  audioBase64?: string;
  mimeType?: string;
  rawText?: string;
  createdAt: number;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "idempotencyKey" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode: IDBTransactionMode) {
  const db = await openDb();
  return db.transaction(STORE, mode).objectStore(STORE);
}

export async function enqueue(item: QueuedSubmission): Promise<void> {
  const store = await tx("readwrite");
  return new Promise((resolve, reject) => {
    const req = store.put(item);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function listQueued(): Promise<QueuedSubmission[]> {
  const store = await tx("readonly");
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result as QueuedSubmission[]);
    req.onerror = () => reject(req.error);
  });
}

export async function dequeue(idempotencyKey: string): Promise<void> {
  const store = await tx("readwrite");
  return new Promise((resolve, reject) => {
    const req = store.delete(idempotencyKey);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** Push all queued items; server-side idempotency makes retries safe. */
export async function syncQueue(
  send: (item: QueuedSubmission) => Promise<void>,
): Promise<number> {
  const items = await listQueued();
  let synced = 0;
  for (const item of items) {
    try {
      await send(item);
      await dequeue(item.idempotencyKey);
      synced++;
    } catch {
      break; // still offline / failing — keep the rest queued
    }
  }
  return synced;
}
