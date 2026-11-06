import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerEcosTools } from "./ecos-tools";
import { registerKrxTools } from "./krx-tools";
import { registerEximTools } from "./exim-tools";
import { ok } from "../common";

export function registerAllTools(server: McpServer) {
  server.tool(
    "market_server_status",
    "이 서버에 각 기관 API 키가 설정돼 있는지 확인한다 (키 값은 보여주지 않음). 도구가 키 오류를 낼 때 먼저 확인.",
    {},
    async () => {
      const has = (n: string) => (process.env[n]?.trim() ? "설정됨 ✅" : "없음 ❌ (Vercel → Settings → Environment Variables 에 추가 후 Redeploy)");
      return ok(
        [
          "## korea-market-mcp 상태",
          `- 한국은행 ECOS (ECOS_API_KEY): ${has("ECOS_API_KEY")}`,
          `- 한국거래소 KRX (KRX_API_KEY): ${has("KRX_API_KEY")}`,
          `- 수출입은행 환율 (KOREAEXIM_API_KEY): ${has("KOREAEXIM_API_KEY")}`,
        ].join("\n")
      );
    }
  );
  registerEcosTools(server);
  registerKrxTools(server);
  registerEximTools(server);
}
