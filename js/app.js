(function () {
  const META = window.NAVI_META;
  const MapU = window.NaviMap;
  const USER_KEY = "xingzhi-navi-users-v1";
  const NODE_KEY = "xingzhi-navi-nodes-v1";
  const OVERRIDE_KEY = "xingzhi-navi-overrides-v1";
  const LOG_KEY = "xingzhi-navi-log-v1";

  const state = {
    view: "welcome",
    userId: "u-lin",
    focusId: "root",
    selectedId: null,
    filter: "open",
    domain: "all",
    session: null,
    tick: null,
    clockTick: null,
    editor: null,
    treeOpen: false,
    unblockId: null,
    searchList: [],
    searchActive: 0,
    users: [],
    extraNodes: {},
    overrides: {},
    log: {},
    undo: {},
    redo: {},
  };

  const $ = (s, el = document) => el.querySelector(s);

  // 是否有任意弹窗打开（撤销/重做、快捷键需要避让）
  function anyOverlayOpen() {
    return ["#edit-overlay", "#overlay", "#ai-overlay", "#gen-overlay", "#unblock-overlay", "#search-overlay"].some((id) => {
      const el = document.querySelector(id);
      return el && el.classList.contains("is-on");
    });
  }

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

  // 把「今天 16:20 / 昨天 / 周一 / 上周五」这类相对时间反推成时间戳，
  // 用于给只有 updatedAt 文本、没有 updatedTs 的历史/种子数据回填，救活「好久没动的」。
  function tsFromUpdatedAt(s) {
    if (!s) return undefined;
    if (/刚刚|刚确认|可以开始|要等前面/.test(s)) return Date.now();
    const now = new Date();
    const tm = s.match(/(\d{1,2}):(\d{2})/);
    const hh = tm ? +tm[1] : 12;
    const mm = tm ? +tm[2] : 0;
    const d = new Date(now);
    d.setHours(hh, mm, 0, 0);
    if (s.includes("今天")) return d.getTime();
    if (s.includes("昨天")) {
      d.setDate(d.getDate() - 1);
      return d.getTime();
    }
    const wkMap = { 日: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
    const wm = s.match(/周([日一二三四五六])/);
    if (wm) {
      const target = wkMap[wm[1]];
      let diff = (now.getDay() - target + 7) % 7; // 距离本周该星期几过去了几天
      if (s.includes("上周")) diff += 7;
      d.setDate(d.getDate() - diff);
      return d.getTime();
    }
    return undefined;
  }

  // 把用户的改动叠加到原始节点上，得到当前真实节点（深拷贝 deps，避免误改常量包）
  function applyOverrides(id, nodes) {
    const ov = state.overrides[id] || {};
    return nodes.map((n) => {
      const merged = ov[n.id] ? { ...n, ...ov[n.id] } : { ...n };
      if (merged.deps) merged.deps = [...merged.deps];
      // 缺 updatedTs 的历史数据按 updatedAt 文本回填，让「好久没动的」能对老条目生效
      if (typeof merged.updatedTs !== "number") {
        const t = tsFromUpdatedAt(merged.updatedAt);
        if (typeof t === "number") merged.updatedTs = t;
      }
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
    ov[id] = { ...(ov[id] || {}), status, updatedAt: "刚刚", updatedTs: Date.now() };
    if (status === "done") ov[id].progress = 1;
    reflowDeps();
    saveStore();
  }

  // deps 全部完成的 waiting 叶子 → active（可以开始了）；依赖又回退则改回 waiting，级联直到稳定
  function reflowDeps() {
    const ov = overridesFor(state.userId);
    const freed = [];
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
          ov[n.id] = { ...(ov[n.id] || {}), status: "active", updatedAt: "可以开始了", updatedTs: Date.now() };
          freed.push(n.name);
          changed = true;
        } else if (st === "active" && !ready && n.updatedAt === "可以开始了") {
          // 之前是自动放行的（updatedAt 标记），现在依赖又没完成了 → 退回「在等前面的事」
          ov[n.id] = { ...(ov[n.id] || {}), status: "waiting", updatedAt: "又要等前面的事了" };
          changed = true;
        }
      });
      if (!changed) break;
    }
    _freed = freed;
  }
  let _freed = [];
  // 依赖放行反馈：一件事做完后，把「可以开始了」的下游用轻提示说出来
  function announceFreed() {
    if (_freed && _freed.length) {
      const names = _freed.slice(0, 3).map((n) => `《${n}》`).join("、");
      showToast(`${names} 可以开始了`);
    }
    _freed = [];
  }

  let _toastTimer = null;
  function showToast(text) {
    const el = $("#toast");
    if (!el || !text) return;
    el.textContent = text;
    el.classList.add("is-on");
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => el.classList.remove("is-on"), 2600);
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
    ov[id] = { ...(ov[id] || {}), progress: p, updatedAt: "刚刚", updatedTs: Date.now() };
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
      updatedTs: Date.now(),
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
    ["name", "brief", "nextAction", "nextHint", "blockedReason"].forEach((k) => {
      if (fields[k] !== undefined) node[k] = fields[k];
    });
    if (fields.estimateMin !== undefined) node.estimateMin = fields.estimateMin;
    if (fields.status !== undefined) node.status = fields.status;
    if (fields.deps !== undefined) node.deps = fields.deps;
    node.updatedAt = "刚刚";
    node.updatedTs = Date.now();
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
    nd.updatedTs = Date.now();
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
      const base = node.blockedReason ? `先想办法解开：${node.blockedReason}` : "想清楚是什么卡住了，写下能动的第一步。";
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
    const greet =
      h < 5 ? "夜深了" : h < 9 ? "早上好" : h < 12 ? "上午好" : h < 14 ? "中午好" : h < 18 ? "下午好" : h < 23 ? "晚上好" : "夜深了";
    const wk = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
    const p2 = (n) => String(n).padStart(2, "0");
    const day = `${d.getMonth() + 1}月${d.getDate()}日`;
    const clock = `${day}${wk} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
    return { greet, clock, day };
  }

  function loopItems(nodes) {
    return nodes.filter((n) => n.type === "project").filter((n) => effStatus(n, nodes) !== "done");
  }

  // 个人 OS：固定单一档案（林予），四个领域即多个方面，不再有成员名单
  function ensureSingleUser() {
    const seed = window.NAVI_SEED_USERS.find((u) => u.id === "u-lin") || window.NAVI_SEED_USERS[0];
    if (!state.users.find((u) => u.id === seed.id)) state.users = [{ ...seed }];
    state.userId = seed.id;
  }

  // 恢复到内置示例数据（林予）：清掉本机存的改动副本，回落到只读常量包
  // 用于修复早期版本残留的空/损坏本地数据，不必再去控制台跑 localStorage.clear()
  function resetToSample() {
    if (!confirm("恢复到内置示例（林予）？会清掉你在本机做过的改动。")) return;
    delete state.extraNodes[state.userId];
    if (state.overrides) delete state.overrides[state.userId];
    state.undo[state.userId] = [];
    state.redo[state.userId] = [];
    saveStore();
    boot();
    showToast("已恢复内置示例数据");
  }

  // 修复早期版本残留的空/损坏本地数据：正常数据一定含 root + 四个领域；
  // 若连一个领域节点都没有（或缺 root），说明本机存的是坏数据，自动回落到内置示例。
  function healIfBroken() {
    const nodes = currentNodes();
    const hasDomain = nodes.some((n) => n.type === "domain");
    const hasRoot = nodes.some((n) => n.type === "root");
    if (hasDomain && hasRoot) return false;
    delete state.extraNodes[state.userId];
    if (state.overrides) delete state.overrides[state.userId];
    state.undo[state.userId] = [];
    state.redo[state.userId] = [];
    saveStore();
    return true;
  }

  function boot() {
    ensureSingleUser();
    const healed = healIfBroken();
    state.view = "app";
    state.domain = "all";
    state.focusId = "root";
    state.filter = "open";
    state.treeOpen = false; // 每次进来先看「今天」的答案，不是整棵树
    const nodes = currentNodes();
    const pick = topPick(nodes);
    const first =
      pick || nodes.find((n) => effStatus(n, nodes) === "blocked") || nodes.find((n) => n.type === "project") || nodes[0];
    state.selectedId = first ? first.id : "root";
    startClock();
    renderApp();
    refreshRemindBtn();
    scheduleReminder();
    if (healed) {
      setTimeout(() => showToast("检测到本地数据异常，已自动恢复内置示例"), 700);
    } else {
      morningGreet();
    }
  }

  // 晨间第一屏：当天首次打开时，用一句问候把「最该做的一件」直接递到眼前
  function morningGreet() {
    const KEY = "xingzhi-navi-lastday-v1";
    const today = nowParts().day;
    let last = null;
    try {
      last = localStorage.getItem(KEY);
    } catch (e) {}
    if (last === today) return;
    try {
      localStorage.setItem(KEY, today);
    } catch (e) {}
    const pick = topPick(currentNodes());
    setTimeout(() => {
      showToast(pick ? `${nowParts().greet}，今天先看这件：《${pick.name}》` : `${nowParts().greet}，今天先看一眼状态`);
    }, 700);
  }

  // 可选的开工提醒（纯前端：页面开着时，每天 9:00 用系统通知提醒看一眼）
  const REMIND_KEY = "xingzhi-navi-remind-v1";
  let _remindTimer = null;
  function remindOn() {
    try {
      return JSON.parse(localStorage.getItem(REMIND_KEY) || "false") === true;
    } catch (e) {
      return false;
    }
  }
  function refreshRemindBtn() {
    const b = $("#btn-remind");
    if (b) b.classList.toggle("is-on", remindOn());
  }
  function scheduleReminder() {
    if (_remindTimer) {
      clearTimeout(_remindTimer);
      _remindTimer = null;
    }
    if (!remindOn() || !("Notification" in window) || Notification.permission !== "granted") return;
    const now = new Date();
    const next = new Date(now);
    next.setHours(9, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    _remindTimer = setTimeout(() => {
      const pick = topPick(currentNodes());
      try {
        new Notification("行知 Navi · 开工提醒", { body: pick ? `今天最该先动：${pick.name}` : "今天先看一眼状态吧" });
      } catch (e) {}
      scheduleReminder();
    }, next - now);
  }
  async function toggleRemind() {
    if (remindOn()) {
      try {
        localStorage.setItem(REMIND_KEY, "false");
      } catch (e) {}
      refreshRemindBtn();
      scheduleReminder();
      showToast("已关闭开工提醒");
      return;
    }
    if (!("Notification" in window)) {
      showToast("这个浏览器不支持提醒");
      return;
    }
    let perm = Notification.permission;
    if (perm === "default") perm = await Notification.requestPermission();
    if (perm !== "granted") {
      showToast("没拿到通知权限，没法提醒");
      return;
    }
    try {
      localStorage.setItem(REMIND_KEY, "true");
    } catch (e) {}
    refreshRemindBtn();
    scheduleReminder();
    showToast("好，页面开着时每天 9:00 提醒你看一眼");
  }

  let _lastDay = null;
  function startClock() {
    stopClock();
    const el = $("#clock");
    if (el) el.textContent = nowParts().clock;
    _lastDay = nowParts().day;
    state.clockTick = setInterval(() => {
      const np = nowParts();
      const c = $("#clock");
      if (c) c.textContent = np.clock;
      // 跨午夜：「今天」的计数、好久没动、晨间问候都要按新的一天重算
      if (np.day !== _lastDay) {
        _lastDay = np.day;
        renderApp();
        morningGreet();
      }
    }, 30000);
  }

  function stopClock() {
    if (state.clockTick) clearInterval(state.clockTick);
    state.clockTick = null;
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
    const doneLine = doneCount ? `今天已经做完 <em>${doneCount}</em> 件。` : "";
    // 立意：首屏先讲「卡在哪 / 下一步」，不报「还剩多少没做」这种待办计数
    const pick = topPick(data.nodes);
    // 区分「真的什么都没有」和「手上的事都做完了」——后者是好事，不能当空图诱导重建
    const hasContent = data.nodes.some((n) => n.type === "project" || n.type === "task");
    let lead;
    if (!hasContent) {
      lead =
        '状态图还是空的。点顶部「AI 建图」粘一段近况自动生成，或选一个领域点「＋ 新建项目」手动加。' +
        '<button class="link-btn" id="btn-reset-sample">恢复示例数据</button>';
    } else if (open.length === 0) {
      lead = "手上的事都清完了，喘口气。";
    } else if (blocked.length) {
      lead = `<em>${blocked.length}</em> 件卡住了，最该先解开《${escapeXml(blocked[0].name)}》。`;
    } else if (pick) {
      lead = `没有卡住的，顺着做《${escapeXml(pick.name)}》就好。`;
    } else {
      lead = "手上没有待办了，喘口气。";
    }
    $("#greet-sub").innerHTML = doneLine ? `${lead} <span class="sub-done">${doneLine}</span>` : lead;
    const resetBtn = $("#btn-reset-sample");
    if (resetBtn) resetBtn.addEventListener("click", resetToSample);

    renderNowPick(data.nodes);

    const box = $("#domains");
    box.innerHTML = "";
    META.domains.forEach((d) => {
      const s = domainStats(d.id);
      const btn = document.createElement("button");
      // 只有真的进到某个领域的树里，才高亮它；「今天」视图是跨领域的，不高亮任何一张
      btn.className = "domain-card" + (state.treeOpen && state.domain === d.id ? " is-on" : "");
      btn.innerHTML = `<span class="name">${d.name}</span>${s.blocked ? '<span class="dot"></span>' : ""}`;
      btn.title = s.blocked ? `${d.name} · ${s.blocked} 件卡住了` : d.kicker;
      btn.addEventListener("click", () => {
        state.domain = state.domain === d.id ? "all" : d.id;
        state.focusId = state.domain === "all" ? "root" : d.id;
        const first = data.nodes.find((n) => n.parentId === state.focusId);
        state.selectedId = first ? first.id : state.focusId;
        state.treeOpen = true;
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
      <span class="np-kicker">现在最该做的一件事 · <b>${escapeXml(pick.name)}</b> · ${META.statusLabel[st] || ""}${sug.derived ? " · 帮你想的" : ""}</span>
      <h2>${escapeXml(sug.text)}</h2>
      <div class="np-row">
        <span class="np-eta">${pick.estimateMin ? "大约 " + pick.estimateMin + " 分钟" : "看情况"}</span>
        <span class="np-actions">
          <button class="np-go" data-go>开始做</button>
          <button class="np-open" data-open>去看看</button>
        </span>
      </div>`;
    box.querySelector("[data-go]").addEventListener("click", () => openFocus(pick));
    box.querySelector("[data-open]").addEventListener("click", () => jumpToTree(pick.id));
  }

  // 答案视图：卡住的 + 今天能清掉的（首屏只回答两个问题，树是二级）
  function ansItemHTML(node, nodes, kind) {
    const sug = suggestFor(node, nodes);
    const desc = kind === "blocked" ? node.blockedReason || sug.text : sug.text;
    const eta = node.estimateMin ? ` · 约 ${node.estimateMin} 分钟` : "";
    const isLeaf = MapU.childrenOf(nodes, node.id).length === 0;
    return `<div class="ans-item is-${kind}" data-id="${node.id}">
        <div class="ans-main">
          <div class="ans-name">${escapeXml(node.name)}</div>
          <div class="ans-desc">${escapeXml(desc)}${eta}</div>
        </div>
        <div class="ans-actions">
          ${kind === "blocked" ? `<button class="np-go" data-unblock="${node.id}">解卡</button>` : ""}
          ${kind !== "blocked" && sug.canAct ? `<button class="np-go" data-go="${node.id}">开始做</button>` : ""}
          ${isLeaf ? `<button class="ans-done" data-done="${node.id}" title="标记做完">✓ 做完</button>` : ""}
          <button class="np-open" data-open="${node.id}">去看看</button>
        </div>
      </div>`;
  }

  const STALE_MS = 4 * 24 * 3600 * 1000;
  function agoText(ts) {
    const d = Math.floor((Date.now() - ts) / 86400000);
    return d <= 1 ? "1 天多没动" : `${d} 天没动`;
  }
  // 好久没动的叶子：有真实更新时间戳且超过阈值、还没做完
  function staleItems(nodes) {
    const now = Date.now();
    return nodes
      .filter(
        (n) =>
          n.type === "task" &&
          MapU.childrenOf(nodes, n.id).length === 0 &&
          effStatus(n, nodes) !== "done" &&
          typeof n.updatedTs === "number" &&
          now - n.updatedTs > STALE_MS
      )
      .sort((a, b) => a.updatedTs - b.updatedTs);
  }

  // 确认某条仍然有效：只刷新它的更新时间，不进撤销栈（不是一次真的改动）
  function confirmFresh(id) {
    const ov = overridesFor(state.userId);
    ov[id] = { ...(ov[id] || {}), updatedAt: "刚确认", updatedTs: Date.now() };
    saveStore();
    renderApp();
  }

  function renderAnswer(nodes) {
    // 卡点优先取叶子（更具体、能上手）；没有卡住的叶子则退回卡住的项目
    const blockedLeaves = nodes.filter(
      (n) =>
        (n.type === "task" || n.type === "project") &&
        MapU.childrenOf(nodes, n.id).length === 0 &&
        effStatus(n, nodes) === "blocked"
    );
    const blocked = blockedLeaves.length
      ? blockedLeaves
      : nodes.filter((n) => n.type === "project" && effStatus(n, nodes) === "blocked");
    const today = nodes.filter(
      (n) =>
        n.type === "task" &&
        effStatus(n, nodes) !== "done" &&
        effStatus(n, nodes) !== "waiting" &&
        n.estimateMin > 0 &&
        n.estimateMin <= 30 &&
        suggestFor(n, nodes).canAct
    );

    const bBox = $("#ans-blocked");
    bBox.innerHTML =
      `<div class="ans-h">卡住的${blocked.length ? ` · <b>${blocked.length}</b>` : ""}</div>` +
      (blocked.length
        ? blocked.slice(0, 6).map((n) => ansItemHTML(n, nodes, "blocked")).join("")
        : `<div class="ans-empty">现在没有卡住的，挺好。</div>`);

    const tBox = $("#ans-today");
    tBox.innerHTML =
      `<div class="ans-h">今天能清掉的${today.length ? ` · ${today.length}` : ""}</div>` +
      (today.length
        ? today.slice(0, 6).map((n) => ansItemHTML(n, nodes, "today")).join("")
        : `<div class="ans-empty">没有能今天顺手做完的小事。</div>`);

    // 好久没动的——只在真的出现时显示，一键确认或去更新
    const stale = staleItems(nodes);
    const sBox = $("#ans-stale");
    if (stale.length) {
      sBox.style.display = "";
      sBox.innerHTML =
        `<div class="ans-h">好久没动的 · 还准吗？</div>` +
        stale
          .slice(0, 5)
          .map(
            (n) => `<div class="ans-item is-stale" data-id="${n.id}">
              <div class="ans-main">
                <div class="ans-name">${escapeXml(n.name)}</div>
                <div class="ans-desc">${agoText(n.updatedTs)} · ${META.statusLabel[effStatus(n, nodes)] || ""}</div>
              </div>
              <div class="ans-actions">
                <button class="np-open" data-fresh="${n.id}">还准</button>
                <button class="np-open" data-open="${n.id}">更新一下</button>
              </div>
            </div>`
          )
          .join("");
    } else {
      sBox.style.display = "none";
      sBox.innerHTML = "";
    }

    [bBox, tBox, sBox].forEach((box) => {
      box.querySelectorAll("[data-unblock]").forEach((btn) =>
        btn.addEventListener("click", () => openUnblock(btn.getAttribute("data-unblock")))
      );
      box.querySelectorAll("[data-go]").forEach((btn) =>
        btn.addEventListener("click", () => {
          const node = MapU.byId(nodes).get(btn.getAttribute("data-go"));
          if (node) openFocus(node);
        })
      );
      box.querySelectorAll("[data-done]").forEach((btn) =>
        btn.addEventListener("click", () => {
          setStatus(btn.getAttribute("data-done"), "done");
          renderApp();
          announceFreed();
        })
      );
      box.querySelectorAll("[data-fresh]").forEach((btn) =>
        btn.addEventListener("click", () => confirmFresh(btn.getAttribute("data-fresh")))
      );
      box.querySelectorAll("[data-open]").forEach((btn) =>
        btn.addEventListener("click", () => jumpToTree(btn.getAttribute("data-open")))
      );
    });
  }

  // 切到状态树全貌并定位到某节点
  function jumpToTree(id) {
    const nodes = currentNodes();
    const node = MapU.byId(nodes).get(id);
    state.treeOpen = true;
    if (node) {
      state.selectedId = id;
      state.focusId = node.parentId && node.parentId !== "root" ? node.parentId : "root";
    }
    renderApp();
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
    const svg = $("#map-svg");
    // 当前范围/筛选下没有可显示的卡片时，给一句友好的空状态，而不是一片空白画布
    if (!vis.length) {
      svg.setAttribute("viewBox", "0 0 640 200");
      svg.removeAttribute("width");
      svg.removeAttribute("height");
      const msg =
        state.filter === "blocked"
          ? "这个范围里现在没有卡住的事，挺好。"
          : state.filter === "today"
          ? "这个范围里没有能今天顺手做完的小事。"
          : "这里还没有内容。点上方「全部」，或换个筛选看看。";
      svg.innerHTML = `<text x="24" y="44" class="map-empty-text">${escapeXml(msg)}</text>`;
      return;
    }
    const rootId = vis.some((n) => n.id === state.focusId) ? state.focusId : vis[0]?.id || "root";
    const { positions, width, height } = MapU.layout(vis, rootId);
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
          <circle cx="18" cy="29" r="7" fill="${colorOf(st)}" />
          <text class="node-glyph" x="18" y="29" text-anchor="middle" dominant-baseline="central">${escapeXml(glyphOf(st))}</text>
          <text class="node-title" x="33" y="25">${escapeXml(n.name)}</text>
          <text class="node-sub" x="33" y="42">${label} · ${Math.round(pr * 100)}%</text>
        </g>`;
    });

    const vbW = Math.max(width, 640);
    const vbH = Math.max(height, 360);
    svg.setAttribute("viewBox", `0 0 ${vbW} ${vbH}`);
    svg.setAttribute("preserveAspectRatio", "xMinYMin meet");
    // 给出自然像素尺寸：树大了就在面板内滚动（可读），而不是一味缩小挤成一团
    svg.setAttribute("width", vbW);
    svg.setAttribute("height", vbH);
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

  // 状态的形状/符号冗余：不只靠颜色区分，色盲用户也能一眼分辨
  function glyphOf(st) {
    return { blocked: "!", active: "▶", flowing: "~", waiting: "…", done: "✓" }[st] || "·";
  }

  // 容器节点的状态由哪个子项「决定」（按聚合优先级取最紧的一个），用于显性说明
  function drivingChild(node, nodes) {
    const kids = MapU.childrenOf(nodes, node.id).filter((k) => k.type !== "root");
    if (!kids.length) return null;
    const rank = { blocked: 0, active: 1, flowing: 2, waiting: 3, done: 9 };
    return [...kids].sort((a, b) => (rank[effStatus(a, nodes)] ?? 5) - (rank[effStatus(b, nodes)] ?? 5))[0];
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
    // 反向依赖：哪些事在等着「我」做完（我一完成，它们就被放行）
    const dependents = nodesAll.filter((n) => (n.deps || []).includes(node.id));
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
      <span class="badge ${st}"><span class="badge-glyph" aria-hidden="true">${escapeXml(glyphOf(st))}</span>${META.statusLabel[st] || "—"}</span>
      ${
        !isLeaf && drivingChild(node, nodesAll)
          ? `<span class="agg-note">这个状态由下面的《${escapeXml(drivingChild(node, nodesAll).name)}》决定</span>`
          : ""
      }
      <div class="progress-row">
        <div class="meta"><b>${Math.round(pr * 100)}%</b> <span>现在的进度</span></div>
      </div>
      ${progControl}
      ${setRow}
      <div class="suggest">
        <div class="ai-tag">下一步${sug.derived ? " · 帮你想的" : ""}</div>
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
        ${st === "blocked" && canEdit ? `<button class="tool" id="btn-unblock" style="margin-top:10px">解卡 · 拆成能动的一步</button>` : ""}
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
            : `<p class="empty">不用等别的事。</p>`
        }
      </div>
      ${
        dependents.length
          ? `<div class="block">
        <h4>完成后将放行</h4>
        ${dependents
          .map((d) => {
            const ds = MapU.statusOf(d, nodesAll);
            return `<div class="dep-item" data-id="${d.id}"><span class="dn">${escapeXml(d.name)}</span><span class="ds">${META.statusLabel[ds]}</span></div>`;
          })
          .join("")}
      </div>`
          : ""
      }
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
    const unblockBtn = $("#btn-unblock", el);
    if (unblockBtn) unblockBtn.addEventListener("click", () => openUnblock(node.id));
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
        announceFreed();
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
        announceFreed();
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
    let didDone = false;
    if (sess) {
      logEntry(sess.name || "一件事", done);
      // 只有叶子节点直接置完成；容器节点的状态由子节点派生，标完成没意义
      const isLeaf = MapU.childrenOf(currentNodes(), sess.nodeId).length === 0;
      if (done && isLeaf) {
        setStatus(sess.nodeId, "done");
        didDone = true;
      }
    }
    closeFocus();
    if (state.view === "app") renderApp();
    if (didDone) announceFreed();
  }

  function closeFocus() {
    $("#overlay").classList.remove("is-on");
    if (state.tick) clearInterval(state.tick);
    state.session = null;
  }

  // —— 快速搜索（Cmd/Ctrl+K）：按名称/现状找节点并跳过去 ——
  function openSearch() {
    if (state.view !== "app") return;
    state.searchList = [];
    state.searchActive = 0;
    $("#search-overlay").classList.add("is-on");
    const input = $("#search-input");
    input.value = "";
    renderSearchResults("");
    input.focus();
  }

  function closeSearch() {
    $("#search-overlay").classList.remove("is-on");
  }

  function nodePath(id) {
    return ancestors(id)
      .filter((n) => n.id !== "root" && n.id !== id)
      .map((n) => n.name)
      .join(" › ");
  }

  function renderSearchResults(q) {
    const nodes = currentNodes();
    const ql = String(q || "").trim().toLowerCase();
    let list = nodes.filter((n) => n.type !== "root");
    if (ql) {
      list = list.filter(
        (n) => (n.name || "").toLowerCase().includes(ql) || (n.brief || "").toLowerCase().includes(ql)
      );
    }
    list = list.slice(0, 40);
    state.searchList = list;
    if (state.searchActive >= list.length) state.searchActive = 0;
    const box = $("#search-results");
    if (!list.length) {
      box.innerHTML = `<li class="search-empty">没找到匹配的事项。</li>`;
      return;
    }
    box.innerHTML = list
      .map((n, i) => {
        const st = MapU.statusOf(n, nodes);
        const path = nodePath(n.id);
        return `<li class="${i === state.searchActive ? "is-active" : ""}" data-id="${n.id}" data-i="${i}">
          <span class="sr-glyph" style="background:${colorOf(st)}">${escapeXml(glyphOf(st))}</span>
          <span class="sr-name">${escapeXml(n.name)}</span>
          <span class="sr-path">${escapeXml(path || META.statusLabel[st] || "")}</span>
        </li>`;
      })
      .join("");
    box.querySelectorAll("li[data-id]").forEach((li) => {
      li.addEventListener("click", () => jumpTo(li.getAttribute("data-id")));
    });
  }

  function jumpTo(id) {
    const nodes = currentNodes();
    const node = MapU.byId(nodes).get(id);
    if (!node) return;
    state.selectedId = id;
    state.focusId = node.parentId && node.parentId !== "root" ? node.parentId : "root";
    state.treeOpen = true;
    closeSearch();
    renderApp();
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

  // —— AI 建图：把一段近况文字批量拆成节点 ——
  function openGen() {
    if (state.view !== "app") return;
    const form = $("#gen-form");
    form.reset();
    $("#gen-overlay").classList.add("is-on");
    form.text.focus();
  }

  function closeGen() {
    $("#gen-overlay").classList.remove("is-on");
  }

  // 把模型给的结构化条目落到当前成员的图上（一次改动一份撤销快照）
  function applyPlan(items) {
    const validDomains = META.domains.map((d) => d.id);
    const nodes = ensureEditable(state.userId);
    const ensureProject = (domId, name) => {
      let p = nodes.find((n) => n.parentId === domId && n.type === "project" && n.name === name);
      if (!p) {
        p = {
          id: newId("project"),
          parentId: domId,
          name: name.slice(0, 40),
          type: "project",
          domain: domId,
          progress: 0,
          status: "active",
          brief: "",
          nextAction: "",
          nextHint: "",
          estimateMin: 0,
          deps: [],
          updatedAt: "刚刚",
          updatedTs: Date.now(),
        };
        nodes.push(p);
      }
      return p;
    };
    let added = 0;
    let firstId = null;
    items.forEach((it) => {
      if (!it || typeof it !== "object") return;
      const domId = validDomains.includes(it.domain) ? it.domain : "work";
      if (!nodes.find((n) => n.id === domId)) return; // 领域节点必须存在
      const proj = ensureProject(domId, String(it.project || "新项目").trim() || "新项目");
      const taskName = String(it.task || "").trim();
      if (!taskName) return;
      if (nodes.find((n) => n.parentId === proj.id && n.name === taskName)) return; // 去重
      const node = {
        id: newId("task"),
        parentId: proj.id,
        name: taskName.slice(0, 40),
        type: "task",
        domain: domId,
        progress: 0,
        status: "active",
        brief: String(it.brief || "").slice(0, 160),
        nextAction: String(it.nextAction || "").slice(0, 60),
        nextHint: "",
        estimateMin: Number(it.estimateMin) || 0,
        deps: [],
        updatedAt: "刚刚",
        updatedTs: Date.now(),
      };
      nodes.push(node);
      if (!firstId) firstId = node.id;
      added += 1;
    });
    return { added, firstId };
  }

  async function runGen(e) {
    e.preventDefault();
    if (!NaviAI.isReady()) {
      closeGen();
      return openAI();
    }
    const btn = $("#gen-run");
    const text = $("#gen-form").text.value.trim();
    if (!text) return;
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = "AI 梳理中…";
    try {
      const items = await NaviAI.plan(text);
      if (!items.length) throw new Error("没能从这段文字里拆出条目，换个说法再试试");
      pushUndo();
      const { added, firstId } = applyPlan(items);
      if (!added) {
        // 没有实际新增，撤销刚压入的空快照
        if (state.undo[state.userId]) state.undo[state.userId].pop();
        throw new Error("没有可添加的新条目（可能都已存在）");
      }
      reflowDeps();
      saveStore();
      if (firstId) {
        state.selectedId = firstId;
        const t = MapU.byId(currentNodes()).get(firstId);
        if (t && t.parentId) state.focusId = t.parentId === "root" ? "root" : t.parentId;
      }
      btn.disabled = false;
      btn.textContent = old;
      closeGen();
      renderApp();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = old;
      alert("AI 建图失败：" + (err && err.message ? err.message : err));
    }
  }

  // —— 快速记：一句话增量维护（加事 / 记卡点 / 标完成），复用 AI 管线，无 AI 兜底 ——
  let quickMsgTimer = null;
  function quickMsg(text) {
    const el = $("#quick-msg");
    if (!el) return;
    el.textContent = text || "";
    if (quickMsgTimer) clearTimeout(quickMsgTimer);
    if (text) quickMsgTimer = setTimeout(() => {
      const e2 = $("#quick-msg");
      if (e2) e2.textContent = "";
    }, 3000);
  }

  // 文本里是否点到了某个已有的事（取名字最长的一处匹配）
  // 名字阈值放到 3，避免「开会」这类短名被「关于开会的准备」误命中
  function findNodeInText(text) {
    const nodes = currentNodes().filter((n) => n.type === "task" || n.type === "project");
    let best = null;
    nodes.forEach((n) => {
      if (n.name && n.name.length >= 3 && text.includes(n.name) && (!best || n.name.length > best.name.length)) best = n;
    });
    return best;
  }

  // 无 AI 兜底：把一句话记到「随手记」项目下
  function simpleQuickAdd(line) {
    pushUndo();
    const nodes = ensureEditable(state.userId);
    let inbox = nodes.find((n) => n.type === "project" && n.name === "随手记" && n.domain === "work");
    if (!inbox) {
      inbox = { id: newId("project"), parentId: "work", name: "随手记", type: "project", domain: "work",
        progress: 0, status: "active", brief: "", nextAction: "", nextHint: "", estimateMin: 0, deps: [], updatedAt: "刚刚", updatedTs: Date.now() };
      nodes.push(inbox);
    }
    const t = { id: newId("task"), parentId: inbox.id, name: line.slice(0, 40), type: "task", domain: "work",
      progress: 0, status: "active", brief: "", nextAction: "", nextHint: "", estimateMin: 0, deps: [], updatedAt: "刚刚", updatedTs: Date.now() };
    nodes.push(t);
    reflowDeps();
    saveStore();
    return t.id;
  }

  async function runQuickAdd(e) {
    e.preventDefault();
    const input = $("#quick-input");
    const line = input.value.trim();
    if (!line) return;
    const doneRe = /做完|完成|搞定|做好|弄完|交了|发出去|结束了/;
    const blockedRe = /卡住|卡在|卡了|堵住|受阻|做不下去|推不动/;

    // 1) 先看是不是在更新某个已有的事
    const target = findNodeInText(line);
    if (target) {
      const isLeaf = MapU.childrenOf(currentNodes(), target.id).length === 0;
      if (doneRe.test(line) && isLeaf) {
        // 命中已有节点就要置「做完」，先确认一次，避免子串误命中直接改状态
        if (!confirm(`把《${target.name}》标记为做完？`)) return;
        setStatus(target.id, "done");
        input.value = "";
        state.selectedId = target.id;
        quickMsg(`已把《${target.name}》标记为做完`);
        renderApp();
        announceFreed();
        return;
      }
      if (blockedRe.test(line)) {
        const m = line.match(/卡(?:在|住了?|了)?[：: ,，]*(.*)$/);
        const reason = (m && m[1] ? m[1] : "").trim();
        editNode(target.id, { status: "blocked", blockedReason: reason || target.blockedReason || "" });
        input.value = "";
        state.selectedId = target.id;
        quickMsg(`已记下《${target.name}》卡住了`);
        renderApp();
        return;
      }
    }

    // 2) 否则当成新捕获：优先用 AI 归类，失败/未配置则兜底到「随手记」
    const btn = $("#quick-btn");
    const old = btn.textContent;
    if (NaviAI.isReady()) {
      btn.disabled = true;
      btn.textContent = "记下…";
      try {
        const items = await NaviAI.plan(line);
        if (items.length) {
          pushUndo();
          const { added, firstId } = applyPlan(items);
          if (added) {
            reflowDeps();
            saveStore();
            if (firstId) state.selectedId = firstId;
            quickMsg(`已加进来 ${added} 件`);
          } else {
            if (state.undo[state.userId]) state.undo[state.userId].pop();
            state.selectedId = simpleQuickAdd(line);
            quickMsg("已记到「工作 › 随手记」，可拖到别处");
          }
        } else {
          state.selectedId = simpleQuickAdd(line);
          quickMsg("已记到「工作 › 随手记」，可拖到别处");
        }
      } catch (err) {
        state.selectedId = simpleQuickAdd(line);
        quickMsg("AI 没接上，先记到「工作 › 随手记」");
      }
      btn.disabled = false;
      btn.textContent = old;
    } else {
      state.selectedId = simpleQuickAdd(line);
      quickMsg("已记到「工作 › 随手记」，可拖到别处");
    }
    input.value = "";
    renderApp();
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

  // —— 解卡流程：把「卡住了」从一个红点变成一次可执行的仪式 ——
  function openUnblock(id) {
    const node = MapU.byId(currentNodes()).get(id);
    if (!node) return;
    state.unblockId = id;
    const form = $("#unblock-form");
    form.reason.value = node.blockedReason || "";
    form.step.value = explicitAction(node) || "";
    $("#unblock-title").textContent = `解卡：${node.name}`;
    $("#unblock-ai").style.display = NaviAI.isReady() ? "" : "none";
    $("#unblock-overlay").classList.add("is-on");
    form.reason.focus();
  }

  function closeUnblock() {
    $("#unblock-overlay").classList.remove("is-on");
    state.unblockId = null;
  }

  function submitUnblock(startNow) {
    const id = state.unblockId;
    if (!id) return;
    const form = $("#unblock-form");
    const reason = form.reason.value.trim();
    const step = form.step.value.trim();
    const fields = { blockedReason: reason };
    if (step) fields.nextAction = step;
    if (startNow) fields.status = "active"; // 把卡点拆成了能动的一步，就不再是「卡住」
    editNode(id, fields);
    closeUnblock();
    if (startNow) {
      const node = MapU.byId(currentNodes()).get(id);
      renderApp();
      if (node) openFocus(node);
    } else {
      renderApp();
      showToast("解卡思路已记下");
    }
  }

  async function unblockThink(btn) {
    if (!NaviAI.isReady()) {
      closeUnblock();
      return openAI();
    }
    const node = MapU.byId(currentNodes()).get(state.unblockId);
    if (!node) return;
    const reason = $("#unblock-form").reason.value.trim();
    const prompt =
      `事情：${node.name}\n` +
      `所属：${node.domain ? domainName(node.domain) : "—"}\n` +
      `卡在：${reason || node.blockedReason || "（没写）"}\n` +
      `请只给现在能立刻上手、拆掉这个卡点的第一步。`;
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = "AI 想想…";
    try {
      const { action, hint } = await NaviAI.suggest(prompt);
      if (action) {
        $("#unblock-form").step.value = action;
        if (hint) showToast(hint);
      }
    } catch (err) {
      alert("AI 生成失败：" + (err && err.message ? err.message : err));
    }
    btn.disabled = false;
    btn.textContent = old;
  }

  function renderApp() {
    const va = $("#view-app");
    if (va) va.classList.toggle("tree-open", !!state.treeOpen);
    renderHero();
    renderAnswer(DATA().nodes);
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
        : `<span class="empty">还没有别的事可以等。</span>`;
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
    $("#btn-undo").addEventListener("click", undo);
    $("#btn-redo").addEventListener("click", redo);
    $("#btn-ai").addEventListener("click", openAI);
    $("#btn-remind").addEventListener("click", toggleRemind);
    $("#btn-search").addEventListener("click", openSearch);
    $("#quick-add").addEventListener("submit", runQuickAdd);
    $("#btn-fullview").addEventListener("click", () => {
      state.treeOpen = true;
      renderApp();
    });
    $("#btn-backtoday").addEventListener("click", () => {
      // 回到「今天」：清掉领域筛选与焦点，回到跨领域的全局视图
      state.treeOpen = false;
      state.domain = "all";
      state.focusId = "root";
      renderApp();
    });
    $("#btn-gen").addEventListener("click", openGen);
    $("#gen-form").addEventListener("submit", runGen);
    $("#gen-cancel").addEventListener("click", closeGen);
    $("#gen-overlay").addEventListener("click", (e) => {
      if (e.target.id === "gen-overlay") closeGen();
    });
    $("#unblock-form").addEventListener("submit", (e) => {
      e.preventDefault();
      submitUnblock(true);
    });
    $("#unblock-save").addEventListener("click", () => submitUnblock(false));
    $("#unblock-cancel").addEventListener("click", closeUnblock);
    $("#unblock-ai").addEventListener("click", (e) => unblockThink(e.currentTarget));
    $("#unblock-overlay").addEventListener("click", (e) => {
      if (e.target.id === "unblock-overlay") closeUnblock();
    });
    $("#ai-form").addEventListener("submit", saveAI);
    $("#ai-clear").addEventListener("click", clearAI);
    $("#ai-cancel").addEventListener("click", closeAI);
    $("#ai-overlay").addEventListener("click", (e) => {
      if (e.target.id === "ai-overlay") closeAI();
    });
    $("#search-overlay").addEventListener("click", (e) => {
      if (e.target.id === "search-overlay") closeSearch();
    });
    const searchInput = $("#search-input");
    searchInput.addEventListener("input", () => {
      state.searchActive = 0;
      renderSearchResults(searchInput.value);
    });
    searchInput.addEventListener("keydown", (e) => {
      const n = (state.searchList || []).length;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (n) state.searchActive = (state.searchActive + 1) % n;
        renderSearchResults(searchInput.value);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (n) state.searchActive = (state.searchActive - 1 + n) % n;
        renderSearchResults(searchInput.value);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const pick = (state.searchList || [])[state.searchActive];
        if (pick) jumpTo(pick.id);
      }
    });
    $("#edit-form").addEventListener("submit", submitEditor);
    $("#edit-cancel").addEventListener("click", closeEditor);
    $("#edit-overlay").addEventListener("click", (e) => {
      if (e.target.id === "edit-overlay") closeEditor();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if ($("#search-overlay").classList.contains("is-on")) closeSearch();
        else if ($("#unblock-overlay").classList.contains("is-on")) closeUnblock();
        else if ($("#gen-overlay").classList.contains("is-on")) closeGen();
        else if ($("#ai-overlay").classList.contains("is-on")) closeAI();
        else if ($("#edit-overlay").classList.contains("is-on")) closeEditor();
        else if ($("#overlay").classList.contains("is-on")) finishFocus(false);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && state.view === "app") {
        e.preventDefault();
        if ($("#search-overlay").classList.contains("is-on")) closeSearch();
        else openSearch();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && state.view === "app") {
        if (anyOverlayOpen()) return;
        e.preventDefault();
        if (e.shiftKey) {
          if (canRedo()) redo();
        } else if (canUndo()) {
          undo();
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y" && state.view === "app") {
        if (!anyOverlayOpen() && canRedo()) {
          e.preventDefault();
          redo();
        }
      }
    });
  }

  // 主页 →「进入」→ 状态图：从欢迎页切进 app 并启动
  function enterApp() {
    const w = $("#view-welcome");
    if (w) w.classList.add("is-hidden");
    const a = $("#view-app");
    if (a) a.classList.remove("is-hidden");
    boot();
  }

  loadStore();
  bind();
  const enterBtn = $("#btn-enter");
  if (enterBtn) enterBtn.addEventListener("click", enterApp);
  else enterApp(); // 没有欢迎页（老结构）时直接进入
})();
