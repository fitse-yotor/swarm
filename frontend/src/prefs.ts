// Per-viewer conveniences (theme, sidebar, last case, graph positions). Never required state.
const K = "m2swarm.";

export function load<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(K + key); return v == null ? fallback : (JSON.parse(v) as T); } catch { return fallback; }
}
export function store(key: string, value: unknown) {
  try { localStorage.setItem(K + key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}
