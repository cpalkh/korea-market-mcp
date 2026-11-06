// 한국거래소(KRX) Open API client. Key goes in the AUTH_KEY header.
import { fetchWithRetry, requireEnv, UpstreamError } from "./common";

const BASE = () => process.env.KRX_BASE_URL || "https://data-dbg.krx.co.kr/svc/apis";

export type KrxRow = Record<string, string>;

export const KRX_PATHS = {
  stock_daily: { KOSPI: "sto/stk_bydd_trd", KOSDAQ: "sto/ksq_bydd_trd", KONEX: "sto/knx_bydd_trd" },
  stock_info: { KOSPI: "sto/stk_isu_base_info", KOSDAQ: "sto/ksq_isu_base_info", KONEX: "sto/knx_isu_base_info" },
  index_daily: { KRX: "idx/krx_dd_trd", KOSPI: "idx/kospi_dd_trd", KOSDAQ: "idx/kosdaq_dd_trd" },
  etf_daily: "etp/etf_bydd_trd",
} as const;

// Daily snapshots are public and immutable once published: cache on a warm instance.
const cache = new Map<string, { at: number; rows: KrxRow[] }>();
const CACHE_MS = 6 * 3600 * 1000;

export async function krxCall(path: string, basDd: string): Promise<KrxRow[]> {
  const ck = `${path}|${basDd}`;
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows;

  const key = requireEnv("KRX_API_KEY", "openapi.krx.co.kr → API 인증키 신청 + API별 이용신청");
  const url = `${BASE()}/${path.replace(/^\/+/, "")}?basDd=${encodeURIComponent(basDd)}`;
  const res = await fetchWithRetry(url, { headers: { AUTH_KEY: key } }, { label: `KRX ${path}`, timeoutMs: 20000 });
  const text = await res.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text);
  } catch {
    throw new UpstreamError(`KRX ${path}: JSON이 아닌 응답 (HTTP ${res.status}). 경로가 맞는지 확인하세요: ${text.slice(0, 160)}`);
  }
  const code = String(body.respCode ?? (res.ok ? "" : res.status));
  if (code === "401" || res.status === 401) {
    throw new UpstreamError(
      `KRX ${path}: 401 Unauthorized. ① 인증키가 '승인' 상태인지(마이페이지 → API 인증키 발급내역), ② 이 API의 '이용신청'이 승인됐는지(서비스 이용 → 해당 API → API 이용신청), ③ Vercel 환경변수 KRX_API_KEY 값이 맞는지 확인하세요.`
    );
  }
  if (code && code !== "200" && !Array.isArray(body.OutBlock_1)) {
    throw new UpstreamError(`KRX ${path}: [${code}] ${String(body.respMsg ?? "")}`);
  }
  const rows = (body.OutBlock_1 as KrxRow[] | undefined) ?? [];
  if (rows.length) cache.set(ck, { at: Date.now(), rows });
  return rows;
}

/** Match a row by 6-digit code, ISIN, or name substring. */
export function matchIssue(r: KrxRow, q: string): boolean {
  const s = q.trim();
  if (!s) return true;
  if (/^\d{6}$/.test(s)) return r.ISU_SRT_CD === s || r.ISU_CD === s || (r.ISU_CD ?? "").includes(s);
  if (/^KR[0-9A-Z]{10}$/i.test(s)) return (r.ISU_CD ?? "").toUpperCase() === s.toUpperCase();
  return (r.ISU_NM ?? "").includes(s) || (r.ISU_ABBRV ?? "").includes(s) || (r.ISU_ENG_NM ?? "").toLowerCase().includes(s.toLowerCase());
}

export function exactNameFirst(rows: KrxRow[], q: string): KrxRow[] {
  const exact = rows.filter((r) => r.ISU_NM === q || r.ISU_ABBRV === q);
  return exact.length ? exact : rows;
}
