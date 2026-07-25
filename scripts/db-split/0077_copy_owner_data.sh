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

  # 先补函数：`pg_dump --table` **只带表**，不带 schema 里的函数。而源库的触发器是**指名调用**
  # public 下的函数的（今天有一个：`client_env_scope` 上的清理准入守卫），函数不在目标库里，
  # 恢复到 post-data 建触发器那一步就当场炸，而且是在表和数据都已经灌完之后才炸。
  # 处置：把 public 下的全部函数先复制过去。多带几个用不上的函数是惰性的（与多带一张表不同），
  # 少带一个则是响亮但很晚的失败，方向上宁可多带。
  nfunc="$(psql -qtA -d "$SOURCE_DB" -c "
    select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'")"
  if [ "$nfunc" != "0" ]; then
    psql -qtA -d "$SOURCE_DB" -c "
      select pg_get_functiondef(p.oid) || ';' ||
             ' ALTER FUNCTION public.' || p.proname || '(' ||
             pg_get_function_identity_arguments(p.oid) || ') OWNER TO ' ||
             quote_ident(pg_get_userbyid(p.proowner)) || ';'
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
       order by p.proname" \
      | psql -v ON_ERROR_STOP=1 -q -d "$target"
    echo "  prerequisites: $nfunc public function(s) copied"
  fi

  args=()
  while read -r t; do
    [ -z "$t" ] && continue
    args+=(--table="public.$t")
  done < <(grep -v '^#' "$list" | grep -v '^[[:space:]]*$')

  # 属主与权限**照搬源库**（刻意不加 --no-owner / --no-acl）。
  #
  # 为什么：本脚本以超级用户身份恢复。若不照搬，新库里的表就全归恢复者（postgres）所有，而应用
  # 是以**应用角色**连库的 ⇒ 翻转当天每一次写入都 permission denied，而且是在切换之后才暴露。
  # 角色是**集群级**对象、三个属主库与源库同实例，所以 pg_dump 生成的 `ALTER ... OWNER TO <role>`
  # 与 GRANT 在目标库里逐字可执行，拿到与源库**逐字一致**的属主与授权。
  # 实测源库形态（2026-07-25 dev）：95 张表属应用角色、3 张（互动回复配置作用域三表）属 postgres、
  # 21 个序列全部是表的从属序列（`-t` 会一并带走）——照搬即保真，不需要任何人工归位。
  pg_dump "${args[@]}" -d "$SOURCE_DB" \
    | psql -v ON_ERROR_STOP=1 -q -d "$target"
  echo "  copied."
done

echo "== done. now run: bash scripts/db-split/0078_verify_owner_split.sh --all =="
