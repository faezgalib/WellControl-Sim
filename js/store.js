// Practice history in IndexedDB (local to this device).
const DB = 'wcsim';
const STORE = 'sessions';
let dbp = null;

function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) {
        const s = d.createObjectStore(STORE, { keyPath: 'id' });
        s.createIndex('date', 'date');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
function tx(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    const r = fn(s);
    t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
    t.onerror = () => reject(t.error);
  }));
}
export const saveSession = (s) => tx('readwrite', (st) => st.put(s));
export const getSession = (id) => tx('readonly', (st) => st.get(id));
export const deleteSession = (id) => tx('readwrite', (st) => st.delete(id));
export async function listSessions() {
  const all = await tx('readonly', (st) => st.getAll());
  return (all || []).map(({ samples, events, ...rest }) => rest).sort((a, b) => b.date - a.date);
}
export async function requestPersist() {
  try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch { /* ignore */ }
}

// ---- backup ----
export const getAllSessions = () => tx('readonly', (st) => st.getAll()).then((x) => x || []);
export const clearSessions = () => tx('readwrite', (st) => st.clear());
export async function importSessions(list) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, 'readwrite');
    const s = t.objectStore(STORE);
    for (const r of list) s.put(r);
    t.oncomplete = () => resolve(list.length);
    t.onerror = () => reject(t.error);
  });
}
export async function storageEstimate() {
  try { return await navigator.storage?.estimate?.(); } catch { return null; }
}
