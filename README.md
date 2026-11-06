# korea-market-mcp

한국거래소(KRX), 한국은행 ECOS, 한국수출입은행 환율 Open API를 하나로 묶은 개인용 원격 MCP 서버 (Vercel, 서울 리전).

## 환경변수 (Vercel → Settings → Environment Variables)
| 이름 | 발급처 |
|---|---|
| `ECOS_API_KEY` | ecos.bok.or.kr → Open API → 인증키 신청 |
| `KOREAEXIM_API_KEY` | koreaexim.go.kr → 오픈API(환율) → 인증키 발급 |
| `KRX_API_KEY` | openapi.krx.co.kr → 인증키 신청 + API별 이용신청 |

키가 없는 기관의 도구만 오류를 내고, 나머지는 정상 동작합니다. 키를 추가·변경하면 Redeploy 해야 반영됩니다.

## Claude 연결
claude.ai → 설정 → 커넥터 → 커스텀 커넥터 추가 → URL `https://<프로젝트>.vercel.app/api/mcp`, 인증 "로그인 없음".

## 도구
- 상태: `market_server_status`
- ECOS: `ecos_search_tables`, `ecos_get_items`, `ecos_get_series`, `ecos_key_statistics`, `ecos_stat_word`
- KRX: `krx_stock_daily`, `krx_stock_info`, `krx_price_history`, `krx_index_daily`, `krx_index_history`, `krx_etf_daily`, `krx_call`
- 수출입은행: `exim_exchange_rate`, `exim_rate_history`, `exim_interest_rates`

KRX 종가는 수정주가가 아닙니다. KRX Open API는 약관상 상업적 이용이 제한됩니다.
