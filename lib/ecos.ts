// 한국은행 ECOS Open API client.
// URL form: {base}/{Service}/{key}/json/kr/{start}/{end}/{params...}
import { fetchWithRetry, requireEnv, UpstreamError } from "./common";

const BASE = () => process.env.ECOS_BASE_URL || "https://ecos.bok.or.kr/api";

type Row = Record<string, string>;

export async function ecosCall(service: string, start: number, end: number, params: string[] = []): Promise<Row[]> {
  const key = requireEnv("ECOS_API_KEY", "ecos.bok.or.kr → Open API → 인증키 신청");
  const path = [service, encodeURIComponent(key), "json", "kr", String(start), String(end), ...params.map((p) => encodeURIComponent(p))].join("/");
  const res = await fetchWithRetry(`${BASE()}/${path}`, {}, { label: `ECOS ${service}`, timeoutMs: 25000 });
  const text = await res.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text);
  } catch {
    throw new UpstreamError(`ECOS ${service}: JSON이 아닌 응답 (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  const result = body.RESULT as { CODE?: string; MESSAGE?: string } | undefined;
  if (result?.CODE) {
    if (result.CODE === "INFO-200") return []; // 데이터 없음
    const hint =
      result.CODE === "INFO-100"
        ? " → 인증키가 유효하지 않습니다. 가입 직후라면 다음 날 다시 시도하거나, Vercel 환경변수 ECOS_API_KEY 값을 확인하세요."
        : "";
    throw new UpstreamError(`ECOS ${service} [${result.CODE}] ${result.MESSAGE ?? ""}${hint}`);
  }
  const block = body[service] as { row?: Row[] } | undefined;
  return block?.row ?? [];
}

// Table list is public and the same for everyone: keep it on a warm instance.
let tableCache: { at: number; rows: Row[] } | null = null;

export async function ecosTableList(): Promise<Row[]> {
  if (tableCache && Date.now() - tableCache.at < 12 * 3600 * 1000) return tableCache.rows;
  const rows = await ecosCall("StatisticTableList", 1, 10000);
  tableCache = { at: Date.now(), rows };
  return rows;
}
