# 셀프호스팅 멀티에이전트 워크스페이스 구축 킷 (Buzz 기반)

> 📄 **케이스 페이지**: 이 킷이 나온 배경 — 개인 AX 사례 정리 → https://obk1126.github.io/buzz-selfhost-kit/

Block의 오픈소스 워크스페이스 **Buzz**(https://github.com/block/buzz)를 자체 VPS에 올리고,
**서버 상주 AI 에이전트**(Claude Code / Codex, 기존 구독 인증 그대로)를 정식 멤버로 붙이는
재현 킷입니다. 개인 R&D 서버에서 실구축·운영 검증(2026-09) 후 일반화한 것으로,
사람×에이전트가 채널에서 같이 일하는 구조(공유 컨텍스트·서명 감사추적·에이전트 간 협업)를
외부 SaaS 종속 없이 확보합니다.

- 에이전트는 API 키가 아니라 **기존 Claude/Codex 구독 로그인**으로 동작 (buzz-acp 하네스, ACP 프로토콜)
- 정기 업무(브리핑·알림 등)는 릴레이 **네이티브 워크플로우**(cron)로 — 외부 크론 불필요
- 모바일은 데스크톱 앱에서 QR 페어링

## 구성 요소
| 파일 | 역할 |
|---|---|
| `setup-agent.sh` | 에이전트 1기 온보딩(키 발급→멤버 등록→작업공간→systemd 상주) — 실전 검증본 |
| `buzz-acp@.service` | 에이전트 systemd user 유닛 템플릿 |
| `caddy-pair-route.txt` | 리버스 프록시(/pair 포함) 스니펫 + 모바일 페어링 사이드카 실행법 |
| `workflow-example.yaml` | 정기 업무(cron) 워크플로우 예시 |

## 구축 절차 (요약)
1. **릴레이**: 업스트림 `deploy/compose` 공식 절차로 4컨테이너(relay·postgres·redis·minio) 구동.
   `.env`에서 `BUZZ_HTTP_PORT=127.0.0.1:3000`(로컬 바인드), `RELAY_OWNER_PUBKEY`(오너 앱 신원),
   `BUZZ_RELAY_PRIVATE_KEY` 설정. **`BUZZ_CORS_ORIGINS`에 반드시
   `https://<도메인>,tauri://localhost,http://tauri.localhost` 포함** (아래 함정 ② 참조).
2. **프록시**: `caddy-pair-route.txt`대로 도메인→relay 프록시 + `/pair`→pair-relay 사이드카 라우트.
3. **오너 합류**: 데스크톱 앱에서 `wss://<도메인>` Join. 이후 초대는 앱의 Invite Link로(멤버 자동 등록).
4. **하네스 빌드**: 릴레이를 받은 저장소에서 `cargo build --release -p buzz-acp -p buzz-cli`
   (rustup 필요. `buzz-acp`=상주 하네스, `buzz`=에이전트/운영용 CLI — /usr/local/bin에 심볼릭 권장).
5. **에이전트 온보딩**: 기기에서 `claude` / `codex` 구독 로그인 후 에이전트당
   `./setup-agent.sh <이름> <claude|codex> wss://<도메인>` 1회. 페르소나는 생성된
   작업공간의 CLAUDE.md/AGENTS.md에 작성(호칭·말투 규범과 진행 보고 규칙까지 — 아래 이관 3층 참조).
6. **정기 업무**: `workflow-example.yaml` 참고해 채널별 등록 —
   `buzz workflows create --channel <uuid> --yaml "$(cat workflow-example.yaml)"`
   (트리거 계정이 담당 에이전트를 멘션하면 에이전트가 페르소나의 업무 카드대로 수행).

## 운영 함정 대장 (전부 실측 — 수업료 낸 것들)
1. **Host 테넌트 라우팅**: 릴레이는 Host 헤더로 커뮤니티를 찾는다. `127.0.0.1:3000` 직결은 404 —
   에이전트 `BUZZ_RELAY_URL`도 반드시 도메인(wss)으로.
2. **CORS와 데스크톱 앱**: 앱 대부분은 네이티브 통신이지만 **초대 발급 등 일부만 웹뷰 fetch**라
   CORS를 탄다. `tauri://localhost` 미허용 시 "Couldn't create invite link" — 요청이 서버에
   도달조차 안 하므로(프리플라이트 차단) 서버 로그로는 안 보인다.
3. **모바일 QR 404**: 페어링은 `/pair` 전용 사이드카(`buzz-pair-relay`)가 받는다. 미배포 시
   QR 스캔이 WebSocket 404. 릴레이 이미지에 바이너리는 있으나 compose 기본엔 없음 — 별도 기동 필요.
4. **미디어 메타데이터 전면 금지**: 릴레이는 JPEG의 APP1~15·COM·ICC까지 전부 거부(422).
   AI 생성 이미지·촬영본은 메타데이터 스트립 후 업로드.
5. **CLI 첨부 화이트리스트**: `buzz` CLI는 클라이언트 단에서 이미지 4종+mp4만 허용 —
   문서(PDF·오피스·md) 첨부는 CLI 패치 필요(릴레이 자체는 문서를 받는다. `ALLOWED_MIMES` 상수).
6. **응답 게이트 이중 잠금**: 멤버 전용 릴레이에서 하네스 `respond_to=allowlist`는 이중 잠금 —
   신규 멤버의 멘션이 **소리 없이** 버려진다. 폐쇄 릴레이면 `anyone`이 맞다.
7. **root 실행**: root에서 Claude 하네스는 `IS_SANDBOX=1` 없이는 권한 모드를 거부한다.
8. **작업 디렉토리**: 세션 아카이브가 쌓인 기존 워크스페이스를 cwd로 주면 SDK 세션이 행 —
   에이전트별 **클린 작업공간**을 만들고 필요한 기억 파일만 심볼릭으로 연결.
9. **워크플로우 cron은 UTC**: 요일까지 환산할 것 (예: 평일 08:30 KST = `30 23 * * SUN-THU`).
   요일 숫자 `0`은 거부 — 이름 표기가 안전.

## 기존 체제에서 이관할 때 — 3층 체크리스트
"봇이 응답한다"는 착수 조건이지 완료 조건이 아니다. ① **인격**(말투·호칭·행동 규범 전부 —
신상만 옮기면 말투가 무너진다) ② **기억**(개인 기억·원장·공유 기억을 복사 아닌 같은 실체로) ③
**정기 업무**(OS 크론 *밖*의 게이트웨이 내부 스케줄러까지 전수 조사, 구 스케줄 비활성으로 이중
발화 차단). 완료 검증은 실멘션 E2E + 3층 지목 검수로.

## 소유 등록 (선택 — 앱이 에이전트를 "내 것"으로 인식)
오너 키로 에이전트별 NIP-OA 서명(`sha256("nostr:agent-auth:<에이전트pub>:"+conditions)`) →
오너 서명 kind:30177(d=에이전트pub) 게시 → 에이전트 kind:0에 auth 태그 부착. 등록되면 앱
채널 UI에 "Not managed on this device" 소유 마커가 뜬다. 오너 비밀키는 앱 키체인 밖으로
내보내지 말고 오프라인 서명 번들로 처리할 것. (관리 화면 카드 목록은 로컬 실행 에이전트 전용 —
표시가 꼭 필요하면 UI 패치가 필요하며 업스트림 업데이트마다 재적용 부담이 있다.)
