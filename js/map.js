/**
 * 状态地图：分层树布局 + SVG 绘制
 */
(function () {
  const W_NODE = 176;
  const H_NODE = 58;
  const GAP_X = 88;
  const GAP_Y = 26;

  function byId(nodes) {
    const m = new Map();
    nodes.forEach((n) => m.set(n.id, n));
    return m;
  }

  function childrenOf(nodes, id) {
    return nodes.filter((n) => n.parentId === id);
  }

  function visibleNodes(nodes, focusId, filter) {
    const map = byId(nodes);
    const allowed = new Set();

    function includeSubtree(id) {
      allowed.add(id);
      childrenOf(nodes, id).forEach((c) => includeSubtree(c.id));
    }

    const start = focusId && map.has(focusId) ? focusId : "root";
    includeSubtree(start);
    if (start === "root") allowed.delete("root");

    return nodes.filter((n) => {
      if (!allowed.has(n.id)) return false;
      if (n.type === "root") return false;
      if (filter === "blocked") {
        return statusOf(n, nodes) === "blocked" || hasDesc(nodes, n.id, (x) => statusOf(x, nodes) === "blocked");
      }
      if (filter === "open") {
        return (
          n.type === "domain" ||
          statusOf(n, nodes) !== "done" ||
          hasDesc(nodes, n.id, (x) => statusOf(x, nodes) !== "done")
        );
      }
      return true;
    });
  }

  function hasDesc(nodes, id, pred) {
    const kids = childrenOf(nodes, id);
    return kids.some((k) => pred(k) || hasDesc(nodes, k.id, pred));
  }

  function rootsOf(nodes, preferId) {
    const ids = new Set(nodes.map((n) => n.id));
    const roots = nodes.filter((n) => !n.parentId || !ids.has(n.parentId));
    if (!roots.length) return nodes.slice(0, 1);
    if (preferId && roots.some((r) => r.id === preferId)) {
      return [roots.find((r) => r.id === preferId), ...roots.filter((r) => r.id !== preferId)];
    }
    return roots;
  }

  function layout(nodes, rootId) {
    const positions = new Map();

    function measure(id) {
      const kids = childrenOf(nodes, id);
      if (!kids.length) return H_NODE;
      let h = 0;
      kids.forEach((k, i) => {
        h += measure(k.id);
        if (i < kids.length - 1) h += GAP_Y;
      });
      return Math.max(H_NODE, h);
    }

    function place(id, x, y, height) {
      const kids = childrenOf(nodes, id);
      positions.set(id, { x, y: y + height / 2 - H_NODE / 2, w: W_NODE, h: H_NODE });
      if (!kids.length) return;
      let cursor = y;
      kids.forEach((k) => {
        const kh = measure(k.id);
        place(k.id, x + W_NODE + GAP_X, cursor, kh);
        cursor += kh + GAP_Y;
      });
    }

    const roots = rootsOf(nodes, rootId);
    let cursor = 24;
    let maxW = 0;
    roots.forEach((r, i) => {
      const h = measure(r.id);
      place(r.id, 24, cursor, h);
      cursor += h + (i < roots.length - 1 ? 26 : 0);
      maxW = Math.max(maxW, depthWidth(nodes, r.id));
    });
    return { positions, width: 24 + maxW + 16, height: cursor + 36 };
  }

  function depthWidth(nodes, id) {
    const kids = childrenOf(nodes, id);
    if (!kids.length) return W_NODE + 28;
    return W_NODE + GAP_X + Math.max(...kids.map((k) => depthWidth(nodes, k.id)));
  }

  function pathTo(from, to) {
    const x1 = from.x + from.w;
    const y1 = from.y + from.h / 2;
    const x2 = to.x;
    const y2 = to.y + to.h / 2;
    const m = (x1 + x2) / 2;
    return `M ${x1} ${y1} C ${m} ${y1}, ${m} ${y2}, ${x2} ${y2}`;
  }

  // 有子节点的容器（领域 / 有拆解的项目）状态始终由子节点聚合，
  // 这样子节点一变，父级颜色与百分比立刻跟着变；叶子节点才用自身 status。
  function statusOf(node, nodes) {
    const kids = childrenOf(nodes, node.id).filter((k) => k.type !== "root");
    if (!kids.length) return node.status || "flowing";
    const ks = kids.map((k) => statusOf(k, nodes));
    if (ks.some((s) => s === "blocked")) return "blocked";
    if (ks.some((s) => s === "active")) return "active";
    if (ks.every((s) => s === "done")) return "done";
    if (ks.some((s) => s === "waiting")) return "waiting";
    return "flowing";
  }

  function progressOf(node, nodes) {
    const kids = childrenOf(nodes, node.id);
    if (!kids.length) return typeof node.progress === "number" ? node.progress : 0;
    const ps = kids.map((k) => progressOf(k, nodes));
    return ps.reduce((a, b) => a + b, 0) / ps.length;
  }

  window.NaviMap = {
    childrenOf,
    byId,
    visibleNodes,
    layout,
    pathTo,
    statusOf,
    progressOf,
    W_NODE,
    H_NODE,
  };
})();
