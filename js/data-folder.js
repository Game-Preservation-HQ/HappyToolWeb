// The game Data folder picked with the File System Access API: read it into File objects, and keep its handle in
// IndexedDB so the next visit can offer to reopen it (the browser asks for permission again each visit).

const DB = 'happytool-web';
const STORE = 'handles';

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const d = await db();
  try {
    return await new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    d.close();
  }
}

/** The folder handle saved last time, or null (also null where IndexedDB or handles aren't available). */
export async function loadHandle() {
  try {
    const h = await run('readonly', (s) => s.get('data'));
    return h && typeof h.queryPermission === 'function' ? h : null;
  } catch {
    return null;
  }
}

export async function saveHandle(handle) {
  try {
    await run('readwrite', (s) => s.put(handle, 'data'));
  } catch {
    /* not stored: the folder just won't be offered next time */
  }
}

/** Every file under `handle`, with paths that start with the folder's own name (like webkitRelativePath). */
export async function readDirectory(handle, progress) {
  const out = [];
  let last = 0;
  async function walk(dir, prefix) {
    for await (const [name, h] of dir.entries()) {
      if (h.kind === 'file') {
        out.push({ file: await h.getFile(), path: prefix + name });
        if (progress && out.length - last >= 200) progress((last = out.length));
      } else await walk(h, `${prefix}${name}/`);
    }
  }
  await walk(handle, `${handle.name}/`);
  return out;
}
