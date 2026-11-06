import { createMcpHandler } from "mcp-handler";
import { registerAllTools } from "@/lib/tools";

const handler = createMcpHandler(
  (server) => {
    registerAllTools(server);
  },
  { capabilities: {} },
  { basePath: "/api", maxDuration: 60, verboseLogs: false }
);

// Without an explicit HEAD export, Next.js routes HEAD to GET and the MCP handler never finishes.
function head() {
  return new Response(null, { status: 405, headers: { Allow: "POST, DELETE" } });
}

export { handler as GET, handler as POST, handler as DELETE, head as HEAD };
