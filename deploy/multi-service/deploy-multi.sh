#!/usr/bin/env bash
#
# deploy-multi.sh — aidcp-cloud 一机多服务（Block② 2e）部署编排。
#
# additive / opt-in：把单体 aidcp-cloud.service 平滑切到多服务拓扑，或从多服务回切到单体。
# 绝不破坏现有单 service 部署——单体单元文件本身不删，回滚一条命令即恢复。
#
# 用法：
#   deploy-multi.sh <dev|ol>                    切到 3-service（content + automation + api）【默认】
#   deploy-multi.sh <dev|ol> --topology 2       切到 2-service（content + core）【当前代码可用的中间态】
#   deploy-multi.sh <dev|ol> rollback           回切到单体 aidcp-cloud.service
#   deploy-multi.sh <dev|ol> healthcheck        只跑健康检查（读当前正在跑的拓扑）
#   deploy-multi.sh <dev|ol> check              只做前置探测（key / 可达 / 能力 grep），不改任何状态
#
# 安全序列（up）：备份 → 同步代码 → npm install → 能力探测 → 装单元 → daemon-reload →
#   停单体 → 依次起 content→(automation→api | core) 并逐个健康检查 → 失败自动回滚到单体。
#
# ╔══════════════════════════════════════════════════════════════════════════╗
# ║ isales 红线：本脚本只操作 aidcp-cloud* 单元与 /opt/aidcp/cloud 目录。      ║
# ║ 绝不 stop / restart / rsync / 备份任何 isales 服务、目录或端口。          ║
# ║ 所有 systemctl 目标都以 aidcp-cloud 前缀断言校验（见 assert_aidcp_unit）。 ║
# ╚══════════════════════════════════════════════════════════════════════════╝
#
# 前置事实（与 docs/deployment-ecs.md 一致）：
#   - 部署目录 /opt/aidcp/cloud；EnvironmentFile=/opt/aidcp/cloud/.env（rsync 永远 exclude .env）。
#   - ECS 无 lsof；端口检查用 ss。ExecStart=/usr/bin/npx tsx src/server.ts。
#   - 代码来源 = 本 worktree HEAD 的 git archive 快照（干净树），非工作区脏文件。
#
set -euo pipefail

# ── 常量 ─────────────────────────────────────────────────────────────────────
CLOUD_DIR="/opt/aidcp/cloud"
UNIT_DIR="/etc/systemd/system"
MONOLITH="aidcp-cloud.service"
CONTENT_UNIT="aidcp-cloud-content.service"
AUTOMATION_UNIT="aidcp-cloud-automation.service"
API_UNIT="aidcp-cloud-api.service"
CORE_UNIT="aidcp-cloud-core.service"
CONTENT_PORT="8092"
WS_PORT="8787"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"

log()  { printf '\033[1;34m[multi]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[multi][warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[multi][fatal]\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '3,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 1
}

# ── 目标解析（镜像中控仓 scripts/deploy-target 的 dev/ol 映射，保持自包含）──────
resolve_target() {
  case "$1" in
    dev) HOST="121.89.85.150"; KEY="$HOME/codes/dev-0722.pem" ;;
    ol)  HOST="123.56.253.183"; KEY="$HOME/codes/ol-0722.pem" ;;
    *)   usage ;;
  esac
  SSH_USER="root"
  [ -f "$KEY" ] || die "缺少 SSH key：$KEY"
  [ -r "$KEY" ] || die "SSH key 不可读：$KEY"
}

SSH()  { ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "$SSH_USER@$HOST" "$@"; }
RSYNC(){ rsync -az -e "ssh -i $KEY -o StrictHostKeyChecking=accept-new" "$@"; }

# 断言单元名属 aidcp-cloud*，杜绝手滑把 isales 单元传进 systemctl。
assert_aidcp_unit() {
  case "$1" in
    aidcp-cloud*) : ;;
    *) die "拒绝操作非 aidcp-cloud 单元：$1（isales 红线）" ;;
  esac
}
sctl() { assert_aidcp_unit "$1"; SSH systemctl "$2" "$1"; }

# ── 前置探测 ─────────────────────────────────────────────────────────────────
preflight() {
  log "前置探测 → $SSH_USER@$HOST"
  SSH true || die "SSH 不可达：$SSH_USER@$HOST"
  SSH "test -d $CLOUD_DIR" || die "$CLOUD_DIR 不存在（云端未初始化？）"
  SSH "test -f $CLOUD_DIR/.env" || die "$CLOUD_DIR/.env 不存在（多服务共享同一 .env）"
  log "前置探测通过：SSH 可达、$CLOUD_DIR 与 .env 就位。"
}

# 能力探测：3-service 需选择器识别 automation/api；2-service 需识别 core。
# 探测的是**将要运行的**已同步代码（rsync 之后调用）。未满足即拒绝切换，保持单体不停机。
capability_probe() {
  local topo="$1" f="$CLOUD_DIR/src/gateway/service-mode.ts"
  SSH "test -f $f" || die "缺少 ${f}（代码未同步或结构变化）"
  if [ "$topo" = "3" ]; then
    if ! SSH "grep -q \"'automation'\" $f && grep -q \"'api'\" $f"; then
      die "能力探测失败：service-mode.ts 尚未识别 'automation' / 'api'（当前仅 content/core/monolith）。
       →  3-service 会让 api/automation 回落 monolith、争抢 8787，禁止切换。
       →  这是 runtime split 工作线的前置：先让选择器识别 api/automation 且 segD 可脱 segC 独立 boot。
       →  当前可用：deploy-multi.sh $TARGET --topology 2（content + core），单体不受影响。"
    fi
    log "能力探测通过：选择器已识别 automation / api。"
  else
    SSH "grep -q \"'core'\" $f" || die "能力探测失败：service-mode.ts 未识别 'core'。"
    log "能力探测通过：选择器已识别 core（2-service 中间态可用）。"
  fi
}

# ── 备份（先备份，可回滚）────────────────────────────────────────────────────
backup() {
  local ts; ts="$(date +%Y%m%d-%H%M%S)"
  log "备份代码与 .env（不含 node_modules）…"
  # 与 docs/deployment-ecs.md 约定一致：cloud.bak.<ts>.tar.gz + .env.bak.<date>
  SSH "tar --exclude=node_modules -czf /opt/aidcp/cloud.bak.${ts}.tar.gz -C /opt/aidcp cloud \
       && cp -f $CLOUD_DIR/.env $CLOUD_DIR/.env.bak.$(date +%Y%m%d)" \
    || die "备份失败，中止（未改任何运行状态）。"
  log "备份完成：/opt/aidcp/cloud.bak.${ts}.tar.gz + .env.bak"
}

# ── 同步代码（git archive HEAD → staging → rsync，干净树快照）──────────────────
sync_code() {
  local staging; staging="$(mktemp -d)"
  trap 'rm -rf "$staging"' RETURN
  log "从 HEAD 生成干净树快照 → $staging"
  git -C "$REPO_ROOT" archive HEAD | tar -x -C "$staging"
  log "rsync 快照 → $HOST:${CLOUD_DIR}（exclude .env / node_modules / .git）"
  # 不用 --delete：只覆盖更新，避免误删云端仅有文件；.env / node_modules / .git 永远保留。
  RSYNC \
    --exclude '.env' --exclude 'node_modules' --exclude '.git' \
    "$staging"/ "$SSH_USER@$HOST:$CLOUD_DIR/"
  log "云端安装依赖（node_modules 被 exclude，需在 ECS 侧 install；幂等）…"
  SSH "cd $CLOUD_DIR && npm install --no-audit --no-fund" || die "npm install 失败。"
}

# ── 装单元 + daemon-reload（幂等；从已同步的仓内副本安装，单一真源）───────────
install_units() {
  log "安装 systemd 单元 → ${UNIT_DIR}（从 $CLOUD_DIR/deploy/multi-service/ 拷贝）"
  SSH "cp -f $CLOUD_DIR/deploy/multi-service/aidcp-cloud-content.service \
             $CLOUD_DIR/deploy/multi-service/aidcp-cloud-automation.service \
             $CLOUD_DIR/deploy/multi-service/aidcp-cloud-api.service \
             $CLOUD_DIR/deploy/multi-service/aidcp-cloud-core.service \
             $UNIT_DIR/ && systemctl daemon-reload" \
    || die "单元安装 / daemon-reload 失败。"
  log "单元已安装、daemon-reload 完成。"
}

# ── 健康检查原语 ─────────────────────────────────────────────────────────────
svc_active() { assert_aidcp_unit "$1"; SSH "systemctl is-active --quiet $1"; }
port_listening() { SSH "ss -ltn 2>/dev/null | grep -q ':$1 '"; }
# 读云端 .env 里某端口键（沿用现值，不写死）；未设则返回空。
remote_env_port() { SSH "grep -E '^$1=' $CLOUD_DIR/.env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\"' | tr -d '[:space:]'"; }

check_content() {
  svc_active "$CONTENT_UNIT" || return 1
  port_listening "$CONTENT_PORT" || { warn "content 读 API 未监听 :$CONTENT_PORT"; return 1; }
  log "  ✓ content active + :$CONTENT_PORT 监听"
}
check_automation_ws() {
  # automation（3-service）或 core（2-service）都对外起 8787。
  local unit="$1"
  svc_active "$unit" || return 1
  port_listening "$WS_PORT" || { warn "$unit 未监听 :$WS_PORT"; return 1; }
  log "  ✓ $unit active + :$WS_PORT 监听"
}
check_api() {
  local unit="$1"
  svc_active "$unit" || return 1
  local pp cp; pp="$(remote_env_port AIDCP_PANEL_PORT)"; cp="$(remote_env_port AIDCP_CLIENT_AUTH_PORT)"
  if [ -n "$pp" ]; then
    port_listening "$pp" && log "  ✓ $unit panel :$pp 监听" || { warn "$unit panel :$pp 未监听"; return 1; }
  else
    warn "  · .env 未设 AIDCP_PANEL_PORT → 面板端口按禁用处理（未起属预期）"
  fi
  if [ -n "$cp" ]; then
    port_listening "$cp" && log "  ✓ $unit client-auth :$cp 监听" || { warn "$unit client-auth :$cp 未监听"; return 1; }
  else
    warn "  · .env 未设 AIDCP_CLIENT_AUTH_PORT → 客户鉴权端口按禁用处理（未起属预期）"
  fi
  # TODO(deep-check)：curated 读端点 route 路径未在本部署件坐实。补深检时可在此加：
  #   SSH "curl -fsS http://127.0.0.1:$CONTENT_PORT/<curated-read-health-route>"       # content 直连通
  #   SSH "curl -fsS http://127.0.0.1:$pp/<panel-route-that-reads-curated>"            # api 经网关读 content 通
  # 端点路径需与 registerCuratedContentRoutes / panel API 对齐后填入，不臆造。
}

healthcheck_topology() {
  local topo="$1" ok=0
  log "健康检查（topology=${topo}）"
  if [ "$topo" = "3" ]; then
    check_content        || ok=1
    check_automation_ws "$AUTOMATION_UNIT" || ok=1
    check_api "$API_UNIT" || ok=1
  else
    check_content        || ok=1
    check_automation_ws "$CORE_UNIT" || ok=1
    check_api "$CORE_UNIT" || ok=1
  fi
  return $ok
}

# ── 停 / 起 ──────────────────────────────────────────────────────────────────
stop_monolith() {
  log "停用单体 ${MONOLITH}（释放 8787 / panel / client-auth）"
  # disable --now：停止并去掉开机自启，避免与多服务同时抢端口。单元文件保留、可一键回切。
  sctl "$MONOLITH" "disable" || warn "$MONOLITH disable 返回非零（可能本就未启用），继续。"
  SSH "systemctl stop $MONOLITH" || true
}

stop_multi_units() {
  log "停用多服务单元"
  for u in "$CORE_UNIT" "$API_UNIT" "$AUTOMATION_UNIT" "$CONTENT_UNIT"; do
    sctl "$u" "disable" 2>/dev/null || true
    SSH "systemctl stop $u" 2>/dev/null || true
  done
}

# 按 up 拓扑等待某端口就绪（有界轮询，最多 ~40s）。
wait_port() {
  local port="$1" i
  for i in $(seq 1 20); do
    if port_listening "$port"; then return 0; fi
    SSH "sleep 2" || true
  done
  return 1
}

rollback_to_monolith() {
  warn "触发回滚 → 单体 $MONOLITH"
  stop_multi_units
  sctl "$MONOLITH" "enable" || true
  SSH "systemctl restart $MONOLITH" || die "回滚失败：$MONOLITH 无法启动，需人工介入（可从 cloud.bak.*.tar.gz 恢复）。"
  if svc_active "$MONOLITH" && wait_port "$WS_PORT"; then
    log "回滚成功：单体已恢复，:$WS_PORT 监听。"
  else
    die "回滚后单体未健康（:$WS_PORT 未监听），需人工介入。"
  fi
}

start_topology() {
  local topo="$1"
  stop_monolith
  log "启动 content …"
  sctl "$CONTENT_UNIT" "enable"; SSH "systemctl restart $CONTENT_UNIT"
  wait_port "$CONTENT_PORT" || { warn "content :$CONTENT_PORT 未就绪"; rollback_to_monolith; die "content 启动失败，已回滚。"; }
  check_content || { rollback_to_monolith; die "content 健康检查失败，已回滚。"; }

  if [ "$topo" = "3" ]; then
    log "启动 automation …"
    sctl "$AUTOMATION_UNIT" "enable"; SSH "systemctl restart $AUTOMATION_UNIT"
    wait_port "$WS_PORT" || { rollback_to_monolith; die "automation :$WS_PORT 未就绪，已回滚。"; }
    check_automation_ws "$AUTOMATION_UNIT" || { rollback_to_monolith; die "automation 健康检查失败，已回滚。"; }
    log "启动 api …"
    sctl "$API_UNIT" "enable"; SSH "systemctl restart $API_UNIT"
    check_api "$API_UNIT" || { rollback_to_monolith; die "api 健康检查失败，已回滚。"; }
  else
    log "启动 core（segC+segD 合跑）…"
    sctl "$CORE_UNIT" "enable"; SSH "systemctl restart $CORE_UNIT"
    wait_port "$WS_PORT" || { rollback_to_monolith; die "core :$WS_PORT 未就绪，已回滚。"; }
    check_automation_ws "$CORE_UNIT" || { rollback_to_monolith; die "core WS 健康检查失败，已回滚。"; }
    check_api "$CORE_UNIT" || { rollback_to_monolith; die "core api 健康检查失败，已回滚。"; }
  fi
  log "多服务（topology=${topo}）已就绪。"
}

# ── 主流程 ───────────────────────────────────────────────────────────────────
TARGET="${1:-}"; [ -n "$TARGET" ] || usage
shift || true
CMD="up"; TOPO="3"
while [ $# -gt 0 ]; do
  case "$1" in
    up|rollback|healthcheck|check) CMD="$1" ;;
    --topology) shift; TOPO="${1:-3}" ;;
    --topology=*) TOPO="${1#*=}" ;;
    *) usage ;;
  esac
  shift || true
done
[ "$TOPO" = "2" ] || [ "$TOPO" = "3" ] || die "--topology 只支持 2 或 3。"

resolve_target "$TARGET"

case "$CMD" in
  check)
    preflight
    # check 不改状态，能力探测跑在**当前云端已有代码**上（未同步），仅作提示。
    capability_probe "$TOPO" || true
    log "check 完成（未改任何状态）。"
    ;;
  healthcheck)
    healthcheck_topology "$TOPO" && log "健康检查全过。" || die "健康检查有未通过项（见上）。"
    ;;
  rollback)
    preflight
    rollback_to_monolith
    ;;
  up)
    preflight
    backup
    sync_code
    capability_probe "$TOPO"   # 同步后、停单体前探测：未满足即 die，单体不停机。
    install_units
    start_topology "$TOPO"
    log "==== 切换完成：topology=$TOPO @ $TARGET ===="
    healthcheck_topology "$TOPO" || warn "收尾健康检查有告警项，请复核。"
    ;;
  *) usage ;;
esac
