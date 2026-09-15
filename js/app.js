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
    undo: {},
    redo: {},
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
    pushUndo();
    const ov = overridesFor(state.userId);
    ov[id] = { ...(ov[id] || {}), status, updatedAt: "刚刚" };
    if (status === "done") ov[id].progress = 1;
    reflowDeps();
    saveStore();
  }

  // deps 全部完成的 waiting 叶子 → active（可以开始了）；依赖又回退则改回 waiting，级联直到稳定
  function reflowDeps() {
    const ov = overridesFor(state.userId);
    for (let pass = 0; pass < 6; pass++) {
      const nodes = currentNodes();
      const map = MapU.byId(nodes);
      let changed = false;
      nodes.forEach((n) => {
        const deps = n.deps || [];
        if (!deps.length) return;
        // 容器状态由子节点派生，给它写 override 无效，跳过
        if (MapU.childrenOf(nodes, n.id).length) return;
        const st = effStatus(n, nodes);
        const ready = deps.every((d) => {
          const dn = map.get(d);
          return dn && effStatus(dn, nodes) === "done";
        });
        if (st === "waiting" && ready) {
          ov[n.id] = { ...(ov[n.id] || {}), status: "active", updatedAt: "可以开始了" };
          changed = true;
        } else if (st === "active" && !ready && n.updatedAt === "可以开始了") {
          // 之前是自动放行的（updatedAt 标记），现在依赖又没完成了 → 退回「在等前面的事」
          ov[n.id] = { ...(ov[n.id] || {}), status: "waiting", updatedAt: "又要等前面的事了" };
          changed = true;
        }
      });
      if (!changed) break;
    }
  }

  function logEntry(name, done) {
    const uid = state.userId;
    if (!state.log[uid]) state.log[uid] = [];
    const { clock, day } = nowParts();
    state.log[uid].unshift({ name, done: !!done, at: clock.split(" ").pop(), day });
    state.log[uid] = state.log[uid].slice(0, 12);
    saveStore();
  }

  // 只返回「今天」的记录（老数据没有 day 字段，按今天算以兼容）
  function todayLog() {
    const { day } = nowParts();
    return (state.log[state.userId] || []).filter((e) => !e.day || e.day === day);
  }

  // —— 结构化编辑：新建 / 修改 / 删除节点 ——
  function setProgress(id, ratio) {
    pushUndo();
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
    pushUndo();
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
    pushUndo();
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
    pushUndo();
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

  // 计算某节点的整棵子树（含自身）id 集合
  function subtreeIds(nodes, id) {
    const set = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      nodes.forEach((n) => {
        if (n.parentId && set.has(n.parentId) && !set.has(n.id)) {
          set.add(n.id);
          grew = true;
        }
      });
    }
    return set;
  }

  // 拖拽目标是否合法：只在同层级语义内搬家，保持 领域>项目>具体的事 三层不变式
  // 项目只能挂到领域下，具体的事只能挂到项目下；领域本身不可拖动改父级
  function canReparent(node, parent, nodes) {
    if (!node || !parent || node.id === parent.id) return false;
    if (node.parentId === parent.id) return false;
    if (node.type === "project" && parent.type !== "domain") return false;
    if (node.type === "task" && parent.type !== "project") return false;
    if (node.type !== "project" && node.type !== "task") return false; // 领域/总览不参与
    if (subtreeIds(nodes, node.id).has(parent.id)) return false; // 不能挂进自己的子树（成环）
    return true;
  }

  // 拖拽改父级：把 id 挂到 newParentId 下（可撤销）
  function reparentNode(id, newParentId) {
    let nodes = currentNodes();
    const node = nodes.find((n) => n.id === id);
    const parent = nodes.find((n) => n.id === newParentId);
    if (!canReparent(node, parent, nodes)) return false;
    pushUndo();
    nodes = ensureEditable(state.userId);
    const nd = nodes.find((n) => n.id === id);
    const pt = nodes.find((n) => n.id === newParentId);
    const sub = subtreeIds(nodes, id);
    nd.parentId = newParentId;
    // 层级受 canReparent 约束，节点及其子树的 type 天然保持不变，只需把领域归属跟随新父级
    const newDomain = pt.domain || null;
    nodes.forEach((n) => {
      if (sub.has(n.id)) n.domain = newDomain;
    });
    nd.updatedAt = "刚刚";
    if (state.overrides[state.userId]) delete state.overrides[state.userId][id];
    reflowDeps();
    saveStore();
    return true;
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

  // —— 规则建议引擎：让「下一步」名副其实 ——
  // 节点自己填了下一步就用它；没填就按状态 / 依赖 / 子节点推断一条。
  const PLACEHOLDER_ACTIONS = ["暂时不用管", "等访谈结束再动笔", ""];

  function explicitAction(node) {
    return node && node.nextAction && !PLACEHOLDER_ACTIONS.includes(node.nextAction) ? node.nextAction : "";
  }

  function suggestFor(node, nodes) {
    if (!node) return { text: "先点开图上任意一张卡片。", canAct: false, derived: false };
    const st = effStatus(node, nodes);
    const explicit = explicitAction(node);
    if (st === "done") return { text: explicit || "已经做完了，不用再动。", canAct: false, derived: !explicit };

    const map = MapU.byId(nodes);
    const deps = (node.deps || []).map((d) => map.get(d)).filter(Boolean);
    const pendingDeps = deps.filter((d) => effStatus(d, nodes) !== "done");
    if (st === "waiting" && pendingDeps.length) {
      return {
        text: explicit || `先做完前面的：${pendingDeps.map((d) => d.name).join("、")}`,
        canAct: false,
        derived: !explicit,
        drillTo: pendingDeps[0].id,
      };
    }

    const kids = MapU.childrenOf(nodes, node.id).filter((k) => k.type !== "root");
    if (kids.length) {
      const rank = { blocked: 0, active: 1, flowing: 2, waiting: 3, done: 9 };
      const hot = [...kids].sort((a, b) => (rank[effStatus(a, nodes)] ?? 5) - (rank[effStatus(b, nodes)] ?? 5))[0];
      const sub = suggestFor(hot, nodes);
      return { text: explicit || `先推进「${hot.name}」：${sub.text}`, canAct: false, derived: !explicit, drillTo: hot.id };
    }

    if (st === "blocked") {
      const base = node.blockedReason ? `先拆掉卡点：${node.blockedReason}` : "想清楚是什么卡住了，写下能动的第一步。";
      return { text: explicit || base, canAct: true, derived: !explicit };
    }
    return { text: explicit || `花 ${node.estimateMin || 15} 分钟往前推一步。`, canAct: true, derived: !explicit };
  }

  // —— 撤销：每次改动前存一份该成员的快照 ——
  function snapshot() {
    const uid = state.userId;
    return JSON.stringify({ e: state.extraNodes[uid] || null, o: state.overrides[uid] || null });
  }

  function pushUndo() {
    const uid = state.userId;
    if (!uid) return;
    if (!state.undo[uid]) state.undo[uid] = [];
    state.undo[uid].push(snapshot());
    if (state.undo[uid].length > 40) state.undo[uid].shift();
    state.redo[uid] = []; // 新的改动会切断原来的重做链
  }

  function canUndo() {
    return !!(state.undo[state.userId] && state.undo[state.userId].length);
  }

  function canRedo() {
    return !!(state.redo[state.userId] && state.redo[state.userId].length);
  }

  // 把一份快照恢复成当前成员的状态
  function restore(snap) {
    const uid = state.userId;
    if (snap.e) state.extraNodes[uid] = snap.e;
    else delete state.extraNodes[uid];
    if (snap.o) state.overrides[uid] = snap.o;
    else delete state.overrides[uid];
    const nodes = currentNodes();
    if (!MapU.byId(nodes).get(state.selectedId)) {
      state.selectedId = nodes.find((n) => n.type !== "root")?.id || "root";
    }
    saveStore();
    renderApp();
  }

  function undo() {
    const uid = state.userId;
    if (!canUndo()) return;
    (state.redo[uid] = state.redo[uid] || []).push(snapshot());
    restore(JSON.parse(state.undo[uid].pop()));
  }

  function redo() {
    const uid = state.userId;
    if (!canRedo()) return;
    (state.undo[uid] = state.undo[uid] || []).push(snapshot());
    restore(JSON.parse(state.redo[uid].pop()));
  }

  function nowParts() {
    const d = new Date();
    const h = d.getHours();
    const greet = h < 5 ? "夜深了" : h < 11 ? "早上好" : h < 13 ? "中午好" : h < 18 ? "下午好" : h < 23 ? "晚上好" : "夜深了";
    const wk = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
    const p2 = (n) => String(n).padStart(2, "0");
    const day = `${d.getMonth() + 1}月${d.getDate()}日`;
    const clock = `${day}${wk} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
    return { greet, clock, day };
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
          <span class="avatar ${u.tone || "sand"}">${escapeXml(initials(u.name))}</span>
          <span class="user-meta">
            <b>${escapeXml(u.name)}</b>
            <span>${escapeXml(u.title || "没填角色")}${u.note ? " · " + escapeXml(u.note) : ""}</span>
          </span>
          <span class="user-side">
            <span class="user-flag">${s.blocked ? s.blocked + " 件卡住了" : s.open ? s.open + " 件还没做完" : "新成员"}</span>
          </span>
        </button>
        <button class="user-del" data-del="${u.id}" title="移除" aria-label="移除 ${escapeXml(u.name)}">×</button>`;
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
    if (state.users.length <= 1) {
      alert("至少保留一位成员。");
      return;
    }
    state.users = state.users.filter((u) => u.id !== id);
    // 连同该成员的所有本地数据一起清掉，避免残留孤儿数据
    delete state.extraNodes[id];
    delete state.overrides[id];
    delete state.log[id];
    delete state.undo[id];
    delete state.redo[id];
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

  // 现在最该动手的一件事：卡住 > 正在做 > 其它可做的；只挑真正能上手（叶子）的一件
  function topPick(nodes) {
    const rank = { blocked: 0, active: 1, flowing: 2, waiting: 3, done: 9 };
    const actionable = nodes
      .filter((n) => n.type === "task" || n.type === "project")
      .filter((n) => effStatus(n, nodes) !== "done" && effStatus(n, nodes) !== "waiting")
      .filter((n) => suggestFor(n, nodes).canAct);
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
    const sug = suggestFor(pick, nodes);
    box.className = "now-pick" + (st === "blocked" ? " is-blocked" : "");
    box.innerHTML = `
      <span class="np-kicker">现在最该做的一件事 · <b>${escapeXml(pick.name)}</b> · ${META.statusLabel[st] || ""}${sug.derived ? " · 据状态推断" : ""}</span>
      <h2>${escapeXml(sug.text)}</h2>
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
        const name = escapeXml(n.id === "root" ? "全部" : n.name);
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
      const aria = escapeXml(`${n.name}，${label}，进度 ${Math.round(pr * 100)}%`);
      cards += `
        <g class="node-card${state.selectedId === n.id ? " is-sel" : ""}${st === "blocked" ? " is-blocked" : ""}${st === "done" ? " is-done" : ""}"
           data-id="${n.id}" tabindex="0" role="button" aria-label="${aria}" transform="translate(${p.x}, ${p.y})">
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
      const id = g.getAttribute("data-id");
      bindNodeDrag(g, id, nodesAll);
    });
  }

  // 单击选中/下钻；按住拖动到另一张「领域 / 项目」卡片上则改父级
  function bindNodeDrag(g, id, nodesAll) {
    const THRESHOLD = 5;
    let startX = 0,
      startY = 0,
      moved = false,
      dropTarget = null;

    function onDown(e) {
      if (e.button !== undefined && e.button !== 0) return;
      startX = e.clientX;
      startY = e.clientY;
      moved = false;
      dropTarget = null;
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    }

    function highlight(el) {
      svg.querySelectorAll(".node-card.is-drop").forEach((n) => n.classList.remove("is-drop"));
      if (el) el.classList.add("is-drop");
    }

    function onMove(e) {
      if (!moved && Math.hypot(e.clientX - startX, e.clientY - startY) < THRESHOLD) return;
      if (!moved) {
        moved = true;
        g.classList.add("is-dragging");
      }
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const card = under && under.closest ? under.closest(".node-card") : null;
      const tid = card && card.getAttribute("data-id");
      let ok = null;
      if (tid && tid !== id) {
        const nodes = currentNodes();
        const nmap = MapU.byId(nodes);
        if (canReparent(nmap.get(id), nmap.get(tid), nodes)) ok = card;
      }
      dropTarget = ok ? tid : null;
      highlight(ok);
    }

    function onUp() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      g.classList.remove("is-dragging");
      highlight(null);
      if (moved) {
        if (dropTarget && reparentNode(id, dropTarget)) {
          state.selectedId = id;
          renderApp();
        }
        return;
      }
      // 没拖动 = 单击：选中，若再次点选容器则下钻
      const node = MapU.byId(nodesAll).get(id);
      if (state.selectedId === id && node && (node.type === "domain" || node.type === "project")) {
        state.focusId = id;
      }
      state.selectedId = id;
      renderMap();
      renderDetail();
    }

    g.addEventListener("pointerdown", onDown);
    // 键盘可达：Enter / 空格 = 选中并（对容器）下钻
    g.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      const node = MapU.byId(nodesAll).get(id);
      if (state.selectedId === id && node && (node.type === "domain" || node.type === "project")) {
        state.focusId = id;
      }
      state.selectedId = id;
      renderMap();
      renderDetail();
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
    const sug = suggestFor(node, nodesAll);
    const canStart = sug.canAct;
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
        <div class="ai-tag">下一步${sug.derived ? " · 据状态推断" : ""}</div>
        <h5>${escapeXml(sug.text)}</h5>
        <div class="eta">${node.estimateMin ? "大约要 " + node.estimateMin + " 分钟" : "具体多久，看是哪件事"}</div>
        ${node.nextHint ? `<p class="hint">${escapeXml(node.nextHint)}</p>` : ""}
        <button class="cta" id="btn-start" ${canStart || sug.drillTo ? "" : "disabled"}>${canStart ? "开始做" : sug.drillTo ? "去看看里面" : "暂时不用做"}</button>
        ${canEdit && NaviAI.isReady() ? `<button class="cta ghost" id="btn-ai-step">让 AI 想一步</button>` : ""}
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
    else if (start && sug.drillTo)
      start.addEventListener("click", () => {
        state.focusId = sug.drillTo;
        state.selectedId = sug.drillTo;
        renderMap();
        renderDetail();
      });
    const aiStep = $("#btn-ai-step", el);
    if (aiStep) aiStep.addEventListener("click", () => aiSuggest(node, aiStep));
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
    $("#focus-title").textContent = suggestFor(node, currentNodes()).text;
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

  // —— AI 设置弹窗（OneAPI / OpenAI 兼容） ——
  function openAI() {
    const c = NaviAI.getConfig();
    const form = $("#ai-form");
    form.baseUrl.value = c.baseUrl || "";
    form.baseUrl.placeholder = NaviAI.DEFAULT_URL;
    form.apiKey.value = c.apiKey || "";
    form.model.value = c.model || "";
    form.model.placeholder = NaviAI.DEFAULT_MODEL;
    $("#ai-overlay").classList.add("is-on");
  }

  function closeAI() {
    $("#ai-overlay").classList.remove("is-on");
  }

  function saveAI(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    NaviAI.setConfig({
      baseUrl: String(fd.get("baseUrl") || "").trim(),
      apiKey: String(fd.get("apiKey") || "").trim(),
      model: String(fd.get("model") || "").trim(),
    });
    closeAI();
    renderDetail(); // 配好之后，详情里会露出「让 AI 想一步」
  }

  function clearAI() {
    NaviAI.setConfig({});
    $("#ai-form").reset();
    closeAI();
    renderDetail();
  }

  // 让大模型给这个节点想一个「下一步」，成功后写回（可撤销）
  async function aiSuggest(node, btn) {
    if (!NaviAI.isReady()) return openAI();
    const nodes = currentNodes();
    const st = MapU.statusOf(node, nodes);
    const deps = (node.deps || [])
      .map((id) => MapU.byId(nodes).get(id))
      .filter(Boolean)
      .map((d) => `${d.name}（${META.statusLabel[MapU.statusOf(d, nodes)]}）`);
    const prompt =
      `事情：${node.name}\n` +
      `所属：${node.domain ? domainName(node.domain) : "—"}\n` +
      `当前状态：${META.statusLabel[st] || st}\n` +
      `现状：${node.brief || "（未填）"}\n` +
      (node.blockedReason ? `卡在：${node.blockedReason}\n` : "") +
      (deps.length ? `在等：${deps.join("、")}\n` : "") +
      `请给出现在最该做的一步。`;
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = "AI 想想…";
    try {
      const { action, hint } = await NaviAI.suggest(prompt);
      if (!action) throw new Error("没拿到有效建议");
      editNode(node.id, { nextAction: action, nextHint: hint || node.nextHint || "" });
      renderApp();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = old;
      alert("AI 生成失败：" + (err && err.message ? err.message : err));
    }
  }

  function renderApp() {
    renderHero();
    renderMap();
    renderDetail();
    const ub = $("#btn-undo");
    if (ub) ub.classList.toggle("is-hidden", !canUndo());
    const rb = $("#btn-redo");
    if (rb) rb.classList.toggle("is-hidden", !canRedo());
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
    $("#btn-undo").addEventListener("click", undo);
    $("#btn-redo").addEventListener("click", redo);
    $("#btn-ai").addEventListener("click", openAI);
    $("#ai-form").addEventListener("submit", saveAI);
    $("#ai-clear").addEventListener("click", clearAI);
    $("#ai-cancel").addEventListener("click", closeAI);
    $("#ai-overlay").addEventListener("click", (e) => {
      if (e.target.id === "ai-overlay") closeAI();
    });
    $("#edit-form").addEventListener("submit", submitEditor);
    $("#edit-cancel").addEventListener("click", closeEditor);
    $("#edit-overlay").addEventListener("click", (e) => {
      if (e.target.id === "edit-overlay") closeEditor();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if ($("#ai-overlay").classList.contains("is-on")) closeAI();
        else if ($("#edit-overlay").classList.contains("is-on")) closeEditor();
        else if ($("#overlay").classList.contains("is-on")) finishFocus(false);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && state.view === "app") {
        const overlayOpen =
          $("#edit-overlay").classList.contains("is-on") ||
          $("#overlay").classList.contains("is-on") ||
          $("#ai-overlay").classList.contains("is-on");
        if (overlayOpen) return;
        e.preventDefault();
        if (e.shiftKey) {
          if (canRedo()) redo();
        } else if (canUndo()) {
          undo();
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y" && state.view === "app") {
        const overlayOpen =
          $("#edit-overlay").classList.contains("is-on") ||
          $("#overlay").classList.contains("is-on") ||
          $("#ai-overlay").classList.contains("is-on");
        if (!overlayOpen && canRedo()) {
          e.preventDefault();
          redo();
        }
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
