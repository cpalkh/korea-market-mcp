import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eximCall, eximRaw, flattenRows, num, type EximData, type EximRow } from "../exim";
import { addDays, fmtNum, isWeekend, mapLimit, normalizeDate, nowKstLabel, safe, table, todayKst, UpstreamError, weekdaysBetween } from "../common";

const SOURCE = "출처: 한국수출입은행 현재환율 Open API (영업일 오전 11시경 고시, 주말·공휴일 없음)";
const MAX_HISTORY = 31;

/** Notice on `date`, or the nearest earlier business day (holidays, or before ~11:00 today). */
async function onOrBefore(data: EximData, date: string): Promise<{ date: string; rows: EximRow[] }> {
  let d = date;
  for (let i = 0; i < 10; i++, d = addDays(d, -1)) {
    if (isWeekend(d)) continue;
    const rows = await eximCall(data, d);
    if (rows.length) return { date: d, rows };
  }
  throw new UpstreamError(`${date} 이전 10일 안에 고시된 데이터가 없습니다.`);
}

function matchCur(r: EximRow, wanted: string[]): boolean {
  if (!wanted.length) return true;
  const unit = String(r.cur_unit ?? "").toUpperCase();
  const name = String(r.cur_nm ?? "");
  return wanted.some((w) => unit.startsWith(w.toUpperCase()) || name.includes(w));
}

export function registerEximTools(server: McpServer) {
  server.tool(
    "exim_exchange_rate",
    "수출입은행 고시 환율(매매기준율·전신환 살때/팔때·장부가격). 기말 외화환산 검증 등 특정일 고시환율 확인용. " +
      "해당일이 휴일이거나 오늘 11시 이전이면 직전 고시일 값을 쓰고 그 날짜를 표시한다. 긴 기간 추이는 ecos_get_series 가 효율적이다.",
    {
      date: z.string().optional().describe("기준일 YYYYMMDD (비우면 오늘)"),
      currencies: z.array(z.string()).default([]).describe("통화코드나 통화명 (예: ['USD','EUR','JPY','CNH']). 비우면 전체"),
    },
    safe(async ({ date, currencies }) => {
      const asked = date ? normalizeDate(date) : todayKst();
      const got = await onOrBefore("AP01", asked);
      const rows = got.rows.filter((r) => matchCur(r, currencies));
      if (!rows.length) return `${got.date} 고시에 ${currencies.join(", ")} 통화가 없습니다.`;
      const note = got.date !== asked ? `\n\n※ ${asked}은(는) 고시가 없어 직전 고시일 ${got.date} 값을 표시합니다.` : "";
      return [
        `## 수출입은행 고시환율 — ${got.date}${note}`,
        table(
          ["통화", "통화명", "매매기준율", "전신환 받을때(TTB)", "전신환 보낼때(TTS)", "장부가격", "서울외국환중개 매매기준율"],
          rows.map((r) => [r.cur_unit, r.cur_nm, r.deal_bas_r, r.ttb, r.tts, r.bkpr, r.kftc_deal_bas_r])
        ),
        "JPY(100), IDR(100)은 100단위 기준입니다.",
        `${SOURCE} · 조회시각 ${nowKstLabel()}`,
      ].join("\n\n");
    })
  );

  server.tool(
    "exim_rate_history",
    `한 통화의 수출입은행 매매기준율을 기간으로 조회한다(날짜마다 1회 호출, 최대 ${MAX_HISTORY}개 시점, 일일 한도 1,000회). ` +
      "frequency=monthly 면 월말(휴일이면 직전 고시일) 값만 가져온다 — 월말 환율표에 적합. 수년치 일별은 ECOS를 쓴다.",
    {
      currency: z.string().min(2).describe("통화코드 (예: USD)"),
      from: z.string(),
      to: z.string().optional(),
      frequency: z.enum(["daily", "monthly"]).default("daily"),
    },
    safe(async ({ currency, from, to, frequency }) => {
      const f = normalizeDate(from);
      const t = to ? normalizeDate(to) : todayKst();
      let targets = weekdaysBetween(f, t);
      if (frequency === "monthly") {
        const last = new Map<string, string>();
        for (const d of targets) last.set(d.slice(0, 6), d);
        targets = [...last.values()];
      }
      if (targets.length > MAX_HISTORY) {
        throw new UpstreamError(`요청 시점이 ${targets.length}개로 ${MAX_HISTORY}개를 넘습니다. 기간을 줄이거나 frequency=monthly 를 쓰거나, 긴 일별 시계열은 ECOS(ecos_get_series)를 쓰세요.`);
      }
      const got = await mapLimit(targets, 4, async (d) => {
        if (frequency === "monthly") {
          const snap = await onOrBefore("AP01", d).catch(() => null);
          return snap ? { date: snap.date, row: snap.rows.find((r) => matchCur(r, [currency])) } : null;
        }
        const rows = await eximCall("AP01", d);
        return rows.length ? { date: d, row: rows.find((r) => matchCur(r, [currency])) } : null;
      });
      const pts = got.filter((g): g is { date: string; row: EximRow } => !!g && !!g.row);
      if (!pts.length) return `${f}~${t} 구간에 ${currency} 고시가 없습니다.`;
      const vals = pts.map((p) => num(p.row.deal_bas_r));
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      return [
        `## ${pts[0].row.cur_nm} (${pts[0].row.cur_unit}) 매매기준율 ${frequency} ${f}~${t} — ${pts.length}개 고시일`,
        `요약: 평균 ${fmtNum(Math.round(avg * 100) / 100)} · 최고 ${fmtNum(Math.max(...vals))} · 최저 ${fmtNum(Math.min(...vals))} (단순평균, 고시일 기준)`,
        table(["고시일", "매매기준율", "TTB", "TTS"], pts.map((p) => [p.date, p.row.deal_bas_r, p.row.ttb, p.row.tts])),
        `${SOURCE} · 조회시각 ${nowKstLabel()}`,
      ].join("\n\n");
    })
  );

  server.tool(
    "exim_interest_rates",
    "수출입은행 Open API의 대출금리(AP02: 수은채 유통수익률 등) 또는 국제금리(AP03: SOFR·ESTR·EURIBOR·TONA·TIBOR·SWAP·CIRR 등) 고시값. " +
      "국제금리는 비영업일에 일부 금리만 고시될 수 있다.",
    {
      kind: z.enum(["AP02", "AP03"]).describe("AP02=대출금리, AP03=국제금리"),
      date: z.string().optional(),
      filter: z.string().optional().describe("구분·금리명·통화로 좁히기 (예: 'SOFR', 'USD', 'CIRR')"),
      raw: z.boolean().default(false).describe("true면 수출입은행 원본 응답(JSON 앞부분)을 그대로 보여준다 — 형식 확인용"),
    },
    safe(async ({ kind, date, filter, raw }) => {
      const asked = date ? normalizeDate(date) : todayKst();
      const got = await onOrBefore(kind, asked);
      if (raw) return "```json\n" + (eximRaw(kind, got.date) ?? "(원본 없음 — 캐시된 결과)") + "\n```";
      let flat = flattenRows(got.rows);
      if (filter) flat = flat.filter((r) => Object.values(r).some((v) => v.toUpperCase().includes(filter.toUpperCase())));
      if (!flat.length) return `${got.date} ${kind} 고시에 "${filter}"에 해당하는 금리가 없습니다.`;
      const cols = [...new Set(flat.flatMap((r) => Object.keys(r)))];
      const note = got.date !== asked ? `\n\n※ ${asked}은(는) 고시가 없어 직전 고시일 ${got.date} 값을 표시합니다.` : "";
      return [
        `## 수출입은행 ${kind === "AP02" ? "대출금리" : "국제금리"} — ${got.date} (${flat.length}건)${note}`,
        table(cols, flat.map((r) => cols.map((c) => r[c]))),
        "출처: 한국수출입은행 Open API · 조회시각 " + nowKstLabel(),
      ].join("\n\n");
    })
  );
}
