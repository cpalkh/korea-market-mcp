import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { KRX_PATHS, krxCall, matchIssue, exactNameFirst, type KrxRow } from "../krx";
import {
  addDays, fmtNum, isWeekend, mapLimit, normalizeDate, nowKstLabel, safe, table, todayKst, UpstreamError, weekdaysBetween,
} from "../common";

const SOURCE = "출처: 한국거래소(KRX) Open API · 종가는 수정주가가 아님(액면분할·증자 등 자본변동 시 불연속)";
const MAX_POINTS = 60;

type Market = "KOSPI" | "KOSDAQ" | "KONEX";
const marketEnum = z.enum(["KOSPI", "KOSDAQ", "KONEX"]);

/** Latest date on or before `start` that has data for `path` (looks back up to 10 days). */
async function latestWithData(path: string, start: string): Promise<{ date: string; rows: KrxRow[] }> {
  let d = start;
  for (let i = 0; i < 10; i++, d = addDays(d, -1)) {
    if (isWeekend(d)) continue;
    const rows = await krxCall(path, d);
    if (rows.length) return { date: d, rows };
  }
  throw new UpstreamError(`${start} 이전 10일 안에 거래 데이터가 없습니다. (오늘 데이터는 장 마감·집계 후 반영됩니다)`);
}

/** Target dates for a history request at the given frequency. */
function targetDates(from: string, to: string, freq: "daily" | "weekly" | "monthly"): string[] {
  const days = weekdaysBetween(from, to);
  if (freq === "daily") return days;
  const buckets = new Map<string, string>();
  for (const d of days) {
    const dt = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)));
    let key: string;
    if (freq === "monthly") key = d.slice(0, 6);
    else {
      const monday = new Date(dt);
      monday.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
      key = monday.toISOString().slice(0, 10);
    }
    buckets.set(key, d); // keeps the last weekday of each bucket
  }
  return [...buckets.values()];
}

/** For a period-end target, step back to the nearest earlier day with data (holidays). */
async function rowsOnOrBefore(path: string, target: string, floor: string): Promise<{ date: string; rows: KrxRow[] } | null> {
  let d = target;
  for (let i = 0; i < 5 && d >= floor; i++, d = addDays(d, -1)) {
    if (isWeekend(d)) continue;
    const rows = await krxCall(path, d);
    if (rows.length) return { date: d, rows };
  }
  return null;
}

async function resolveMarket(query: string, market: Market | "AUTO"): Promise<{ market: Market; row: KrxRow; date: string }> {
  // KONEX only on explicit request: most keys have no KONEX API subscription.
  const order: Market[] = market === "AUTO" ? ["KOSPI", "KOSDAQ"] : [market];
  const candidates: { market: Market; row: KrxRow }[] = [];
  let date = todayKst();
  let firstErr: unknown = null;
  for (const m of order) {
    let latest: { date: string; rows: KrxRow[] };
    try {
      latest = await latestWithData(KRX_PATHS.stock_daily[m], todayKst());
    } catch (err) {
      if (order.length === 1) throw err;
      firstErr ??= err;
      continue;
    }
    date = latest.date;
    for (const r of exactNameFirst(latest.rows.filter((r) => matchIssue(r, query)), query)) candidates.push({ market: m, row: r });
    if (candidates.length) break;
  }
  if (!candidates.length) {
    if (firstErr) throw firstErr;
    throw new UpstreamError(`"${query}" 종목을 찾지 못했습니다. 종목코드 6자리로 다시 시도하세요. (KONEX 종목이면 market="KONEX")`);
  }
  if (candidates.length > 1) {
    const list = candidates.slice(0, 15).map((c) => `${c.row.ISU_NM}(${c.row.ISU_CD}, ${c.market})`).join(", ");
    throw new UpstreamError(`"${query}"에 여러 종목이 해당합니다: ${list}. 종목코드나 정확한 종목명으로 지정하세요.`);
  }
  return { ...candidates[0], date };
}

function stockDailyRow(r: KrxRow) {
  return [
    r.BAS_DD, r.ISU_NM, r.ISU_CD, fmtNum(r.TDD_CLSPRC), fmtNum(r.CMPPREVDD_PRC), r.FLUC_RT,
    fmtNum(r.TDD_OPNPRC), fmtNum(r.TDD_HGPRC), fmtNum(r.TDD_LWPRC), fmtNum(r.ACC_TRDVOL), fmtNum(r.ACC_TRDVAL),
    fmtNum(r.MKTCAP), fmtNum(r.LIST_SHRS),
  ];
}
const STOCK_HEADERS = ["일자", "종목명", "코드", "종가", "전일대비", "등락률(%)", "시가", "고가", "저가", "거래량", "거래대금(원)", "시가총액(원)", "상장주식수"];

export function registerKrxTools(server: McpServer) {
  server.tool(
    "krx_stock_daily",
    "KRX 주식 일별 시세(종가·등락률·거래량·거래대금·시가총액·상장주식수). 하루치 전 종목에서 query 로 걸러 보여준다. " +
      "date 를 비우면 가장 최근 거래일. 오늘 데이터는 장 마감·집계 후 반영된다.",
    {
      market: z.enum(["KOSPI", "KOSDAQ", "KONEX", "ALL"]).default("ALL"),
      date: z.string().optional().describe("기준일 YYYYMMDD. 휴일이면 직전 거래일로 자동 보정"),
      query: z.string().optional().describe("종목명 일부, 종목코드 6자리 (비우면 시가총액 상위)"),
      limit: z.number().int().min(1).max(200).default(30),
    },
    safe(async ({ market, date, query, limit }) => {
      const start = date ? normalizeDate(date) : todayKst();
      const markets: Market[] = market === "ALL" ? ["KOSPI", "KOSDAQ"] : [market];
      const parts: { m: Market; date: string; rows: KrxRow[] }[] = [];
      const failed: string[] = [];
      for (const m of markets) {
        try {
          const got = await latestWithData(KRX_PATHS.stock_daily[m], start);
          parts.push({ m, date: got.date, rows: got.rows });
        } catch (err) {
          if (markets.length === 1) throw err;
          failed.push(`${m}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (!parts.length) throw new UpstreamError(failed.join("\n"));
      let rows: KrxRow[] = parts.flatMap((p) => p.rows.map((r): KrxRow => ({ ...r, _m: p.m })));
      if (query) rows = exactNameFirst(rows.filter((r) => matchIssue(r, query)), query);
      else rows.sort((a, b) => Number(b.MKTCAP) - Number(a.MKTCAP));
      if (!rows.length) return `"${query}"에 해당하는 종목이 없습니다 (${parts.map((p) => `${p.m} ${p.date}`).join(", ")}).`;
      const shown = rows.slice(0, limit);
      return [
        `## KRX 일별 시세 — ${parts.map((p) => `${p.m} ${p.date}`).join(", ")} (${rows.length}건 중 ${shown.length}건)`,
        table(["시장", ...STOCK_HEADERS], shown.map((r) => [r._m, ...stockDailyRow(r)])),
        ...(failed.length ? [`※ 일부 시장 조회 실패:\n${failed.join("\n")}`] : []),
        `${SOURCE} · 조회시각 ${nowKstLabel()}`,
      ].join("\n\n");
    })
  );

  server.tool(
    "krx_stock_info",
    "KRX 종목 기본정보: 표준코드(ISIN)·단축코드·상장일·액면가·상장주식수·주식종류·소속부.",
    {
      market: marketEnum.default("KOSPI"),
      query: z.string().min(1).describe("종목명 일부 또는 종목코드 6자리"),
      date: z.string().optional().describe("기준일 YYYYMMDD (비우면 최근 거래일)"),
    },
    safe(async ({ market, query, date }) => {
      const got = await latestWithData(KRX_PATHS.stock_info[market], date ? normalizeDate(date) : todayKst());
      const rows = exactNameFirst(got.rows.filter((r) => matchIssue(r, query)), query);
      if (!rows.length) return `${market}에서 "${query}" 종목을 찾지 못했습니다. 시장(KOSPI/KOSDAQ)을 바꿔 보세요.`;
      return [
        `## KRX 종목 기본정보 — ${market} ${got.date} (${rows.length}건)`,
        table(
          ["종목명", "단축코드", "표준코드", "영문명", "상장일", "시장", "소속부", "주식종류", "액면가", "상장주식수"],
          rows.slice(0, 50).map((r) => [
            r.ISU_NM, r.ISU_SRT_CD, r.ISU_CD, r.ISU_ENG_NM, r.LIST_DD, r.MKT_TP_NM, r.SECT_TP_NM,
            r.KIND_STKCERT_TP_NM, fmtNum(r.PARVAL), fmtNum(r.LIST_SHRS),
          ])
        ),
        `${SOURCE}`,
      ].join("\n\n");
    })
  );

  server.tool(
    "krx_price_history",
    `한 종목의 기간별 주가 시계열. KRX API는 하루 단위라 날짜마다 호출하므로 한 번에 최대 ${MAX_POINTS}개 시점까지 가져온다. ` +
      "frequency=weekly/monthly 면 주말·월말(휴일이면 직전 거래일) 종가만 가져와서 2년 주간(약 104개)도 2번 나눠 호출하면 된다. " +
      "베타 산정용이면 krx_index_history 로 같은 기간·주기의 지수를 함께 받는다. 수정주가가 아니므로 자본변동 여부를 DART로 확인한다.",
    {
      query: z.string().min(1).describe("종목명 또는 종목코드 6자리"),
      market: z.enum(["AUTO", "KOSPI", "KOSDAQ", "KONEX"]).default("AUTO"),
      from: z.string().describe("시작일 YYYYMMDD"),
      to: z.string().optional().describe("종료일 YYYYMMDD (비우면 오늘)"),
      frequency: z.enum(["daily", "weekly", "monthly"]).default("daily"),
    },
    safe(async ({ query, market, from, to, frequency }) => {
      const f = normalizeDate(from);
      const t = to ? normalizeDate(to) : todayKst();
      if (f > t) throw new UpstreamError("시작일이 종료일보다 늦습니다.");
      const { market: m, row } = await resolveMarket(query, market);
      const code = row.ISU_CD;
      const targets = targetDates(f, t, frequency);
      if (targets.length > MAX_POINTS) {
        throw new UpstreamError(
          `요청 시점이 ${targets.length}개로 한 번에 가져올 수 있는 ${MAX_POINTS}개를 넘습니다. 기간을 나눠 호출하거나 frequency 를 weekly/monthly 로 바꾸세요. (예: ${f}~${targets[MAX_POINTS - 1]}, 이후 구간 따로)`
        );
      }
      const path = KRX_PATHS.stock_daily[m];
      const got = await mapLimit(targets, 6, async (d) => {
        const snap = frequency === "daily" ? { date: d, rows: await krxCall(path, d) } : await rowsOnOrBefore(path, d, f);
        if (!snap) return null;
        const hit = snap.rows.find((r) => r.ISU_CD === code);
        return hit ? ({ ...hit, BAS_DD: hit.BAS_DD || snap.date } as KrxRow) : null;
      });
      const seen = new Set<string>();
      const series = got.filter((r): r is KrxRow => !!r && !seen.has(r.BAS_DD) && !!seen.add(r.BAS_DD));
      if (!series.length) return `${row.ISU_NM}(${code}) ${f}~${t} 구간에 데이터가 없습니다 (상장 전이거나 거래정지일 수 있음).`;
      const closes = series.map((r) => Number(r.TDD_CLSPRC)).filter(Number.isFinite);
      const avg = closes.reduce((a, b) => a + b, 0) / closes.length;
      return [
        `## ${row.ISU_NM}(${code}, ${m}) ${frequency} 주가 ${f}~${t} — ${series.length}개 시점`,
        `요약: 최고 종가 ${fmtNum(Math.max(...closes))} · 최저 종가 ${fmtNum(Math.min(...closes))} · 평균 종가 ${fmtNum(Math.round(avg * 100) / 100)} · 기간 등락률 ${(((closes[closes.length - 1] / closes[0]) - 1) * 100).toFixed(2)}%`,
        table(STOCK_HEADERS, series.map(stockDailyRow)),
        `${SOURCE} · 휴일은 자동으로 빠집니다 · 조회시각 ${nowKstLabel()}`,
      ].join("\n\n");
    })
  );

  server.tool(
    "krx_index_daily",
    "KRX 지수 일별 시세(KOSPI·KOSDAQ·KRX 시리즈 지수의 종가·등락률·거래대금·시가총액).",
    {
      family: z.enum(["KOSPI", "KOSDAQ", "KRX"]).default("KOSPI").describe("지수 계열"),
      date: z.string().optional().describe("기준일 YYYYMMDD (비우면 최근 거래일)"),
      query: z.string().optional().describe("지수명 일부 (예: '코스피 200', '코스닥 150'). 비우면 전체"),
    },
    safe(async ({ family, date, query }) => {
      const got = await latestWithData(KRX_PATHS.index_daily[family], date ? normalizeDate(date) : todayKst());
      const rows = query ? got.rows.filter((r) => (r.IDX_NM ?? "").includes(query)) : got.rows;
      if (!rows.length) return `${family} 계열에서 "${query}" 지수를 찾지 못했습니다.`;
      return [
        `## ${family} 지수 — ${got.date} (${rows.length}건)`,
        table(
          ["지수명", "종가", "전일대비", "등락률(%)", "시가", "고가", "저가", "거래대금(원)", "시가총액(원)"],
          rows.slice(0, 80).map((r) => [
            r.IDX_NM, fmtNum(r.CLSPRC_IDX), fmtNum(r.CMPPREVDD_IDX), r.FLUC_RT, fmtNum(r.OPNPRC_IDX),
            fmtNum(r.HGPRC_IDX), fmtNum(r.LWPRC_IDX), fmtNum(r.ACC_TRDVAL), fmtNum(r.MKTCAP),
          ])
        ),
        `출처: 한국거래소(KRX) Open API · 조회시각 ${nowKstLabel()}`,
      ].join("\n\n");
    })
  );

  server.tool(
    "krx_index_history",
    `지수의 기간별 시계열(베타 산정 시 시장지수용). 한 번에 최대 ${MAX_POINTS}개 시점. frequency=weekly/monthly 는 주말·월말 종가.`,
    {
      index_name: z.string().min(1).describe("정확한 지수명 (예: '코스피', '코스닥', '코스피 200')"),
      family: z.enum(["KOSPI", "KOSDAQ", "KRX"]).default("KOSPI"),
      from: z.string(),
      to: z.string().optional(),
      frequency: z.enum(["daily", "weekly", "monthly"]).default("daily"),
    },
    safe(async ({ index_name, family, from, to, frequency }) => {
      const f = normalizeDate(from);
      const t = to ? normalizeDate(to) : todayKst();
      const targets = targetDates(f, t, frequency);
      if (targets.length > MAX_POINTS) {
        throw new UpstreamError(`요청 시점이 ${targets.length}개로 ${MAX_POINTS}개를 넘습니다. 기간을 나누거나 frequency 를 weekly/monthly 로 바꾸세요.`);
      }
      const path = KRX_PATHS.index_daily[family];
      const pick = (rows: KrxRow[]) => rows.find((r) => r.IDX_NM === index_name) ?? null;
      const got = await mapLimit(targets, 6, async (d) => {
        const snap = frequency === "daily" ? { date: d, rows: await krxCall(path, d) } : await rowsOnOrBefore(path, d, f);
        if (!snap) return null;
        const hit = pick(snap.rows);
        return hit ? ({ ...hit, BAS_DD: hit.BAS_DD || snap.date } as KrxRow) : null;
      });
      const seen = new Set<string>();
      const series = got.filter((r): r is KrxRow => !!r && !seen.has(r.BAS_DD) && !!seen.add(r.BAS_DD));
      if (!series.length) {
        const sample = (await latestWithData(path, t)).rows.slice(0, 20).map((r) => r.IDX_NM).join(", ");
        return `"${index_name}" 지수를 찾지 못했습니다. ${family} 계열 지수명 예: ${sample}`;
      }
      return [
        `## ${index_name} ${frequency} ${f}~${t} — ${series.length}개 시점`,
        table(["일자", "종가", "전일대비", "등락률(%)"], series.map((r) => [r.BAS_DD, fmtNum(r.CLSPRC_IDX), fmtNum(r.CMPPREVDD_IDX), r.FLUC_RT])),
        `출처: 한국거래소(KRX) Open API · 조회시각 ${nowKstLabel()}`,
      ].join("\n\n");
    })
  );

  server.tool(
    "krx_etf_daily",
    "KRX ETF 일별 시세(종가·NAV·거래대금·순자산총액·기초지수).",
    {
      date: z.string().optional(),
      query: z.string().optional().describe("ETF명 일부 또는 코드 (비우면 순자산 상위)"),
      limit: z.number().int().min(1).max(100).default(30),
    },
    safe(async ({ date, query, limit }) => {
      const got = await latestWithData(KRX_PATHS.etf_daily, date ? normalizeDate(date) : todayKst());
      let rows = query ? got.rows.filter((r) => matchIssue(r, query)) : [...got.rows].sort((a, b) => Number(b.INVSTASST_NETASST_TOTAMT) - Number(a.INVSTASST_NETASST_TOTAMT));
      if (!rows.length) return `"${query}" ETF를 찾지 못했습니다.`;
      rows = rows.slice(0, limit);
      return [
        `## ETF 일별 시세 — ${got.date} (${rows.length}건)`,
        table(
          ["종목명", "코드", "종가", "등락률(%)", "NAV", "거래대금(원)", "순자산총액(원)", "기초지수"],
          rows.map((r) => [r.ISU_NM, r.ISU_CD, fmtNum(r.TDD_CLSPRC), r.FLUC_RT, fmtNum(r.NAV), fmtNum(r.ACC_TRDVAL), fmtNum(r.INVSTASST_NETASST_TOTAMT), r.IDX_IND_NM])
        ),
        `출처: 한국거래소(KRX) Open API · 조회시각 ${nowKstLabel()}`,
      ].join("\n\n");
    })
  );

  server.tool(
    "krx_call",
    "위 도구에 없는 KRX Open API(채권·파생·ESG 등)를 경로로 직접 호출한다. 경로는 KRX 개발명세서의 '/svc/apis/' 뒤 부분 (예: 'bon/kts_bydd_trd'). 그 API도 이용신청이 돼 있어야 한다.",
    {
      path: z.string().min(3).describe("예: 'sto/stk_bydd_trd'"),
      date: z.string().describe("basDd YYYYMMDD"),
      filter: z.string().optional().describe("모든 필드 값에서 이 문자열이 포함된 행만"),
      limit: z.number().int().min(1).max(200).default(50),
    },
    safe(async ({ path, date, filter, limit }) => {
      if (!/^[a-z]+\/[a-z0-9_]+$/i.test(path)) throw new UpstreamError("경로 형식이 올바르지 않습니다. 예: 'sto/stk_bydd_trd'");
      let rows = await krxCall(path, normalizeDate(date));
      if (filter) rows = rows.filter((r) => Object.values(r).some((v) => String(v).includes(filter)));
      if (!rows.length) return "결과가 없습니다 (휴일이거나 필터에 맞는 행 없음).";
      const cols = Object.keys(rows[0]);
      return [`## KRX ${path} ${date} (${rows.length}건 중 ${Math.min(limit, rows.length)}건)`, table(cols, rows.slice(0, limit).map((r) => cols.map((c) => r[c])))].join("\n\n");
    })
  );
}
