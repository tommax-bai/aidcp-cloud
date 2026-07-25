#!/usr/bin/env bash
# =============================================================================
# 0077 · 把共享库 aidcp 的表按属主拷进三个属主库（Block③ 物理拆库 · 运维脚本）
# =============================================================================
#
# 前置（缺一不可，脚本会逐条自检并在不满足时**拒绝执行**）：
#   1. 0075 已跑：aidcp_content / aidcp_automation / aidcp_api 三个空库已存在。
#   2. 0076 已跑：共享库 aidcp 里的**跨 owner 外键已降**。否则 pg_restore 建约束时会引用
#      不在本属主库里的表，restore 失败（或更糟：部分成功留下半张 schema）。
#   3. 已做整库备份（本脚本不替你做，也不检查——见 §红线）。
#
# 安全性质：
#   * **源库全程只读**：只对 aidcp 跑 pg_dump 与 SELECT，绝不写、绝不 DROP、绝不 ALTER。
#   * **目标库硬白名单**：只允许 aidcp_content / aidcp_automation / aidcp_api 三个名字。
#     任何其它库名（含 aidcp / isales / postgres）一律拒绝——isales 是同机另一套系统，红线。
#   * **默认幂等保守**：目标库非空时直接拒绝，不覆盖。要重灌须显式 --recreate，
#     且 --recreate 只 DROP SCHEMA public CASCADE **在白名单内的目标库上**。
#   * 拷贝单位 = 属主的**全部表**（含索引、约束、序列、默认值），来源 = scripts/db-split/owner-tables.<owner>.txt，
#     而那三个 .txt 由 boundaries/table-ownership.json 机械生成（唯一属主判据）。
#
# 用法：
#   bash scripts/db-split/0077_copy_owner_data.sh --check                 # 只做前置自检，什么都不拷
#   bash scripts/db-split/0077_copy_owner_data.sh --owner content         # 拷一个属主
#   bash scripts/db-split/0077_copy_owner_data.sh --all                   # 三个属主都拷
#   bash scripts/db-split/0077_copy_owner_data.sh --all --recreate        # 重灌（先清空目标库 public schema）
#
# 连接方式：走 PG 的标准 env（PGHOST/PGPORT/PGUSER/PGPASSWORD）或本机 peer。
#   在 dev ECS 上推荐：sudo -u postgres bash scripts/db-split/0077_copy_owner_data.sh --all
#   **本脚本不接受、不打印、不落盘任何口令。**
# =============================================================================
set -euo pipefail

SOURCE_DB="${SOURCE_DB:-aidcp}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- 目标库硬白名单（绝不可放宽）------------------------------------------------
declare -A TARGET_DB=( [content]=aidcp_content [automation]=aidcp_automation [api]=aidcp_api )
FORBIDDEN_TARGETS="aidcp isales postgres template0 template1"

OWNERS=()
RECREATE=0
CHECK_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --owner) OWNERS+=("$2"); shift 2 ;;
    --all) OWNERS=(content automation api); shift ;;
    --recreate) RECREATE=1; shift ;;
    --check) CHECK_ONLY=1; OWNERS=(content automation api); shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ ${#OWNERS[@]} -gt 0 ] || { echo "usage: $0 (--all | --owner <content|automation|api>) [--recreate] [--check]" >&2; exit 2; }

psql_src() { psql -v ON_ERROR_STOP=1 -qtA -d "$SOURCE_DB" -c "$1"; }

fail() { echo "REFUSED: $*" >&2; exit 1; }

# --- 前置自检 -----------------------------------------------------------------
echo "== preflight =="

# 源库存在且可连
psql_src "select 1" >/dev/null || fail "cannot connect to source db '$SOURCE_DB'"
echo "  source db '$SOURCE_DB' reachable (read-only from here on)"

for owner in "${OWNERS[@]}"; do
  target="${TARGET_DB[$owner]:-}"
  [ -n "$target" ] || fail "unknown owner '$owner'"
  for bad in $FORBIDDEN_TARGETS; do
    [ "$target" = "$bad" ] && fail "target '$target' is on the forbidden list"
  done
  list="$SCRIPT_DIR/owner-tables.$owner.txt"
  [ -f "$list" ] || fail "missing table list $list (run: npx tsx scripts/db-split/generate-owner-table-lists.ts)"

  # 目标库必须已经由 0075 建好
  exists="$(psql -qtA -d postgres -c "select 1 from pg_database where datname='$target'" || true)"
  [ "$exists" = "1" ] || fail "target db '$target' does not exist — run scripts/db-split/0075_create_per_service_databases.sql first"

  # 属主的表必须都在源库里
  missing=""
  while read -r t; do
    [ -z "$t" ] && continue
    got="$(psql_src "select 1 from pg_tables where schemaname='public' and tablename='$t'" || true)"
    [ "$got" = "1" ] || missing="$missing $t"
  done < <(grep -v '^#' "$list" | grep -v '^[[:space:]]*$')
  [ -z "$missing" ] || fail "owner '$owner': tables missing from source db:$missing"

  # 跨 owner 外键必须已降（0076）——否则 restore 会引用本库不存在的表
  intable="$(grep -v '^#' "$list" | grep -v '^[[:space:]]*$' | sed "s/^/'/;s/\$/'/" | paste -sd, -)"
  cross="$(psql_src "
    select c.conrelid::regclass || ' -> ' || c.confrelid::regclass
      from pg_constraint c
     where c.contype = 'f'
       and c.conrelid::regclass::text in ($intable)
       and c.confrelid::regclass::text not in ($intable)")"
  if [ -n "$cross" ]; then
    echo "  owner '$owner': cross-owner FOREIGN KEYs still present:" >&2
    echo "$cross" | sed 's/^/    /' >&2
    fail "run scripts/db-split/0076_downgrade_cross_owner_account_fk.sql on '$SOURCE_DB' first"
  fi

  n="$(grep -vc '^#' "$list" || true)"
  echo "  owner '$owner' -> '$target': $(grep -v '^#' "$list" | grep -vc '^[[:space:]]*$') tables, no cross-owner FK, target exists"
done

if [ "$CHECK_ONLY" = "1" ]; then echo "== preflight only, nothing copied =="; exit 0; fi

# --- 拷贝 ---------------------------------------------------------------------
for owner in "${OWNERS[@]}"; do
  target="${TARGET_DB[$owner]}"
  list="$SCRIPT_DIR/owner-tables.$owner.txt"
  echo "== copy $owner: $SOURCE_DB -> $target =="

  ntables="$(psql -qtA -d "$target" -c "select count(*) from pg_tables where schemaname='public'")"
  if [ "$ntables" != "0" ]; then
    if [ "$RECREATE" = "1" ]; then
      echo "  target has $ntables tables; --recreate given -> DROP SCHEMA public CASCADE on '$target'"
      psql -v ON_ERROR_STOP=1 -d "$target" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
    else
      fail "target '$target' already has $ntables tables; pass --recreate to reload (this DROPs that database's public schema)"
    fi
  fi

  args=()
  while read -r t; do
    [ -z "$t" ] && continue
    args+=(--table="public.$t")
  done < <(grep -v '^#' "$list" | grep -v '^[[:space:]]*$')

  # --no-owner/--no-acl：目标库的属主与权限由建库时的 OWNER 决定，不从源库照搬。
  pg_dump --no-owner --no-acl "${args[@]}" -d "$SOURCE_DB" \
    | psql -v ON_ERROR_STOP=1 -q -d "$target"
  echo "  copied."
done

echo "== done. now run: bash scripts/db-split/0078_verify_owner_split.sh --all =="
