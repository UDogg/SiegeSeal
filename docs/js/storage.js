// localStorage / sessionStorage that never throws.
// Some browsers (private modes, locked-down school devices, embedded previews)
// block storage or throw on access. Then we fall back to memory: the app
// still works, it just forgets everything when the tab closes.

function make(kind) {
  let real = null;
  try {
    real = globalThis[kind];
    real.setItem("__siegeseal_probe", "1");
    real.removeItem("__siegeseal_probe");
  } catch {
    real = null;
  }
  const mem = new Map();
  return {
    persistent: !!real,
    getItem(k) {
      if (mem.has(k)) return mem.get(k);
      try { return real ? real.getItem(k) : null; } catch { return null; }
    },
    setItem(k, v) {
      try { if (real) { real.setItem(k, String(v)); mem.delete(k); return; } } catch {}
      mem.set(k, String(v));
    },
    removeItem(k) {
      mem.delete(k);
      try { real?.removeItem(k); } catch {}
    },
    keys() {
      const out = new Set(mem.keys());
      try { if (real) for (let i = 0; i < real.length; i++) out.add(real.key(i)); } catch {}
      return [...out];
    },
  };
}

export const LS = make("localStorage");
export const SS = make("sessionStorage");
