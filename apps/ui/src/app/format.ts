/** Small display formatters shared across the shell and canvas. */

export function formatElapsed(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const total = Math.floor(safe / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 812 → "812", 41,300 → "41k", 1,240,000 → "1.2M". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${trim1(n / 1_000_000)}M`;
  if (n >= 1000) return `${trim1(n / 1000)}k`;
  return String(Math.round(n));
}

function trim1(x: number): string {
  const r = Math.round(x * 10) / 10;
  return r >= 10 || Number.isInteger(r) ? String(Math.round(r)) : r.toFixed(1);
}

export function shortenPath(p: string, keep = 2): string {
  const parts = p.split('/').filter(Boolean);
  return parts.length <= keep ? p : `…/${parts.slice(-keep).join('/')}`;
}

export function shortId(id: string, n = 8): string {
  return id.length <= n ? id : id.slice(0, n);
}

export function formatClock(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour12: false });
}
