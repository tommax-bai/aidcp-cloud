#!/usr/bin/env bash
# =============================================================================
# 0078 · 校验属主库拷贝的等价性（Block③ 物理拆库 · 只读校验）
# =============================================================================
#
# 全程**只读**：只跑 SELECT / count(*)，对任何库都不写。
#
# 逐属主校验四件事：
#   1. 表数对得上（属主清单里的每张表都在目标库里）；
#   2. **每张表的行数逐表相等**（源 aidcp vs 目标属主库）；
#   3. 目标库里**没有多余的表**（不该有别的属主的表混进来）；
#   4. 目标库里**没有跨 owner 外键**残留。
#
# 用法：
#   bash scripts/db-split/0078_verify_owner_split.sh --all
#   bash scripts/db-split/0078_verify_owner_split.sh --owner automation
#   在 dev ECS 上：sudo -u postgres bash scripts/db-split/0078_verify_owner_split.sh --all
#
# 退出码 0 = 全等价；非 0 = 有差异（差异逐条打印）。
# =============================================================================
set -euo pipefail

SOURCE_DB="${SOURCE_DB:-aidcp}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
declare -A TARGET_DB=( [content]=aidcp_content [automation]=aidcp_automation [api]=aidcp_api )

OWNERS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --owner) OWNERS+=("$2"); shift 2 ;;
    --all) OWNERS=(content automation api); shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ ${#OWNERS[@]} -gt 0 ] || { echo "usage: $0 (--all | --owner <content|automation|api>)" >&2; exit 2; }

problems=0
note() { echo "  DIFF: $*"; problems=$((problems+1)); }

for owner in "${OWNERS[@]}"; do
  target="${TARGET_DB[$owner]:-}"
  [ -n "$target" ] || { echo "unknown owner '$owner'" >&2; exit 2; }
  list="$SCRIPT_DIR/owner-tables.$owner.txt"
  echo "== verify $owner: $SOURCE_DB vs $target =="

  # ⚠️ 两侧的排序 MUST 用同一套规则再喂给 comm。shell 的 `sort` 走 locale collation、psql 的
  # `ORDER BY` 走库的 collation，而这台机器上两者对下划线的处理相反（`client_env_scope` 与
  # `client_environments` 的先后正好颠倒）⇒ comm 会报出一堆**根本不存在的**差异。
  # 统一钉在 C（字节序）上：`LC_ALL=C sort` + SQL 侧不依赖 ORDER BY。
  expected="$(grep -v '^#' "$list" | grep -v '^[[:space:]]*$' | LC_ALL=C sort)"

  # 3. 目标库里不该有多余的表
  actual="$(psql -qtA -d "$target" -c "select tablename from pg_tables where schemaname='public'" | LC_ALL=C sort)"
  extra="$(comm -13 <(echo "$expected") <(echo "$actual") || true)"
  [ -z "$extra" ] || note "target '$target' has tables NOT owned by '$owner': $(echo "$extra" | paste -sd, -)"

  # 1 + 2 + 5. 每张表都在、行数相等、**属主一致**
  #
  # 属主为什么必须查：恢复是以超级用户做的。若 dump 时加了 --no-owner，新库的表就全归 postgres，
  # 而应用以**应用角色**连库 ⇒ 翻转后每次写入 permission denied，且只在切换之后才暴露。
  while read -r t; do
    [ -z "$t" ] && continue
    there="$(psql -qtA -d "$target" -c "select 1 from pg_tables where schemaname='public' and tablename='$t'" || true)"
    if [ "$there" != "1" ]; then note "$t: missing from '$target'"; continue; fi
    src_n="$(psql -qtA -d "$SOURCE_DB" -c "select count(*) from public.\"$t\"")"
    dst_n="$(psql -qtA -d "$target"    -c "select count(*) from public.\"$t\"")"
    src_o="$(psql -qtA -d "$SOURCE_DB" -c "select tableowner from pg_tables where schemaname='public' and tablename='$t'")"
    dst_o="$(psql -qtA -d "$target"    -c "select tableowner from pg_tables where schemaname='public' and tablename='$t'")"
    if [ "$src_n" != "$dst_n" ]; then
      note "$t: rows $src_n (source) != $dst_n (target)"
    elif [ "$src_o" != "$dst_o" ]; then
      note "$t: owner '$src_o' (source) != '$dst_o' (target) — the app role would hit permission denied after the flip"
    else
      printf '  ok %-42s %6s rows  owner=%s\n' "$t" "$src_n" "$dst_o"
    fi
  done <<< "$expected"

  # 6. 序列：必须都在，且 last_value 不低于源库
  #
  # 序列漏拷 / 归零的后果不是报错，而是**主键冲突**——新库从 1 开始发号，撞上已存在的行。
  # 只要求「不低于」而非「相等」：pg_dump 的 setval 取的是 dump 那一刻的值，源库之后若还在跑
  # 会继续前进；目标略低才是问题，略高无害。
  seqlist="$(psql -qtA -d "$SOURCE_DB" -c "
    select s.relname
      from pg_class s
      join pg_depend d on d.objid = s.oid and d.deptype = 'a'
      join pg_class t on t.oid = d.refobjid
     where s.relkind = 'S'
       and t.relname in ($(echo "$expected" | sed "s/^/'/;s/\$/'/" | paste -sd, -))
     order by 1")"
  while read -r seq; do
    [ -z "$seq" ] && continue
    dst_seq="$(psql -qtA -d "$target" -c "select 1 from pg_class where relkind='S' and relname='$seq'" || true)"
    if [ "$dst_seq" != "1" ]; then note "sequence $seq: missing from '$target'"; continue; fi
    src_v="$(psql -qtA -d "$SOURCE_DB" -c "select last_value from public.\"$seq\"")"
    dst_v="$(psql -qtA -d "$target"    -c "select last_value from public.\"$seq\"")"
    if [ "$dst_v" -lt "$src_v" ]; then
      note "sequence $seq: last_value $dst_v (target) < $src_v (source) — the next insert would collide with existing rows"
    else
      printf '  ok %-42s %6s last_value\n' "$seq" "$dst_v"
    fi
  done <<< "$seqlist"

  # 7. 触发器：属主表上的每个触发器都必须在目标库里存在
  #
  # `pg_dump --table` 带表也带表上的触发器，但**不带触发器调用的函数** —— 函数缺失时恢复会在
  # post-data 阶段炸，而那时表和数据都已灌完，看起来「拷过了」。这条检查把那种半完成状态钉死。
  while read -r trg; do
    [ -z "$trg" ] && continue
    tbl="${trg%%|*}"; nm="${trg##*|}"
    got="$(psql -qtA -d "$target" -c "
      select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where not t.tgisinternal and c.relname = '$tbl' and t.tgname = '$nm'" || true)"
    if [ "$got" != "1" ]; then
      note "trigger $nm on $tbl: missing from '$target' (a trigger function that --table does not carry?)"
    else
      printf '  ok %-42s trigger on %s\n' "$nm" "$tbl"
    fi
  done < <(psql -qtA -d "$SOURCE_DB" -F'|' -c "
    select c.relname || '|' || t.tgname
      from pg_trigger t join pg_class c on c.oid = t.tgrelid
     where not t.tgisinternal
       and c.relname in ($(echo "$expected" | sed "s/^/'/;s/\$/'/" | paste -sd, -))
     order by 1")

  # 4. 目标库里不该有跨 owner 外键
  cross="$(psql -qtA -d "$target" -c "
    select c.conrelid::regclass || ' -> ' || c.confrelid::regclass
      from pg_constraint c
      join pg_class r on r.oid = c.confrelid
     where c.contype = 'f'
       and r.relname not in (select tablename from pg_tables where schemaname='public')" || true)"
  [ -z "$cross" ] || note "target '$target' has dangling/cross-owner FKs: $(echo "$cross" | paste -sd'; ' -)"
done

echo
if [ "$problems" = "0" ]; then
  echo "ALL EQUIVALENT — every owner table present with identical row counts, no strays, no cross-owner FKs."
else
  echo "$problems difference(s) found — see DIFF lines above. DO NOT flip any AIDCP_PG_<OWNER>_URL yet."
  exit 1
fi
