// ── Remembered tool settings ──────────────────────────────────────────────────
// Each tool keeps its last choices in localStorage, read through
// useSyncExternalStore so the server renders the defaults, the first client
// paint agrees, and the saved values arrive without a state update inside an
// effect. One store per tool; the key is the tool's own.

import { useSyncExternalStore } from "react";

export function settingsStore<T extends object>(key: string, defaults: T) {
  let current: T | null = null;
  const listeners = new Set<() => void>();

  const read = (): T => {
    if (current) return current;
    try {
      const raw = localStorage.getItem(key);
      current = raw ? { ...defaults, ...(JSON.parse(raw) as Partial<T>) } : defaults;
    } catch {
      current = defaults;
    }
    return current;
  };
  const write = (next: T) => {
    current = next;
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* private mode */ }
    listeners.forEach((fn) => fn());
  };
  const subscribe = (fn: () => void) => {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  };
  const use = () => useSyncExternalStore(subscribe, read, () => defaults);
  const patch = (p: Partial<T>) => write({ ...read(), ...p });

  return { read, write, patch, use };
}
