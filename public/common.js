export async function api(path, options = {}) {
  const r = await fetch(path, options);
  let data = null;
  try { data = await r.json(); } catch (_) {}
  if (!r.ok) throw new Error(data?.error || data?.detail || `${r.status} ${r.statusText}`);
  return data;
}

export function wsUrl(path) {
  const u = new URL(path, location.href);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.href;
}

export function esc(s='') {
  return String(s).replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));
}

export function fmtAge(ts) {
  if (!ts) return 'unknown';
  const s = Math.max(0, Math.floor((Date.now()-ts)/1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}
