import type { MelodyNote } from './melody.ts';

/**
 * 旋律提取结果的本地持久缓存。
 *
 * 键 = 文件内容 SHA-256 + 模型/缓存版本；值 = basic-pitch 原始音符（尚未做 onset 精修）。
 * 命中后由调用方用当前分析的 onset 重新精修，所以缓存不依赖拍点/分析参数。
 *
 * 缓存是纯加速项：IndexedDB/配额/crypto 任一不可用都返回 null/false，调用方走正常提取。
 */

const DB_NAME = 'music-ball-melody';
const DB_VERSION = 1;
const STORE = 'notes';
const MAX_ENTRIES = 50;
const MAX_BYTES = 30 * 1024 * 1024;

/** 缓存结构或模型变化时递增，旧键自然失效。 */
export const CACHE_VERSION = 1;
/** 模型版本 + outputToNotesPoly 参数；任一项变化都应让旧音符失效。 */
export const MODEL_VERSION = 'basic-pitch-1.0.1:poly-0.25-0.25-5';

interface CacheEntry {
  key: string;
  createdAt: number;
  lastUsed: number;
  size: number;
  notes: MelodyNote[];
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      console.warn('[melody-cache] indexedDB.open failed', err);
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      console.warn('[melody-cache] open error', req.error);
      resolve(null);
    };
    req.onblocked = () => resolve(null);
  });
}

function getDb(): Promise<IDBDatabase | null> {
  if (!dbPromise) dbPromise = openDb();
  return dbPromise;
}

function request<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let req: IDBRequest;
    try {
      req = fn(db.transaction(STORE, mode).objectStore(STORE));
    } catch (err) {
      reject(err);
      return;
    }
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

function isValidNotes(notes: unknown): notes is MelodyNote[] {
  if (!Array.isArray(notes) || notes.length === 0) return false;
  for (const n of notes as MelodyNote[]) {
    if (!n || typeof n !== 'object') return false;
    if (
      !Number.isFinite(n.start) ||
      !Number.isFinite(n.end) ||
      !Number.isFinite(n.midi) ||
      !Number.isFinite(n.amplitude) ||
      n.end < n.start
    ) {
      return false;
    }
  }
  return true;
}

function estimateSize(notes: MelodyNote[]): number {
  try {
    return JSON.stringify(notes).length;
  } catch {
    return notes.length * 64;
  }
}

/** 纯函数：按 lastUsed 从旧到新选出要淘汰的键，直到条目数/字节数回到上限内。 */
export function selectEvictions(
  entries: Array<{ key: string; lastUsed: number; size: number }>,
  maxEntries = MAX_ENTRIES,
  maxBytes = MAX_BYTES,
): string[] {
  const all = entries.slice().sort((a, b) => a.lastUsed - b.lastUsed);
  let count = all.length;
  let bytes = all.reduce((sum, e) => sum + (e.size || 0), 0);
  const out: string[] = [];
  for (const e of all) {
    if (count <= maxEntries && bytes <= maxBytes) break;
    out.push(e.key);
    count--;
    bytes -= e.size || 0;
  }
  return out;
}

async function evict(db: IDBDatabase): Promise<void> {
  try {
    const all = await request<CacheEntry[]>(db, 'readonly', (s) => s.getAll());
    const keys = selectEvictions(all);
    for (const key of keys) {
      try {
        await request(db, 'readwrite', (s) => s.delete(key));
      } catch {
        break;
      }
    }
  } catch (err) {
    console.warn('[melody-cache] evict failed', err);
  }
}

/** 文件内容 SHA-256；无 crypto.subtle（非安全上下文）时返回 null。 */
export async function hashFile(file: File): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  try {
    const buf = await file.arrayBuffer();
    const digest = await subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch (err) {
    console.warn('[melody-cache] hash failed', err);
    return null;
  }
}

export function cacheKey(contentHash: string): string {
  return `${contentHash}:${MODEL_VERSION}:${CACHE_VERSION}`;
}

export async function getCachedNotes(key: string): Promise<MelodyNote[] | null> {
  const db = await getDb();
  if (!db) return null;
  try {
    const entry = await request<CacheEntry | undefined>(db, 'readonly', (s) => s.get(key));
    if (!entry || !isValidNotes(entry.notes)) {
      if (entry) await deleteCachedNotes(key);
      return null;
    }
    const now = Date.now();
    try {
      await request(db, 'readwrite', (s) => s.put({ ...entry, lastUsed: now }));
    } catch {
      // touch 失败不影响命中
    }
    return entry.notes;
  } catch (err) {
    console.warn('[melody-cache] read failed', err);
    return null;
  }
}

export async function putCachedNotes(key: string, notes: MelodyNote[]): Promise<boolean> {
  if (!isValidNotes(notes)) return false;
  const db = await getDb();
  if (!db) return false;
  const now = Date.now();
  const entry: CacheEntry = {
    key,
    createdAt: now,
    lastUsed: now,
    size: estimateSize(notes),
    notes,
  };
  try {
    await request(db, 'readwrite', (s) => s.put(entry));
    await evict(db);
    return true;
  } catch (err) {
    console.warn('[melody-cache] write failed', err);
    return false;
  }
}

export async function deleteCachedNotes(key: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await request(db, 'readwrite', (s) => s.delete(key));
  } catch (err) {
    console.warn('[melody-cache] delete failed', err);
  }
}

export async function clearMelodyCache(): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  try {
    await request(db, 'readwrite', (s) => s.clear());
    return true;
  } catch (err) {
    console.warn('[melody-cache] clear failed', err);
    return false;
  }
}

export interface CacheStats {
  count: number;
  bytes: number;
}

export async function getCacheStats(): Promise<CacheStats> {
  const db = await getDb();
  if (!db) return { count: 0, bytes: 0 };
  try {
    const all = await request<CacheEntry[]>(db, 'readonly', (s) => s.getAll());
    return {
      count: all.length,
      bytes: all.reduce((sum, e) => sum + (e.size || 0), 0),
    };
  } catch {
    return { count: 0, bytes: 0 };
  }
}
