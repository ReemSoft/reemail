import type { InlineImageMetadata } from "@/lib/mail-compose-inline-images";

const DB_NAME = "mailmaestro-composer";
const STORE = "inline-images";
const VERSION = 1;

type StoredInlineImage = InlineImageMetadata & { scope: string; blob: Blob };

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE))
        db.createObjectStore(STORE, { keyPath: ["scope", "id"] });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export function inlineImageScope(companyId: string, accountId: string, draftId: string): string {
  return `${companyId}:${accountId}:${draftId}`;
}

export async function persistInlineImage(
  scope: string,
  metadata: InlineImageMetadata,
  blob: Blob,
): Promise<void> {
  await transaction("readwrite", (store) =>
    store.put({ ...metadata, scope, blob } satisfies StoredInlineImage),
  );
}

export async function readInlineImages(scope: string): Promise<StoredInlineImage[]> {
  return transaction("readonly", (store) =>
    store.getAll(IDBKeyRange.bound([scope, ""], [scope, "\uffff"])),
  );
}

export async function deleteInlineImage(scope: string, id: string): Promise<void> {
  await transaction("readwrite", (store) => store.delete([scope, id]));
}

export async function clearInlineImages(scope: string): Promise<void> {
  const rows = await readInlineImages(scope);
  await Promise.all(rows.map((row) => deleteInlineImage(scope, row.id)));
}
