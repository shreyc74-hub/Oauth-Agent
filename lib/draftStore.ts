// Keeps the last generated (unsaved) guide in this browser tab, so a refresh doesn't lose it.
// sessionStorage, not cookies: a guide is 20 to 40 KB and cookies hold about 4 KB. It lasts until
// the tab is closed and never leaves the browser. Every access is guarded: storage can be blocked.
export interface StoredDraft<T> { name: string; website: string; savedAt: number; state: T }

const PREFIX = "oauthr:draft:";
const keyFor = (name: string, website: string) => `${PREFIX}${name.trim().toLowerCase()}|${website.trim().toLowerCase()}`;

function store(): Storage | null {
  try { return typeof window !== "undefined" ? window.sessionStorage : null; } catch { return null; }
}

export function saveDraft<T>(name: string, website: string, state: T): boolean {
  const s = store(); if (!s) return false;
  try { s.setItem(keyFor(name, website), JSON.stringify({ name, website, savedAt: Date.now(), state })); return true; } catch { return false; }
}

export function loadDraft<T>(name: string, website: string): StoredDraft<T> | null {
  const s = store(); if (!s) return null;
  try {
    const raw = s.getItem(keyFor(name, website));
    if (!raw) return null;
    const d = JSON.parse(raw) as StoredDraft<T>;
    return d && d.state ? d : null;
  } catch { return null; }
}

export function clearDraft(name: string, website: string): void {
  const s = store(); if (!s) return;
  try { s.removeItem(keyFor(name, website)); } catch { /* ignore */ }
}

export function listDrafts(): { name: string; website: string; savedAt: number }[] {
  const s = store(); if (!s) return [];
  const out: { name: string; website: string; savedAt: number }[] = [];
  try {
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (!k || !k.startsWith(PREFIX)) continue;
      try { const d = JSON.parse(s.getItem(k) || "null"); if (d?.name) out.push({ name: d.name, website: d.website || "", savedAt: d.savedAt || 0 }); } catch { /* skip */ }
    }
  } catch { return []; }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}
