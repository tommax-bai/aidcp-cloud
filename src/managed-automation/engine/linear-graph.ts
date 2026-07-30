/**
 * 引擎层（期1-5）：线性链推导（纯函数，编译器与 worker 共用）。
 *
 * 期1 只支持线性图：每个节点入度/出度 ≤1、恰好一个链头、无环、单链覆盖全部节点。
 * 违反任何一条都返回具名失败——绝不静默丢节点或猜一个顺序。
 */

interface DirectedEdge {
  from: string;
  to: string;
}

export type LinearChainResult =
  | { ok: true; order: string[] }
  | { ok: false; violation: LinearChainViolation; detail: string };

export type LinearChainViolation =
  | 'empty_graph'
  | 'duplicate_node_id'
  | 'edge_references_unknown_node'
  | 'node_has_multiple_outgoing_edges'
  | 'node_has_multiple_incoming_edges'
  | 'no_unique_entry_node'
  | 'graph_not_single_chain';

/**
 * 把 nodes+edges 解析为唯一线性顺序。edges 数必须等于 nodes 数 - 1
 * 且链从唯一入口走到底覆盖全部节点（既排断链，也排环与并行支）。
 */
export function resolveLinearChain(nodeIds: readonly string[], edges: readonly DirectedEdge[]): LinearChainResult {
  if (nodeIds.length === 0) {
    return { ok: false, violation: 'empty_graph', detail: '执行图没有任何节点' };
  }
  const nodes = new Set<string>();
  for (const id of nodeIds) {
    if (nodes.has(id)) {
      return { ok: false, violation: 'duplicate_node_id', detail: `节点 ID 重复：${id}` };
    }
    nodes.add(id);
  }
  const next = new Map<string, string>();
  const hasIncoming = new Set<string>();
  for (const edge of edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) {
      return {
        ok: false,
        violation: 'edge_references_unknown_node',
        detail: `边 ${edge.from}→${edge.to} 引用了不存在的节点`,
      };
    }
    if (next.has(edge.from)) {
      return { ok: false, violation: 'node_has_multiple_outgoing_edges', detail: `节点 ${edge.from} 有多条出边` };
    }
    if (hasIncoming.has(edge.to)) {
      return { ok: false, violation: 'node_has_multiple_incoming_edges', detail: `节点 ${edge.to} 有多条入边` };
    }
    next.set(edge.from, edge.to);
    hasIncoming.add(edge.to);
  }
  const heads = [...nodes].filter((id) => !hasIncoming.has(id));
  if (heads.length !== 1) {
    return {
      ok: false,
      violation: 'no_unique_entry_node',
      detail: `链头必须恰好一个，实际 ${heads.length} 个（${heads.join(', ') || '无——图含环'}）`,
    };
  }
  const order: string[] = [];
  let cursor: string | undefined = heads[0];
  while (cursor !== undefined && order.length <= nodes.size) {
    order.push(cursor);
    cursor = next.get(cursor);
  }
  if (order.length !== nodes.size) {
    return {
      ok: false,
      violation: 'graph_not_single_chain',
      detail: `从入口 ${heads[0]} 只能走到 ${order.length}/${nodes.size} 个节点（存在断链或环支）`,
    };
  }
  return { ok: true, order };
}
