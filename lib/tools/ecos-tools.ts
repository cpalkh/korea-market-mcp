import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ecosCall, ecosTableList } from "../ecos";
import { nowKstLabel, safe, table, UpstreamError, fmtNum } from "../common";

const SOURCE = "출처: 한국은행 경제통계시스템(ECOS) https://ecos.bok.or.kr";

const CYCLE_HELP =
  "주기: A=연(YYYY), S=반기(YYYYS1), Q=분기(YYYYQ1), M=월(YYYYMM), SM=반월(YYYYMMS1), D=일(YYYYMMDD). 주기와 날짜 형식이 맞지 않으면 '데이터 없음'으로 나온다.";

export function registerEcosTools(server: McpServer) {
  server.tool(
    "ecos_search_tables",
    "한국은행 ECOS 통계표를 키워드로 찾는다 → 통계표코드(STAT_CODE)와 주기 확인. 시계열을 조회하기 전에 반드시 먼저 쓴다. " +
      "통계표코드는 주기(일·월·분기·연)마다 다르므로 결과의 주기 칸을 확인한다. 조회가능=Y 인 표만 ecos_get_series 로 조회된다. " +
      "예: '국고채', '환율', '기준금리', '소비자물가', '생산자물가', 'GDP'.",
    {
      keyword: z.string().min(1).describe("통계표명 키워드. 띄어쓰기로 여러 단어를 주면 모두 포함된 표만"),
      only_searchable: z.boolean().default(true).describe("조회 가능한(SRCH_YN=Y) 표만 (기본 true)"),
      limit: z.number().int().min(1).max(100).default(40),
    },
    safe(async ({ keyword, only_searchable, limit }) => {
      const words = keyword.split(/\s+/).filter(Boolean);
      const rows = (await ecosTableList()).filter(
        (r) => words.every((w) => (r.STAT_NAME ?? "").includes(w)) && (!only_searchable || r.SRCH_YN === "Y")
      );
      if (!rows.length) return `"${keyword}"에 해당하는 통계표가 없습니다. 더 짧은 키워드나 다른 표현으로 다시 찾아보세요.`;
      const shown = rows.slice(0, limit);
      return [
        `## ECOS 통계표 검색: "${keyword}" (${rows.length}건 중 ${shown.length}건)`,
        table(
          ["통계표코드", "통계표명", "주기", "조회가능", "작성기관"],
          shown.map((r) => [r.STAT_CODE, r.STAT_NAME, r.CYCLE, r.SRCH_YN, r.ORG_NAME])
        ),
        "다음: ecos_get_items(stat_code)로 세부 항목코드를 확인한 뒤 ecos_get_series 로 조회.",
      ].join("\n\n");
    })
  );

  server.tool(
    "ecos_get_items",
    "ECOS 통계표의 세부 항목코드(ITEM_CODE), 단위, 수록기간을 조회한다. ecos_get_series 에 넣을 item_codes 를 여기서 고른다.",
    {
      stat_code: z.string().min(1).describe("통계표코드 (ecos_search_tables 결과)"),
      keyword: z.string().optional().describe("항목명으로 좁히기 (예: '미국', '3년')"),
      limit: z.number().int().min(1).max(500).default(150),
    },
    safe(async ({ stat_code, keyword, limit }) => {
      let rows = await ecosCall("StatisticItemList", 1, 2000, [stat_code]);
      if (keyword) rows = rows.filter((r) => (r.ITEM_NAME ?? "").includes(keyword) || (r.GRP_NAME ?? "").includes(keyword));
      if (!rows.length) return `통계표 ${stat_code}에서 항목을 찾지 못했습니다${keyword ? ` (키워드 "${keyword}")` : ""}.`;
      const shown = rows.slice(0, limit);
      return [
        `## ${rows[0].STAT_NAME ?? stat_code} 항목 (${rows.length}건 중 ${shown.length}건)`,
        table(
          ["그룹", "항목코드", "항목명", "상위항목", "주기", "시작", "종료", "단위"],
          shown.map((r) => [r.GRP_NAME, r.ITEM_CODE, r.ITEM_NAME, r.P_ITEM_NAME, r.CYCLE, r.START_TIME, r.END_TIME, r.UNIT_NAME])
        ),
        "그룹이 여러 개인 표는 그룹 순서대로 item_codes 를 [그룹1 코드, 그룹2 코드, …]로 넣는다.",
      ].join("\n\n");
    })
  );

  server.tool(
    "ecos_get_series",
    "ECOS 시계열 데이터를 조회한다(금리·환율·물가·GDP 등). " + CYCLE_HELP +
      " 감사·평가 조서에 쓸 때는 결과의 조회시각과 통계표코드를 함께 남긴다(ECOS 수치는 사후 개정될 수 있음).",
    {
      stat_code: z.string().min(1).describe("통계표코드"),
      cycle: z.enum(["A", "S", "Q", "M", "SM", "D"]).describe("주기"),
      start: z.string().min(4).describe("시작 시점 (주기 형식에 맞게)"),
      end: z.string().min(4).describe("종료 시점 (주기 형식에 맞게)"),
      item_codes: z.array(z.string()).max(4).default([]).describe("항목코드 (그룹 순서대로, 최대 4개). 비우면 전체 항목"),
      max_rows: z.number().int().min(1).max(10000).default(1000),
    },
    safe(async ({ stat_code, cycle, start, end, item_codes, max_rows }) => {
      const params = [stat_code, cycle, start, end, ...item_codes.map((c) => c || "?")];
      const rows = await ecosCall("StatisticSearch", 1, max_rows, params);
      if (!rows.length) {
        return `데이터가 없습니다. 주기(${cycle})와 날짜 형식이 맞는지, 항목코드가 맞는지 확인하세요. ${CYCLE_HELP}`;
      }
      const nameCols = [1, 2, 3, 4].filter((i) => rows.some((r) => r[`ITEM_NAME${i}`]));
      const headers = ["시점", ...nameCols.map((i) => `항목${i}`), "값", "단위"];
      const body = rows.map((r) => [r.TIME, ...nameCols.map((i) => r[`ITEM_NAME${i}`]), fmtNum(r.DATA_VALUE), r.UNIT_NAME]);
      return [
        `## ${rows[0].STAT_NAME} (${stat_code}, ${cycle}) ${start}~${end} — ${rows.length}건${rows.length === max_rows ? " (상한 도달: max_rows 를 늘리거나 기간을 나눠 조회)" : ""}`,
        table(headers, body),
        `${SOURCE} · 조회시각 ${nowKstLabel()}`,
      ].join("\n\n");
    })
  );

  server.tool(
    "ecos_key_statistics",
    "한국은행 100대 통계지표의 최신값을 한 번에 본다(기준금리·국고채·환율·물가·성장률 등). 통계표코드 없이 바로 쓸 수 있다.",
    { keyword: z.string().optional().describe("지표명/분류로 좁히기 (예: '금리', '환율')") },
    safe(async ({ keyword }) => {
      let rows = await ecosCall("KeyStatisticList", 1, 200);
      if (keyword) rows = rows.filter((r) => (r.KEYSTAT_NAME ?? "").includes(keyword) || (r.CLASS_NAME ?? "").includes(keyword));
      if (!rows.length) return "해당하는 지표가 없습니다.";
      return [
        `## 한국은행 100대 통계지표${keyword ? ` — "${keyword}"` : ""} (${rows.length}건)`,
        table(
          ["분류", "지표", "값", "단위", "시점"],
          rows.map((r) => [r.CLASS_NAME, r.KEYSTAT_NAME, fmtNum(r.DATA_VALUE), r.UNIT_NAME, r.CYCLE])
        ),
        `${SOURCE} · 조회시각 ${nowKstLabel()}`,
      ].join("\n\n");
    })
  );

  server.tool(
    "ecos_stat_word",
    "한국은행 통계용어사전에서 용어 정의를 찾는다 (예: '경제심리지수', 'GDP 디플레이터').",
    { word: z.string().min(1) },
    safe(async ({ word }) => {
      const rows = await ecosCall("StatisticWord", 1, 10, [word]);
      if (!rows.length) throw new UpstreamError(`"${word}" 용어를 찾지 못했습니다.`);
      return rows.map((r) => `### ${r.WORD}\n${r.CONTENT}`).join("\n\n") + `\n\n${SOURCE}`;
    })
  );
}
