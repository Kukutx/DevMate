// A copy loaded in developer mode has no store that updates it: after DevMate was updated, the files on disk are newer
// than what the browser runs, and stay so until the extension is loaded again. This does that by itself, so that
// nobody has to open the browser's extension page: once for each change, and only when the files were the same at
// two looks in a row (an update that is still being written is left alone).

export const FILES = Object.freeze(['manifest.json', 'background.js', 'bridge.js', 'capabilities.js', 'debug.js', 'panel.js', 'popup.html', 'popup.js', 'renew.js']);

/**
 * read(name) gives a file of the extension as it is on disk now; storage keeps three marks (loaded: the files the
 * browser runs, seen: a change at its first look, reloadedFor: the change it was last loaded again for); reload
 * loads the extension again. loaded() is called when the browser has just loaded it, look() from time to time.
 */
export function createRenewal({ read, storage, reload, digest = text => crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)) } = {}) {
  async function mark() {
    const parts = await Promise.all(FILES.map(read));
    // A manifest that is half written is no update yet.
    JSON.parse(parts[0]);
    return [...new Uint8Array(await digest(parts.join('\n')))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  async function loaded() {
    const disk = await mark().catch(() => null);
    if (!disk) return;
    // What it was last loaded again for says nothing any more once the browser runs something else.
    const { reloadedFor } = await storage.get(['reloadedFor']);
    await storage.set({ loaded: disk, seen: null, reloadedFor: reloadedFor === disk ? disk : null });
  }
  async function look() {
    const disk = await mark().catch(() => null), marks = await storage.get(['loaded', 'seen', 'reloadedFor']);
    if (!disk) return 'unreadable';
    if (!marks.loaded) { await storage.set({ loaded: disk }); return 'noted'; }
    // Loaded again for this change already, and it is still not what runs: the browser did not take it. Not again.
    if (disk === marks.loaded || disk === marks.reloadedFor) return 'same';
    if (disk !== marks.seen) { await storage.set({ seen: disk }); return 'changed'; }
    await storage.set({ reloadedFor: disk });
    reload();
    return 'reloading';
  }
  return { loaded, look };
}
