// Shared helpers: HTTP with timeout/retry, markdown tables, dates, tool results.

export class UpstreamError extends Error {}

const RETRY_DELAYS = [800, 1600];

export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  opts: { timeoutMs?: number; retries?: number; label: string }
): Promise<Response> {
  const { timeoutMs = 20000, retries = 2, label } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        lastErr = new UpstreamError(`${label}: HTTP ${res.status}`);
        await sleep(RETRY_DELAYS[attempt] ?? 2000);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(RETRY_DELAYS[attempt] ?? 2000);
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new UpstreamError(`${label}: 서버에 연결하지 못했습니다 (${msg}). 잠시 후 다시 시도하세요.`);
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function requireEnv(name: string, howTo: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new UpstreamError(
      `${name} 가 설정되지 않았습니다. Vercel 프로젝트 → Settings → Environment Variables 에 ${name} 를 추가하고 Redeploy 하세요. (${howTo})`
    );
  }
  return v;
}

/** Render rows as a markdown table. Missing cells become empty. */
export function table(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined) =>
    v === null || v === undefined ? "" : String(v).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const head = `| ${headers.join(" | ")} |`;
  const sep = `|${headers.map(() => "---").join("|")}|`;
  const body = rows.map((r) => `| ${r.map(esc).join(" | ")} |`);
  return [head, sep, ...body].join("\n");
}

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function fail(err: unknown): ToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `오류: ${msg}` }], isError: true };
}

/** Wrap a tool handler so thrown errors come back as readable tool errors. */
export function safe<A>(fn: (args: A) => Promise<string>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return ok(await fn(args));
    } catch (err) {
      return fail(err);
    }
  };
}

/** Today's date in Korea as YYYYMMDD. */
export function todayKst(): string {
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  return now.toISOString().slice(0, 10).replace(/-/g, "");
}

export function nowKstLabel(): string {
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  return now.toISOString().slice(0, 16).replace("T", " ") + " KST";
}

export function normalizeDate(d: string): string {
  const s = d.replace(/[^0-9]/g, "");
  if (!/^\d{8}$/.test(s)) throw new UpstreamError(`날짜 형식이 올바르지 않습니다: "${d}" (YYYYMMDD 또는 YYYY-MM-DD)`);
  return s;
}

function toDate(yyyymmdd: string): Date {
  return new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8)));
}

function fromDate(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

export function addDays(yyyymmdd: string, n: number): string {
  const d = toDate(yyyymmdd);
  d.setUTCDate(d.getUTCDate() + n);
  return fromDate(d);
}

export function isWeekend(yyyymmdd: string): boolean {
  const day = toDate(yyyymmdd).getUTCDay();
  return day === 0 || day === 6;
}

/** Weekdays between from and to inclusive, ascending. Holidays are not known here. */
export function weekdaysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (!isWeekend(d)) out.push(d);
  }
  return out;
}

/** Run async tasks with a concurrency cap, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

export function fmtNum(v: string | number | undefined | null): string {
  if (v === undefined || v === null || v === "" || v === "-") return v === "-" ? "-" : "";
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  if (!Number.isFinite(n)) return String(v);
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}
