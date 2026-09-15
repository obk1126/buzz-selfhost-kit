#!/bin/bash
# 서버 상주 에이전트 1기 온보딩: 키 발급 → 릴레이 멤버 등록 → 클린 작업공간 → systemd 상주
# 사용: ./setup-agent.sh <이름(영소문자)> <claude|codex> <릴레이 wss URL>
# 전제: 릴레이 compose 가동 중(/root/buzz/deploy/compose), 해당 계정에 claude/codex 구독 로그인 완료,
#       ACP 어댑터 설치: npm i -g @agentclientprotocol/claude-agent-acp @agentclientprotocol/codex-acp
set -euo pipefail
NAME=${1:?이름}; HARNESS=${2:?claude|codex}; RELAY=${3:?wss://도메인}
case "$HARNESS" in
  claude) CMD=claude-agent-acp ;;
  codex)  CMD=codex-acp ;;
  *) echo "harness는 claude 또는 codex"; exit 1 ;;
esac

KD=/root/buzz/agent-keys; WD=/root/buzz-acp/work/$NAME; ED=/root/buzz-acp/env
install -d -m 700 "$KD" "$ED"; install -d "$WD"

# 1) 키 발급 (비밀키는 서버 파일 600에만 — 절대 로그·채팅에 노출 금지)
if [ ! -f "$KD/$NAME.key" ]; then
  (cd /root/buzz/deploy/compose && docker compose exec -T relay /usr/local/bin/buzz-admin generate-key) > "$KD/$NAME.key"
  chmod 600 "$KD/$NAME.key"
fi
PUB=$(awk '/Public key/{print $3}' "$KD/$NAME.key")
SEC=$(awk '/Secret key/{print $3}' "$KD/$NAME.key")

# 2) 릴레이 멤버 등록
(cd /root/buzz/deploy/compose && ./run.sh add-member "$PUB") >/dev/null

# 3) 클린 작업공간 + 페르소나 뼈대 (기존 워크스페이스 재사용 금지 — README 함정 ⑧)
PFILE=$([ "$HARNESS" = claude ] && echo CLAUDE.md || echo AGENTS.md)
[ -f "$WD/$PFILE" ] || cat > "$WD/$PFILE" <<'EOF'
# 페르소나 (직접 작성할 것)
- 역할·말투·호칭 규범(존대 규칙 포함)을 여기에 명시한다 — 규범도 인격의 일부다.
- 진행 보고 규칙: 다단계 작업은 접수 한 줄 → 단계별 중간 보고 → 결과 보고. 30초 이상 침묵 금지.
- 정기 업무 카드: "[정기] @나 <업무명>" 멘션을 받으면 아래 해당 업무의 지시를 수행해 그 채널에 게시한다.
EOF

# 4) env (respond 게이트: 폐쇄 릴레이 전제 anyone — README 함정 ⑥)
{
  echo "BUZZ_PRIVATE_KEY=$SEC"
  echo "BUZZ_RELAY_URL=$RELAY"
  echo "BUZZ_ACP_AGENT_COMMAND=$CMD"
  echo "BUZZ_ACP_DISPLAY_NAME=$NAME"
  echo "BUZZ_ACP_RESPOND_TO=anyone"
  [ "$HARNESS" = claude ] && echo "IS_SANDBOX=1"   # README 함정 ⑦
} > "$ED/$NAME.env"
chmod 600 "$ED/$NAME.env"

# 5) systemd user 유닛 (최초 1회 설치) + 기동
install -d /root/.config/systemd/user
[ -f /root/.config/systemd/user/buzz-acp@.service ] || cp "$(dirname "$0")/buzz-acp@.service" /root/.config/systemd/user/
export XDG_RUNTIME_DIR=/run/user/$(id -u)
loginctl enable-linger "$(whoami)" 2>/dev/null || true
systemctl --user daemon-reload
systemctl --user enable --now "buzz-acp@$NAME"
sleep 5; systemctl --user is-active "buzz-acp@$NAME"

# 6) 프로필 발행 (표시 이름)
BUZZ_PRIVATE_KEY=$SEC BUZZ_RELAY_URL=${RELAY/wss:/https:} \
  buzz users set-profile --name "$NAME" >/dev/null 2>&1 || echo "(buzz CLI 미설치 시 프로필은 나중에)"

echo "완료: $NAME ($HARNESS) — pubkey $PUB"
echo "다음: 앱에서 채널에 초대(자동 구독) → 멘션으로 호출. 페르소나: $WD/$PFILE"
