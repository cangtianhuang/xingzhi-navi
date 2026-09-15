(function () {
  const META = window.NAVI_META;
  const MapU = window.NaviMap;
  const USER_KEY = "xingzhi-navi-users-v1";
  const NODE_KEY = "xingzhi-navi-nodes-v1";
  const OVERRIDE_KEY = "xingzhi-navi-overrides-v1";
  const LOG_KEY = "xingzhi-navi-log-v1";
  const TONES = ["rose", "sage", "sand", "lilac"];

  const state = {
    view: "home",
    userId: null,
    focusId: "root",
    selectedId: null,
    filter: "open",
    domain: "all",
    session: null,
    tick: null,
    clockTick: null,
    editor: null,
    users: [],
    extraNodes: {},
    overrides: {},
    log: {},
  };

  const $ = (s, el = document) => el.querySelector(s);

  function loadStore() {
    try {
      const users = JSON.parse(localStorage.getItem(USER_KEY) || "null");
      const extra = JSON.parse(localStorage.getItem(NODE_KEY) || "{}");
      const over = JSON.parse(localStorage.getItem(OVERRIDE_KEY) || "{}");
      const log = JSON.parse(localStorage.getItem(LOG_KEY) || "{}");
      state.users = Array.isArray(users) && users.length ? users : window.NAVI_SEED_USERS.map((u) => ({ ...u }));
      state.extraNodes = extra && typeof extra === "object" ? extra : {};
      state.overrides = over && typeof over === "object" ? over : {};
      state.log = log && typeof log === "object" ? log : {};
    } catch (e) {
      state.users = window.NAVI_SEED_USERS.map((u) => ({ ...u }));
      state.extraNodes = {};
      state.overrides = {};
      state.log = {};
    }
  }

  function saveStore() {
    try {
      localStorage.setItem(USER_KEY, JSON.stringify(state.users));
      localStorage.setItem(NODE_KEY, JSON.stringify(state.extraNodes));
      localStorage.setItem(OVERRIDE_KEY, JSON.stringify(state.overrides));
      localStorage.setItem(LOG_KEY, JSON.stringify(state.log));
    } catch (e) {}
  }

  function currentUser() {
    return state.users.find((u) => u.id === state.userId) || state.users[0];
  }

  // 每位成员的原始节点：已分叉的可编辑副本优先，其次只读常量包，最后空图模板
  function baseNodesFor(id) {
    if (state.extraNodes[id]) return state.extraNodes[id];
    if (window.NAVI_PACKS[id]) return window.NAVI_PACKS[id].nodes;
    const user = state.users.find((u) => u.id === id);
    return window.NAVI_EMPTY_NODES(user?.name || "新成员");
  }

  function overridesFor(id) {
    if (!state.overrides[id]) state.overrides[id] = {};
    return state.overrides[id];
  }

  // 把用户的改动叠加到原始节点上，得到当前真实节点（深拷贝 deps，避免误改常量包）
  function applyOverrides(id, nodes) {
    const ov = state.overrides[id] || {};
    return nodes.map((n) => {
      const merged = ov[n.id] ? { ...n, ...ov[n.id] } : { ...n };
      if (merged.deps) merged.deps = [...merged.deps];
      return merged;
    });
  }

  function currentNodes() {
    const id = state.userId;
    return applyOverrides(id, baseNodesFor(id));
  }

  // 首次结构化编辑时，把当前状态（含 override）固化成一份可编辑副本
  function ensureEditable(id) {
    if (!state.extraNodes[id]) {
      state.extraNodes[id] = applyOverrides(id, baseNodesFor(id));
      delete state.overrides[id];
    }
    return state.extraNodes[id];
  }

  function DATA() {
    return { user: currentUser() || { name: "" }, nodes: currentNodes() };
  }

  const effStatus = (node, nodes) => MapU.statusOf(node, nodes);

  // 把一个节点推进到新状态，并把依赖它的 waiting 节点自动放行
  function setStatus(id, status) {
    const ov = overridesFor(state.userId);
    ov[id] = { ...(ov[id] || {}), status, updatedAt: "刚刚" };
    if (status === "done") ov[id].progress = 1;
    reflowDeps();
    saveStore();
  }

  // deps 全部完成的 waiting 节点 → active（可以开始了），级联直到稳定
  function reflowDeps() {
    const ov = overridesFor(state.userId);
    for (let pass = 0; pass < 6; pass++) {
      const nodes = currentNodes();
      const map = MapU.byId(nodes);
      let changed = false;
      nodes.forEach((n) => {
        if (effStatus(n, nodes) !== "waiting") return;
        const deps = n.deps || [];
        if (!deps.length) return;
        const ready = deps.every((d) => {
          const dn = map.get(d);
          return dn && effStatus(dn, nodes) === "done";
        });
        if (ready) {
          ov[n.id] = { ...(ov[n.id] || {}), status: "active", updatedAt: "可以开始了" };
          changed = true;
        }
      });
      if (!changed) break;
    }
  }

  function logEntry(name, done) {
    const uid = state.userId;
    if (!state.log[uid]) state.log[uid] = [];
    const { clock } = nowParts();
    state.log[uid].unshift({ name, done: !!done, at: clock.split(" ").pop() });
    state.log[uid] = state.log[uid].slice(0, 12);
    saveStore();
  }

  function todayLog() {
    return state.log[state.userId] || [];
  }

  // —— 结构化编辑：新建 / 修改 / 删除节点 ——
  function setProgress(id, ratio) {
    const ov = overridesFor(state.userId);
    const p = Math.max(0, Math.min(1, ratio));
    ov[id] = { ...(ov[id] || {}), progress: p, updatedAt: "刚刚" };
    if (p >= 1) ov[id].status = "done";
    else if ((ov[id].status || "") === "done") ov[id].status = "active";
    reflowDeps();
    saveStore();
  }

  function newId(prefix) {
    return (prefix || "n") + "-" + Date.now().toString(36) + Math.floor(Math.random() * 1e3).toString(36);
  }

  function addNode(parentId, fields) {
    const nodes = ensureEditable(state.userId);
    const parent = nodes.find((n) => n.id === parentId);
    if (!parent) return null;
    const type = parent.type === "domain" ? "project" : "task";
    const node = {
      id: newId(type),
      parentId,
      name: fields.name || "新的一件事",
      type,
      domain: parent.domain || null,
      progress: 0,
      status: fields.status || "active",
      brief: fields.brief || "",
      nextAction: fields.nextAction || "",
      nextHint: fields.nextHint || "",
      estimateMin: fields.estimateMin || 0,
      deps: fields.deps || [],
      updatedAt: "刚刚",
    };
    nodes.push(node);
    reflowDeps();
    saveStore();
    return node;
  }

  function editNode(id, fields) {
    const nodes = ensureEditable(state.userId);
    const node = nodes.find((n) => n.id === id);
    if (!node) return;
    ["name", "brief", "nextAction", "nextHint"].forEach((k) => {
      if (fields[k] !== undefined) node[k] = fields[k];
    });
    if (fields.estimateMin !== undefined) node.estimateMin = fields.estimateMin;
    if (fields.status !== undefined) node.status = fields.status;
    if (fields.deps !== undefined) node.deps = fields.deps;
    node.updatedAt = "刚刚";
    // 编辑表单里的状态/进度是权威值，清掉可能盖在上面的快捷 override
    if (state.overrides[state.userId]) delete state.overrides[state.userId][id];
    reflowDeps();
    saveStore();
  }

  function deleteNode(id) {
    const nodes = ensureEditable(state.userId);
    const doomed = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      nodes.forEach((n) => {
        if (n.parentId && doomed.has(n.parentId) && !doomed.has(n.id)) {
          doomed.add(n.id);
          grew = true;
        }
      });
    }
    state.extraNodes[state.userId] = nodes.filter((n) => !doomed.has(n.id));
    // 清掉指向已删除节点的依赖
    state.extraNodes[state.userId].forEach((n) => {
      if (n.deps) n.deps = n.deps.filter((d) => !doomed.has(d));
    });
    reflowDeps();
    saveStore();
  }

  // 可作为依赖的候选：同一成员里除自己及自己子树之外的任务/项目
  function depCandidates(id) {
    const nodes = currentNodes();
    const sub = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      nodes.forEach((n) => {
        if (n.parentId && sub.has(n.parentId) && !sub.has(n.id)) {
          sub.add(n.id);
          grew = true;
        }
      });
    }
    return nodes.filter((n) => !sub.has(n.id) && (n.type === "task" || n.type === "project"));
  }

  function nowParts() {
    const d = new Date();
    const h = d.getHours();
    const greet = h < 5 ? "夜深了" : h < 11 ? "早上好" : h < 13 ? "中午好" : h < 18 ? "下午好" : h < 23 ? "晚上好" : "夜深了";
    const wk = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
    const p2 = (n) => String(n).padStart(2, "0");
    const clock = `${d.getMonth() + 1}月${d.getDate()}日${wk} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
    return { greet, clock };
  }

  function loopItems(nodes) {
    return nodes.filter((n) => n.type === "project").filter((n) => effStatus(n, nodes) !== "done");
  }

  function summaryOf(user) {
    const nodes = applyOverrides(user.id, baseNodesFor(user.id));
    const open = loopItems(nodes);
    const blocked = open.filter((n) => effStatus(n, nodes) === "blocked").length;
    return { open: open.length, blocked };
  }

  function initials(name) {
    return String(name || "成").slice(0, 1);
  }

  function renderHome() {
    const list = $("#user-list");
    list.innerHTML = "";
    state.users.forEach((u) => {
      const s = summaryOf(u);
      const li = document.createElement("li");
      li.innerHTML = `
        <button class="user-row" data-enter="${u.id}">
          <span class="avatar ${u.tone || "sand"}">${initials(u.name)}</span>
          <span class="user-meta">
            <b>${escapeXml(u.name)}</b>
            <span>${escapeXml(u.title || "没填角色")}${u.note ? " · " + escapeXml(u.note) : ""}</span>
          </span>
          <span class="user-side">
            <span class="user-flag">${s.blocked ? s.blocked + " 件卡住了" : s.open ? s.open + " 件还没做完" : "新成员"}</span>
          </span>
        </button>
        <button class="user-del" data-del="${u.id}" title="移除" aria-label="移除 ${u.name}">×</button>`;
      li.style.display = "grid";
      li.style.gridTemplateColumns = "1fr auto";
      li.style.alignItems = "center";
      li.style.gap = "6px";
      list.appendChild(li);
    });

    list.querySelectorAll("[data-enter]").forEach((btn) => {
      btn.addEventListener("click", () => enterUser(btn.getAttribute("data-enter")));
    });
    list.querySelectorAll("[data-del]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        removeUser(btn.getAttribute("data-del"));
      });
    });
  }

  function enterUser(id) {
    const user = state.users.find((u) => u.id === id);
    if (!user) return;
    state.userId = id;
    state.view = "app";
    state.domain = "all";
    state.focusId = "root";
    state.filter = "open";
    const nodes = currentNodes();
    const pick = topPick(nodes);
    const first = pick || nodes.find((n) => effStatus(n, nodes) === "blocked") || nodes.find((n) => n.type === "project") || nodes[0];
    state.selectedId = first ? first.id : "root";
    $("#view-home").classList.add("is-hidden");
    $("#view-app").classList.remove("is-hidden");
    startClock();
    renderApp();
  }

  function goHome() {
    state.view = "home";
    state.userId = null;
    closeFocus();
    stopClock();
    $("#view-app").classList.add("is-hidden");
    $("#view-home").classList.remove("is-hidden");
    renderHome();
  }

  function startClock() {
    stopClock();
    const el = $("#clock");
    if (el) el.textContent = nowParts().clock;
    state.clockTick = setInterval(() => {
      const c = $("#clock");
      if (c) c.textContent = nowParts().clock;
    }, 30000);
  }

  function stopClock() {
    if (state.clockTick) clearInterval(state.clockTick);
    state.clockTick = null;
  }

  function removeUser(id) {
    if (state.users.length <= 1) return;
    state.users = state.users.filter((u) => u.id !== id);
    delete state.extraNodes[id];
    saveStore();
    renderHome();
  }

  function addUser(name, title) {
    const id = "u-" + Date.now().toString(36);
    const user = {
      id,
      name,
      title: title || "没填角色",
      note: "刚加进来，状态图还是空的。",
      tone: TONES[state.users.length % TONES.length],
    };
    state.users.push(user);
    state.extraNodes[id] = window.NAVI_EMPTY_NODES(name);
    saveStore();
    renderHome();
  }

  function allNodes() {
    let nodes = DATA().nodes.map((n) => ({ ...n }));
    if (state.domain !== "all") {
      nodes = nodes.filter((n) => n.id === "root" || n.domain === state.domain || n.id === state.domain);
    }
    return nodes;
  }

  function domainStats(domainId) {
    const all = DATA().nodes;
    const nodes = all.filter((n) => n.domain === domainId);
    const items = nodes.filter((n) => n.type === "task" || n.type === "project");
    const blocked = items.filter((n) => effStatus(n, all) === "blocked").length;
    const open = items.filter((n) => effStatus(n, all) !== "done").length;
    return { blocked, open };
  }

  // 现在最该动手的一件事：卡住且有下一步 > 正在做 > 其它可做的；同级里挑最快能推进的
  function topPick(nodes) {
    const rank = { blocked: 0, active: 1, flowing: 2, waiting: 3, done: 9 };
    const actionable = nodes
      .filter((n) => n.type === "task" || n.type === "project")
      .filter((n) => n.nextAction && n.nextAction !== "暂时不用管" && n.nextAction !== "等访谈结束再动笔")
      .filter((n) => effStatus(n, nodes) !== "done" && effStatus(n, nodes) !== "waiting");
    if (!actionable.length) return null;
    actionable.sort((a, b) => {
      const ra = rank[effStatus(a, nodes)] ?? 5;
      const rb = rank[effStatus(b, nodes)] ?? 5;
      if (ra !== rb) return ra - rb;
      const ta = a.type === "task" ? 0 : 1;
      const tb = b.type === "task" ? 0 : 1;
      if (ta !== tb) return ta - tb;
      return (a.estimateMin || 999) - (b.estimateMin || 999);
    });
    return actionable[0];
  }

  function renderHero() {
    const { greet, clock } = nowParts();
    const data = DATA();
    const open = loopItems(data.nodes);
    const blocked = open.filter((n) => effStatus(n, data.nodes) === "blocked");
    $("#clock").textContent = clock;
    $("#greet-title").textContent = `${greet}，${data.user.name}`;
    const doneCount = todayLog().filter((e) => e.done).length;
    const doneLine = doneCount ? `　今天已经做完 <em>${doneCount}</em> 件。` : "";
    $("#greet-sub").innerHTML =
      open.length === 0
        ? "状态图还是空的。先写一件最近想做完的事吧。"
        : `现在有 <em>${open.length}</em> 件事还没做完，其中 <em>${blocked.length}</em> 件卡住了。${doneLine}`;

    renderNowPick(data.nodes);

    const box = $("#domains");
    box.innerHTML = "";
    META.domains.forEach((d) => {
      const s = domainStats(d.id);
      const btn = document.createElement("button");
      btn.className = "domain-card" + (state.domain === d.id ? " is-on" : "");
      btn.innerHTML = `<span class="name">${d.name}</span>${s.blocked ? '<span class="dot"></span>' : ""}`;
      btn.title = s.blocked ? `${d.name} · ${s.blocked} 件卡住了` : d.kicker;
      btn.addEventListener("click", () => {
        state.domain = state.domain === d.id ? "all" : d.id;
        state.focusId = state.domain === "all" ? "root" : d.id;
        const first = data.nodes.find((n) => n.parentId === state.focusId);
        state.selectedId = first ? first.id : state.focusId;
        renderApp();
      });
      box.appendChild(btn);
    });
  }

  // 首屏「现在最该做的一件事」——一进来就给到建议 + 直接开始
  function renderNowPick(nodes) {
    let box = $("#now-pick");
    if (!box) {
      box = document.createElement("div");
      box.id = "now-pick";
      $(".hero").appendChild(box);
    }
    const pick = topPick(nodes);
    if (!pick) {
      box.className = "now-pick is-empty";
      box.innerHTML = `<span class="np-kicker">现在最该做的一件事</span><p class="np-empty">手上没有待办了，喘口气。</p>`;
      return;
    }
    const st = effStatus(pick, nodes);
    box.className = "now-pick" + (st === "blocked" ? " is-blocked" : "");
    box.innerHTML = `
      <span class="np-kicker">现在最该做的一件事 · <b>${escapeXml(pick.name)}</b> · ${META.statusLabel[st] || ""}</span>
      <h2>${escapeXml(pick.nextAction)}</h2>
      <div class="np-row">
        <span class="np-eta">${pick.estimateMin ? "大约 " + pick.estimateMin + " 分钟" : "看情况"}</span>
        <span class="np-actions">
          <button class="np-go" data-go>开始做</button>
          <button class="np-open" data-open>去看看</button>
        </span>
      </div>`;
    box.querySelector("[data-go]").addEventListener("click", () => openFocus(pick));
    box.querySelector("[data-open]").addEventListener("click", () => {
      state.selectedId = pick.id;
      if (pick.parentId) state.focusId = pick.parentId === "root" ? "root" : pick.parentId;
      renderApp();
    });
  }

  function ancestors(id) {
    const map = MapU.byId(DATA().nodes);
    const chain = [];
    let cur = map.get(id);
    while (cur) {
      chain.unshift(cur);
      cur = cur.parentId ? map.get(cur.parentId) : null;
    }
    return chain;
  }

  function renderCrumbs() {
    const el = $("#crumbs");
    const chain = ancestors(state.focusId);
    el.innerHTML = chain
      .map((n, i) => {
        const name = n.id === "root" ? "全部" : n.name;
        if (i === chain.length - 1) return `<span>${name}</span>`;
        return `<button data-id="${n.id}">${name}</button><span>/</span>`;
      })
      .join("");
    el.querySelectorAll("button").forEach((b) => {
      b.addEventListener("click", () => {
        state.focusId = b.dataset.id;
        renderMap();
      });
    });
  }

  function renderMap() {
    renderCrumbs();
    const nodesAll = DATA().nodes;
    const vis = MapU.visibleNodes(allNodes(), state.focusId, state.filter);
    const rootId = vis.some((n) => n.id === state.focusId) ? state.focusId : vis[0]?.id || "root";
    const { positions, width, height } = MapU.layout(vis, rootId);
    const svg = $("#map-svg");
    const map = MapU.byId(vis);
    const sel = map.get(state.selectedId) || map.get(rootId);
    if (sel) state.selectedId = sel.id;

    let links = "";
    vis.forEach((n) => {
      if (!n.parentId || !positions.has(n.parentId) || !positions.has(n.id)) return;
      const hi = n.id === state.selectedId || n.parentId === state.selectedId;
      links += `<path class="link${hi ? " is-hi" : ""}" d="${MapU.pathTo(positions.get(n.parentId), positions.get(n.id))}" />`;
    });
    vis.forEach((n) => {
      (n.deps || []).forEach((depId) => {
        if (!positions.has(depId) || !positions.has(n.id)) return;
        links += `<path class="link is-dep" d="${MapU.pathTo(positions.get(depId), positions.get(n.id))}" />`;
      });
    });

    let cards = "";
    vis.forEach((n) => {
      const p = positions.get(n.id);
      if (!p) return;
      const st = MapU.statusOf(n, nodesAll);
      const pr = MapU.progressOf(n, nodesAll);
      const label = n.type === "root" ? "总览" : META.statusLabel[st] || "";
      cards += `
        <g class="node-card${state.selectedId === n.id ? " is-sel" : ""}${st === "blocked" ? " is-blocked" : ""}${st === "done" ? " is-done" : ""}"
           data-id="${n.id}" tabindex="0" transform="translate(${p.x}, ${p.y})">
          <rect class="plate" rx="12" width="${p.w}" height="${p.h}" />
          <circle cx="16" cy="29" r="4.5" fill="${colorOf(st)}" />
          <text class="node-title" x="28" y="25">${escapeXml(n.name)}</text>
          <text class="node-sub" x="28" y="42">${label} · ${Math.round(pr * 100)}%</text>
        </g>`;
    });

    svg.setAttribute("viewBox", `0 0 ${Math.max(width, 640)} ${Math.max(height, 360)}`);
    svg.setAttribute("preserveAspectRatio", "xMinYMin meet");
    svg.innerHTML = `<g class="links">${links}</g><g class="nodes">${cards}</g>`;
    svg.querySelectorAll(".node-card").forEach((g) => {
      g.addEventListener("click", () => {
        const id = g.getAttribute("data-id");
        const node = MapU.byId(nodesAll).get(id);
        if (state.selectedId === id && node && (node.type === "domain" || node.type === "project")) {
          state.focusId = id;
        }
        state.selectedId = id;
        renderMap();
        renderDetail();
      });
    });
  }

  function colorOf(st) {
    return { blocked: "#c98972", active: "#7d8ea3", flowing: "#7d9a8a", waiting: "#9a8aa8", done: "#b5c1b8" }[st] || "#b5aea6";
  }

  function escapeXml(s) {
    return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function renderDetail() {
    const nodesAll = DATA().nodes;
    const node = MapU.byId(nodesAll).get(state.selectedId);
    const el = $("#detail-body");
    if (!node) {
      el.innerHTML = `<p class="empty">点一下图上任意一张卡片，看它的详情。</p>`;
      return;
    }
    const st = MapU.statusOf(node, nodesAll);
    const pr = MapU.progressOf(node, nodesAll);
    const typeLabel = { root: "总览", domain: "领域", project: "项目", task: "具体的事" }[node.type] || "";
    const deps = (node.deps || []).map((id) => MapU.byId(nodesAll).get(id)).filter(Boolean);
    const blockers = node.blockedReason;
    const isLeaf = MapU.childrenOf(nodesAll, node.id).length === 0;
    const canSet = isLeaf && (node.type === "task" || node.type === "project");
    const canStart = st !== "done" && node.nextAction && node.nextAction !== "暂时不用管";
    const setRow = canSet
      ? `<div class="set-status" role="group" aria-label="改状态">
           ${["blocked", "active", "done"]
             .map((s) => `<button class="ss ${s}${st === s ? " is-on" : ""}" data-set="${s}">${META.statusLabel[s]}</button>`)
             .join("")}
         </div>`
      : "";

    const canEdit = node.type === "task" || node.type === "project";
    const canAddChild = node.type === "domain" || node.type === "project";
    const addLabel = node.type === "domain" ? "新建项目" : "新建子任务";
    const progControl = canSet
      ? `<input type="range" class="prog-range" min="0" max="100" value="${Math.round(pr * 100)}" data-prog aria-label="进度" />`
      : "";
    const tools = `
      <div class="detail-tools">
        ${canAddChild ? `<button class="tool" data-add>＋ ${addLabel}</button>` : ""}
        ${canEdit ? `<button class="tool" data-edit>编辑</button>` : ""}
        ${canEdit ? `<button class="tool danger" data-del>删除</button>` : ""}
      </div>`;

    el.innerHTML = `
      <div class="detail-kicker">${typeLabel}${node.domain ? " · " + domainName(node.domain) : ""} · ${node.updatedAt || "—"}</div>
      <h3>${escapeXml(node.name)}</h3>
      <span class="badge ${st}">${META.statusLabel[st] || "—"}</span>
      <div class="progress-row">
        <div class="meta"><b>${Math.round(pr * 100)}%</b> <span>现在的进度</span></div>
      </div>
      ${progControl}
      ${setRow}
      <div class="suggest">
        <div class="ai-tag">下一步</div>
        <h5>${escapeXml(node.nextAction || "先点开下面卡住的那一项")}</h5>
        <div class="eta">${node.estimateMin ? "大约要 " + node.estimateMin + " 分钟" : "具体多久，看是哪件事"}</div>
        ${node.nextHint ? `<p class="hint">${escapeXml(node.nextHint)}</p>` : ""}
        <button class="cta" id="btn-start" ${canStart ? "" : "disabled"}>${canStart ? "开始做" : "暂时不用做"}</button>
        ${node.type !== "task" && node.type !== "root" ? `<button class="cta ghost" id="btn-drill">看看里面有什么</button>` : ""}
      </div>
      <div class="block">
        <h4>现在怎么样</h4>
        <p>${escapeXml(node.brief || "这里用来看整体情况。")}</p>
      </div>
      <div class="block">
        <h4>卡在哪里</h4>
        <p>${blockers ? escapeXml(blockers) : st === "waiting" ? "它本身没问题，只是前面的事还没做完。" : "没有卡住的地方。"}</p>
      </div>
      <div class="block">
        <h4>在等什么</h4>
        ${
          deps.length
            ? deps
                .map((d) => {
                  const ds = MapU.statusOf(d, nodesAll);
                  return `<div class="dep-item" data-id="${d.id}"><span class="dn">${escapeXml(d.name)}</span><span class="ds">${META.statusLabel[ds]}</span></div>`;
                })
                .join("")
            : `<p class="empty">不依赖别的节点。</p>`
        }
      </div>
      ${tools}
    `;

    el.querySelectorAll(".dep-item").forEach((row) => {
      row.addEventListener("click", () => {
        state.selectedId = row.dataset.id;
        const target = MapU.byId(nodesAll).get(state.selectedId);
        if (target?.parentId) state.focusId = target.parentId === "root" ? "root" : target.parentId;
        renderMap();
        renderDetail();
      });
    });
    const start = $("#btn-start", el);
    if (start && canStart) start.addEventListener("click", () => openFocus(node));
    const drill = $("#btn-drill", el);
    if (drill) {
      drill.addEventListener("click", () => {
        state.focusId = node.id;
        renderMap();
      });
    }
    el.querySelectorAll("[data-set]").forEach((b) => {
      b.addEventListener("click", () => {
        const to = b.dataset.set;
        setStatus(node.id, effStatus(node, nodesAll) === to ? "active" : to);
        renderApp();
      });
    });
    const range = $("[data-prog]", el);
    if (range) {
      range.addEventListener("input", () => {
        const m = $(".meta b", el);
        if (m) m.textContent = range.value + "%";
      });
      range.addEventListener("change", () => {
        setProgress(node.id, Number(range.value) / 100);
        renderApp();
      });
    }
    const addBtn = $("[data-add]", el);
    if (addBtn) addBtn.addEventListener("click", () => openEditor("add", node.id));
    const editBtn = $("[data-edit]", el);
    if (editBtn) editBtn.addEventListener("click", () => openEditor("edit", node.id));
    const delBtn = $("[data-del]", el);
    if (delBtn)
      delBtn.addEventListener("click", () => {
        if (!confirm(`删除「${node.name}」？它下面的内容也会一起删掉。`)) return;
        const parentId = node.parentId;
        deleteNode(node.id);
        const left = currentNodes();
        state.selectedId = (MapU.byId(left).get(parentId) ? parentId : left.find((n) => n.type !== "root")?.id) || "root";
        renderApp();
      });
  }

  function domainName(id) {
    return META.domains.find((d) => d.id === id)?.name || "";
  }

  function openFocus(node) {
    const mins = node.estimateMin || 25;
    state.session = { left: mins * 60, nodeId: node.id, name: node.name };
    $("#focus-title").textContent = node.nextAction;
    $("#focus-desc").textContent = node.nextHint || node.brief || "";
    $("#overlay").classList.add("is-on");
    tickTimer();
    if (state.tick) clearInterval(state.tick);
    state.tick = setInterval(tickTimer, 1000);
  }

  function tickTimer() {
    if (!state.session) return;
    const s = state.session.left;
    $("#timer").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    if (s <= 0) {
      clearInterval(state.tick);
      $("#focus-desc").textContent = "时间到，这件事做完了吗？做完就点「做完了」，让后面的事跟着动起来。";
      return;
    }
    state.session.left -= 1;
  }

  // done=true：这件事做完 → 推进为已完成，触发依赖重排；否则只记一笔暂停
  function finishFocus(done) {
    const sess = state.session;
    if (sess) {
      logEntry(sess.name || "一件事", done);
      // 只有叶子节点直接置完成；容器节点的状态由子节点派生，标完成没意义
      const isLeaf = MapU.childrenOf(currentNodes(), sess.nodeId).length === 0;
      if (done && isLeaf) setStatus(sess.nodeId, "done");
    }
    closeFocus();
    if (state.view === "app") renderApp();
  }

  function closeFocus() {
    $("#overlay").classList.remove("is-on");
    if (state.tick) clearInterval(state.tick);
    state.session = null;
  }

  function renderApp() {
    renderHero();
    renderMap();
    renderDetail();
  }

  // —— 编辑弹窗 ——
  function openEditor(mode, targetId) {
    state.editor = { mode, targetId };
    const form = $("#edit-form");
    form.reset();
    const nodes = currentNodes();
    const isAdd = mode === "add";
    const node = isAdd ? null : MapU.byId(nodes).get(targetId);
    const parent = isAdd ? MapU.byId(nodes).get(targetId) : null;
    if (isAdd && !parent) return;
    const childType = parent && parent.type === "domain" ? "项目" : "一件事";
    $("#edit-kicker").textContent = isAdd ? `在「${parent.name}」下新建` : "编辑";
    $("#edit-title").textContent = isAdd ? `新建${childType}` : `编辑：${node.name}`;
    form.name.value = isAdd ? "" : node.name || "";
    form.nextAction.value = isAdd ? "" : node.nextAction || "";
    form.nextHint.value = isAdd ? "" : node.nextHint || "";
    form.brief.value = isAdd ? "" : node.brief || "";
    form.estimateMin.value = isAdd ? "" : node.estimateMin || "";
    form.status.value = isAdd ? "active" : effStatus(node, nodes);

    // 依赖选择：只有叶子（任务/新建项）才谈得上等别的事
    const forId = isAdd ? "__new__" : targetId;
    const isLeaf = isAdd || MapU.childrenOf(nodes, targetId).length === 0;
    const wrap = $("#edit-deps-wrap");
    const box = $("#edit-deps");
    if (isLeaf) {
      wrap.style.display = "";
      const cur = new Set(isAdd ? [] : node.deps || []);
      const cands = isAdd ? depCandidates("__none__") : depCandidates(targetId);
      box.innerHTML = cands.length
        ? cands
            .map(
              (c) =>
                `<label class="dep-opt"><input type="checkbox" value="${c.id}" ${cur.has(c.id) ? "checked" : ""}/> ${escapeXml(c.name)}</label>`
            )
            .join("")
        : `<span class="empty">还没有别的事可依赖。</span>`;
    } else {
      wrap.style.display = "none";
      box.innerHTML = "";
    }
    $("#edit-overlay").classList.add("is-on");
    form.name.focus();
  }

  function closeEditor() {
    $("#edit-overlay").classList.remove("is-on");
    state.editor = null;
  }

  function submitEditor(e) {
    e.preventDefault();
    if (!state.editor) return;
    const form = $("#edit-form");
    const deps = Array.from($("#edit-deps").querySelectorAll("input:checked")).map((i) => i.value);
    const fields = {
      name: form.name.value.trim() || "未命名",
      nextAction: form.nextAction.value.trim(),
      nextHint: form.nextHint.value.trim(),
      brief: form.brief.value.trim(),
      estimateMin: Number(form.estimateMin.value) || 0,
      status: form.status.value,
      deps,
    };
    if (state.editor.mode === "add") {
      const created = addNode(state.editor.targetId, fields);
      if (created) state.selectedId = created.id;
    } else {
      editNode(state.editor.targetId, fields);
    }
    closeEditor();
    renderApp();
  }

  function bind() {
    document.querySelectorAll("[data-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.filter = btn.dataset.filter;
        document.querySelectorAll("[data-filter]").forEach((b) => b.classList.toggle("is-on", b === btn));
        renderMap();
      });
    });
    $("#btn-done").addEventListener("click", () => finishFocus(true));
    $("#btn-stop").addEventListener("click", () => finishFocus(false));
    $("#overlay").addEventListener("click", (e) => {
      if (e.target.id === "overlay") finishFocus(false);
    });
    $("#btn-home").addEventListener("click", goHome);
    $("#edit-form").addEventListener("submit", submitEditor);
    $("#edit-cancel").addEventListener("click", closeEditor);
    $("#edit-overlay").addEventListener("click", (e) => {
      if (e.target.id === "edit-overlay") closeEditor();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if ($("#edit-overlay").classList.contains("is-on")) closeEditor();
        else if ($("#overlay").classList.contains("is-on")) finishFocus(false);
      }
    });
    $("#user-add").addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const name = String(fd.get("name") || "").trim();
      const title = String(fd.get("title") || "").trim();
      if (!name) return;
      addUser(name, title);
      e.target.reset();
    });
  }

  loadStore();
  bind();
  renderHome();
})();
