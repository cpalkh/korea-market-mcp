export default function Home() {
  return (
    <main style={{ fontFamily: "sans-serif", maxWidth: 640, margin: "40px auto", lineHeight: 1.6 }}>
      <h1>Korea Market MCP</h1>
      <p>한국거래소(KRX) · 한국은행(ECOS) · 수출입은행 환율을 Claude에서 조회하는 개인용 MCP 서버입니다.</p>
      <p>MCP 엔드포인트: <code>/api/mcp</code></p>
    </main>
  );
}
