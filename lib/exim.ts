// 한국수출입은행 현재환율 Open API client.
// The server answers with cookie-setting redirects, so redirects are followed by hand with a cookie jar.
import { fetchWithRetry, requireEnv, UpstreamError } from "./common";

const BASE = () => process.env.EXIM_BASE_URL || "https://oapi.koreaexim.go.kr/site/program/financial";
// Each data code has its own endpoint.
const ENDPOINT = { AP01: "exchangeJSON", AP02: "interestJSON", AP03: "internationalJSON" } as const;

export type EximRow = Record<string, string | number>;
export type EximData = "AP01" | "AP02" | "AP03";

const cache = new Map<string, { at: number; rows: EximRow[] }>();
const rawCache = new Map<string, string>();

/** Raw response text of the last call for (data, date), for diagnosing format changes. */
export function eximRaw(data: EximData, searchdate: string): string | undefined {
  return rawCache.get(`${data}|${searchdate}`);
}

/**
 * Flatten rows whose fields hold nested lists (국제금리: sofr_list, euribor_list, ...)
 * into one row per list item, labelled with the list name.
 */
export function flattenRows(rows: EximRow[]): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const r of rows) {
    const scalars: Record<string, string> = {};
    const nested: [string, unknown[]][] = [];
    for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
      if (k === "result") continue;
      if (Array.isArray(v)) nested.push([k, v]);
      else if (v !== null && v !== undefined && typeof v !== "object") scalars[k] = String(v);
    }
    const group = scalars._group ? scalars._group.replace(/_list$/, "").toUpperCase() : "";
    delete scalars._group;
    if (Object.keys(scalars).length) out.push({ 구분: group, ...scalars });
    for (const [k, arr] of nested) {
      const label = k.replace(/_list$/, "").toUpperCase();
      for (const item of arr) {
        if (item && typeof item === "object") {
          const flat: Record<string, string> = { 구분: label };
          for (const [ik, iv] of Object.entries(item as Record<string, unknown>)) {
            if (iv !== null && iv !== undefined && typeof iv !== "object") flat[ik] = String(iv);
          }
          out.push(flat);
        } else out.push({ 구분: label, value: String(item) });
      }
    }
  }
  return out;
}

export async function eximCall(data: EximData, searchdate: string): Promise<EximRow[]> {
  const ck = `${data}|${searchdate}`;
  const hit = cache.get(ck);
  // A past date's notice never changes; today's may still be empty before ~11:00, so cache briefly.
  if (hit && Date.now() - hit.at < (hit.rows.length ? 6 * 3600 * 1000 : 10 * 60 * 1000)) return hit.rows;

  // The bank issues a separate key per service; fall back to the exchange-rate key.
  const envName = { AP01: "KOREAEXIM_API_KEY", AP02: "KOREAEXIM_LOAN_KEY", AP03: "KOREAEXIM_INTL_KEY" }[data];
  const key = process.env[envName]?.trim()
    ? requireEnv(envName, "")
    : requireEnv("KOREAEXIM_API_KEY", `koreaexim.go.kr 오픈API 인증키. ${data === "AP01" ? "현재환율 API" : data === "AP02" ? "대출금리 API (KOREAEXIM_LOAN_KEY)" : "국제금리 API (KOREAEXIM_INTL_KEY)"} 키`);
  let url = `${BASE()}/${ENDPOINT[data]}?authkey=${encodeURIComponent(key)}&searchdate=${searchdate}&data=${data}`;
  const cookies = new Map<string, string>();
  let res: Response | null = null;
  for (let hop = 0; hop < 6; hop++) {
    const headers: Record<string, string> = { "User-Agent": "Mozilla/5.0 (korea-market-mcp)", Accept: "application/json" };
    if (cookies.size) headers.Cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    res = await fetchWithRetry(url, { headers, redirect: "manual" }, { label: "수출입은행 환율", timeoutMs: 15000 });
    const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const c of setCookies) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      if (i > 0) cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location")!, url).toString();
      continue;
    }
    break;
  }
  if (!res) throw new UpstreamError("수출입은행 환율: 응답이 없습니다.");
  const text = (await res.text()).trim();
  let rows: EximRow[];
  try {
    rows = text ? JSON.parse(text) : [];
  } catch {
    throw new UpstreamError(`수출입은행 환율: JSON이 아닌 응답 (HTTP ${res.status}): ${text.slice(0, 160)}`);
  }
  if (!Array.isArray(rows)) {
    // Some endpoints wrap the list in an object, or answer a single status object.
    const obj = rows as unknown as Record<string, unknown>;
    if (!obj || typeof obj !== "object") {
      throw new UpstreamError(`수출입은행 ${data}: 예상하지 못한 응답 형식 (HTTP ${res.status}): ${text.slice(0, 300)}`);
    }
    // Keep every top-level list (e.g. one per rate family), tagging rows with the list name.
    const lists = Object.entries(obj).filter(([, v]) => Array.isArray(v)) as [string, unknown[]][];
    if (lists.length) {
      rows = lists.flatMap(([k, arr]) =>
        arr.map((item): EximRow => (item && typeof item === "object" ? { _group: k, ...(item as EximRow) } : { _group: k, value: String(item) }))
      );
    } else if ("result" in obj) rows = [obj as EximRow];
    else throw new UpstreamError(`수출입은행 ${data}: 예상하지 못한 응답 형식 (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  rawCache.set(ck, text.slice(0, 6000));
  const bad = rows.find((r) => r.result !== undefined && String(r.result) !== "1");
  if (bad) {
    const why: Record<string, string> = {
      "2": "DATA 코드 오류",
      "3": "인증키 오류 — 수출입은행은 서비스별로 키가 다릅니다. 현재환율=KOREAEXIM_API_KEY, 대출금리=KOREAEXIM_LOAN_KEY, 국제금리=KOREAEXIM_INTL_KEY 를 확인하세요",
      "4": "일일 호출 한도(1,000회) 초과 — 내일 다시 시도하세요",
    };
    throw new UpstreamError(`수출입은행 ${data}: result=${bad.result} ${why[String(bad.result)] ?? ""}`);
  }
  cache.set(ck, { at: Date.now(), rows });
  return rows;
}

export function num(v: string | number | undefined): number {
  return Number(String(v ?? "").replace(/,/g, ""));
}
