# AX Crew 데모 백엔드 (axdemo-bridge)

프런트(`docs/` = GitHub Pages)가 호출하는 브리지 서버. VPS에서 OpenClaw 게이트웨이의
격리 에이전트 2기(axdemo="나루", axcritic="결")를 호출한다. 의존성 0 (node 내장만).

## 구조
```
GitHub Pages (docs/)  →  https://<도메인>/axdemo/*  (Caddy handle_path)
                      →  127.0.0.1:18790 axdemo-bridge (systemd)
                      →  openclaw agent --agent axdemo|axcritic --session-key ... --json
```

## 엔드포인트
| 경로 | 동작 |
|---|---|
| `POST /verify` | 접근코드 확인 |
| `POST /chat` | 나루 DM 1턴 (`{code, session, message}`) |
| `POST /thread` | `kind: "lounge"`(나루→결→나루 대화) 또는 `"review"`(초안→검증→수정). sid 기반 세션 키라 채널 대화가 이어진다 |
| `GET /thread/:id` | 진행 상태 폴링 `{status, steps:[{agent,text}]}` |
| `GET /health` | 연결 확인 |

## 배포 (서버에서)
1. `server.js` + `config.json`(example 참고, 600) → `/root/axdemo-bridge/`
2. `axdemo-bridge.service` → `/etc/systemd/system/` → `systemctl enable --now axdemo-bridge`
3. Caddy 해당 도메인 블록에: `handle_path /axdemo/* { reverse_proxy <도커GW IP>:18790 }`

## 에이전트 격리 (중요 — 반드시)
OpenClaw 임베디드 에이전트는 **기본값이 셸 풀오픈**이다. 익명 노출 전 openclaw.json에:
```json
"agents": { "entries": { "axdemo": { "tools": {
  "profile": "minimal",
  "deny": ["sessions_list","session_status","sessions_history","sessions_send","sessions_spawn","agents_list","cron","message","browser","canvas","image","web_search","web_fetch"],
  "exec": { "security": "deny" }
} } } }
```
(axcritic 동일). 검증은 4종: date 실행 / /etc/passwd 읽기 / /tmp 쓰기 / 세션목록 조회 — 전부 거부돼야 한다.
참고: codex 계열 모델은 exec deny 시 동작 불가 — claude-cli 런타임 모델을 쓸 것.
페르소나는 각 워크스페이스의 AGENTS.md/IDENTITY.md/SOUL.md (게이트웨이 자동 주입 — Read 도구 없이도 적용됨).
