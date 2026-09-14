/*
 * Store：文档状态 + 审计事件流 + 分支 + 撤销/重做 + 布局版本 + 持久化
 *
 * 审计与分支（见 audit.js）：
 * - events[] 是全局 append-only 的审计事件表，事件深冻结、永不修改/删除；
 *   每次对矩形/约束的提交都追加一条，记录操作者、时间、提交前后指纹、
 *   结构化变更（compareVersions）和当时的冲突结果。
 * - branches[] 的每个分支由 parentId 链串起 root..head；undo/redo 沿链行走，
 *   undo 后新提交会让旧链成为“支线”（detached），事件本身仍在审计流里可浏览、可回放。
 * - replayEventId 非空时处于只读回放：current 取该事件快照，一切写操作被拒绝。
 *   退出回放回到分支 head；从回放事件 fork 会创建带来源关系的新分支。
 *
 * 乐观并发（分支头序号）：
 * - 保存携带 baseHeads = { [branchId]: headEventId }（“所依据的事件序号”）。
 * - 服务端若发现当前分支 head 已前进 -> 409「分支已前进」，明确拒绝覆盖。
 * - 若过期提交发生在另一个页面新建/编辑的*不同分支*上，服务端按 mergeDocs
 *   合流（事件不可变、按 id 并集），两边编辑都保留。
 * - 本页有未保存修改时收到 409：锁定写入并提示；无修改时静默跟随。
 */

import { solve, findCycle } from './solver.js';
import { validate, normalize, seedModel, uid } from './model.js';
import { snapshotVersion, compareVersions } from './versions.js';
import {
  MAIN_BRANCH, makeRootEvent, makeEvent, makeForkRootEvent, makeExperimentForkRootEvent,
  sanitizeAudit, migrateLegacy, timelineFor, localSeqOf, isAncestor,
  mergeDocs, assessConflict, freeze,
} from './audit.js';
import {
  makeExperiment, prepareSpecs, executeVariant, makeVariantResult,
  sanitizeExperiments, mergeExperiments, experimentConfigHash,
  diffVariant, variantReplayable, reconcileRunState, variantCounters,
} from './experiments.js';
import {
  buildWorkbench, defaultWorkbench, normalizeWorkbench, filterNodes,
} from './auditbench.js';
import {
  createReviewSession, reconcileSession, recordDecision, signReviewNode, mergeReviewSignature,
  mergeReviewItem, makeSignatureProposal, normalizeReviewPolicy, validateReviewPolicy,
  rebaseSession, completeReview, reopenReview, sanitizeReviewSessions,
  mergeReviewSessions, assessServerReviewConflict, findReviewNodeDrift,
  buildReviewReport, sessionProgress, activeSignatures, isAllowedSigner,
} from './reviews.js';
import {
  TRIGGER_TYPES, createRule, editRule, deleteRule,
  syncNotifyEvents, materializeNotifications, pumpNotifications, recordDeliveryAttempt,
  acknowledgeNotification, snoozeNotification, transferNotification, retryNotification,
  sanitizeNotifyEvents, sanitizeRules, sanitizeNotifications, sanitizeOutbox,
  mergeRules, mergeNotifyEvents, mergeNotifications, mergeOutbox,
  assessServerNotifyConflict, buildNotifyReport, pendingInbox, notificationCounters,
  notifyEventId, MAX_ATTEMPTS,
} from './notifications.js';

const LS_KEY = 'rect-constraints-doc-v2';
const LS_KEY_LEGACY = 'rect-constraints-doc-v1';
const ACTOR_KEY = 'rect-constraints-actor';

export class Store extends EventTarget {
  constructor({ base = '', tickMs = 25, onVariantGate = null } = {}) {
    super();
    this.base = base;
    this.tickMs = tickMs;           // 变体之间的让出间隔（暂停/继续/取消的响应粒度）
    this.onVariantGate = onVariantGate; // 测试钩子：每个变体求解前同步调用
    this.events = [];
    this.eventsById = new Map();
    this.branches = [];
    this.currentBranchId = MAIN_BRANCH;
    this.replayEventId = null;   // 只读回放指向的事件 id
    this.replaySnapshot = null;  // 通用快照回放：求解前/变体基准等非事件节点的只读克隆
    this.actor = localStorage.getItem(ACTOR_KEY) || '';

    this.rev = 0;
    this.versions = [];
    this.currentVersionId = null;
    this.compare = { a: null, b: null };
    this.branchCompare = { a: null, b: null }; // 分支比较选择（持久化）
    this.auditWorkbench = defaultWorkbench(); // 实验审计工作台视图状态（筛选/回放位置/前后面）
    this.auditWarnings = [];

    this.reviewSessions = [];                 // 可恢复审阅会话（快照 + 决定 + 变更记录 + 冲突记录）
    this.activeReviewId = null;               // 当前打开的审阅会话 id（随文档持久化）
    this._reviewProposals = new Map();        // sessionId -> [{nodeKey, decision, reason, by, at, rejected}]（409 后本地保留）
    this._reviewSyncedRevs = {};              // sessionId -> 已与服务端确认的会话 rev（审阅乐观锁）
    this._reviewAuthoredRevs = new Map();     // sessionId -> Set(rev)：本页自己写入过的 rev（localStorage 自我写入不判冲突）
    this.reviewConflict = null;               // null | { sessionId, reason, serverRev, session }（该会话写入锁定）

    this.experiments = [];
    this.experimentWarnings = [];
    this._runners = new Map();   // experimentId -> {token}（进行中的批量运行）

    // 审阅通知与升级中心
    this.notifyEvents = [];        // append-only 通知事件（决定/签署/冲突/完成），按 id 幂等并集
    this.notifyRules = [];         // 每会话多级升级规则（rev 乐观并发）
    this.notifications = [];       // 物化通知项（事件 × 级别 × 接收人，幂等 id）
    this.notifyOutbox = [];        // FIFO 发送队列（稳定 id，断网保留、恢复后按序重试）
    this._notifyRuleSyncedRevs = {};  // ruleId -> 已与服务端确认的规则 rev（规则乐观锁）
    this._notifyItemBase = new Map();  // notifyId -> 上次同步时的 {status, ackedAt}（通知项乐观锁）
    this._notifyRuleDrafts = new Map(); // ruleId -> 本地未提交规则编辑（规则冲突后保留）
    this._notifyItemDrafts = new Map(); // notifyId -> [动作描述符]（同一通知被两窗口处理后保留）
    this._notifyPendingItemActions = new Map(); // notifyId -> 最近一次乐观动作（待服务端确认；409 时转为 draft）
    this._notifyOptimisticLog = new Map();     // notifyId -> 最近一次乐观动作（跨保存链保留到服务端确认 / 409）
    this._notifyServerKnownItems = new Set();  // 已随某次保存被服务端确认的通知项 id
    this._notifyDeferredItemConflicts = new Map(); // notifyId -> 到达时本地尚无乐观动作的 item 409（挂起）
    this._notifyAuthoredItemStates = new Map(); // notifyId -> Set(status)：本页自己产生过的状态（防抖窗口内不把磁盘旧值误判为外来推进）
    this.notifyConflict = null;        // null | { kind:'rule'|'item', id, reason, serverRev/serverStatus }
    this._notifyLockedRules = new Set();
    this._notifyLockedItems = new Set();
    this._notifyAuthoredRuleRevs = new Map(); // ruleId -> Set(rev)：本页自写 rev（localStorage 自检不判冲突）
    this.online = true;                 // 最近一次网络结果（断网时发送留在队列）
    this._transport = null;             // 可注入的发送通道（测试）；默认 in-app 持久化即送达
    this._flushing = false;             // outbox 单飞刷新
    this._notifyOutboxTombstones = new Set(); // 本页已终结（送达/确认/转交/陈旧移除）的 outbox 条目 id：合流时防磁盘旧值复活
    this._notifyTimer = null;           // 心跳定时器（到期物化 / 升级 / 重试）
    this.notifyTickMs = 1000;
    this.notifyBackoffMs = 30_000;

    this.dragPreview = null;
    this.saveConflict = null;   // null | { reason, branchName, headSeq }
    this._dirty = false;
    this._syncedHeads = {};     // 服务端已确认的各分支 headEventId
  }

  /* ---------- 装载 / 保存 ---------- */

  async load() {
    let doc = null;
    try {
      doc = await this._fetchDoc();
    } catch (e) {
      console.warn('后端不可用，回退 localStorage:', e.message);
    }
    if (!doc) {
      try { doc = JSON.parse(localStorage.getItem(LS_KEY) || localStorage.getItem(LS_KEY_LEGACY) || 'null'); } catch { doc = null; }
    }
    await this._adopt(doc, { seed: true });
    this._dirty = false;
    // 首次播种 / 迁移后立即回写并等待确认；正常加载不产生版本号竞争
    if (this._needsInitialPersist || this._notifyNeedsPersist) {
      this._needsInitialPersist = false;
      this._notifyNeedsPersist = false;
      this._dirty = true;
      this.persist();
      await this.flushed();
    }
    // 重启后把可能已到期 / 待发送的通知队列按序发送一次
    this.flushOutbox().catch(() => {});
    this._emit('load');
  }

  /** 把一个（可能是旧版、可能损坏的）文档装载为当前状态。 */
  async _adopt(doc, { seed = false, keepReviewConflict = false } = {}) {
    const savedReviewConflict = keepReviewConflict ? this.reviewConflict : null;
    const savedProposals = keepReviewConflict ? new Map(this._reviewProposals) : null;
    let seeded = false;
    if (!doc || (!(Array.isArray(doc.events) && doc.events.length) && Array.isArray(doc.entries))) {
      // 旧版文档：entries/idx 迁移为不可变审计事件链
      if (doc && Array.isArray(doc.entries) && doc.entries.length) {
        doc = migrateLegacy(doc);
        seeded = true;
      } else {
        doc = null;
      }
    }
    if (!doc || !Array.isArray(doc.events) || !doc.events.length) {
      const root = makeRootEvent(MAIN_BRANCH, { model: seedModel(), actor: this.actor || '系统' });
      doc = {
        events: [root],
        branches: [freeze({
          id: MAIN_BRANCH, name: '主分支', createdAt: root.t,
          rootEventId: root.id, headEventId: root.id, redoTipId: null, source: null,
        })],
        currentBranchId: MAIN_BRANCH,
        versions: [], currentVersionId: null,
        compare: { a: null, b: null }, branchCompare: { a: null, b: null },
        actor: this.actor,
      };
      seeded = true;
    }

    const clean = sanitizeAudit(doc);
    this.events = clean.events;
    this.eventsById = clean.eventsById;
    this.branches = clean.branches;
    this.currentBranchId = clean.branchesById.has(doc.currentBranchId) ? doc.currentBranchId : clean.currentBranchId;
    this.actor = clean.actor || this.actor;
    this.auditWarnings = clean.warnings;

    if (clean.needSeed) {
      // 主分支完全不可回放：用种子布局另立主分支，坏审计事件保留可见
      const root = makeRootEvent(MAIN_BRANCH, { model: seedModel(), actor: this.actor || '系统' });
      this.events = [...this.events, root];
      this.eventsById.set(root.id, root);
      this.branches = this.branches.filter((b) => b.id !== MAIN_BRANCH);
      this.branches.push(freeze({
        id: MAIN_BRANCH, name: '主分支', createdAt: root.t,
        rootEventId: root.id, headEventId: root.id, redoTipId: null, source: null,
      }));
      this.currentBranchId = MAIN_BRANCH;
      seeded = true;
    }

    if (seed) this._needsInitialPersist = seeded;

    this.versions = sanitizeVersions(doc.versions);
    this.currentVersionId = this.versions.some((v) => v.id === doc.currentVersionId) ? doc.currentVersionId : null;
    const cmp = doc.compare || {};
    this.compare = {
      a: this.versions.some((v) => v.id === cmp.a) ? cmp.a : null,
      b: this.versions.some((v) => v.id === cmp.b) ? cmp.b : null,
    };
    const bc = doc.branchCompare || {};
    this.branchCompare = {
      a: this.branches.some((b) => b.id === bc.a) ? bc.a : null,
      b: this.branches.some((b) => b.id === bc.b) ? bc.b : null,
    };

    // 布局方案实验：结构/指纹清洗（变体结果损坏只标该变体，实验照常打开）
    this.experimentWarnings = [];
    this.experiments = sanitizeExperiments(doc.experiments, this.experimentWarnings);
    this._runners = new Map();

    this.replayEventId = null;
    this.replaySnapshot = null;
    this.dragPreview = null;
    this.saveConflict = null;
    this._syncedHeads = {};
    for (const b of this.branches) this._syncedHeads[b.id] = b.headEventId;
    this.rev = Number.isFinite(doc.rev) ? doc.rev : 0;

    // 实验审计工作台：筛选条件 / 回放位置 / 前后面随文档持久化；
    // 失效引用回退，playing 一律收敛为暂停（重启位置保留、不自动播放）
    const wb = buildWorkbench({
      events: this.events, eventsById: this.eventsById,
      branches: this.branches, branchesById: this.branchesById,
      experiments: this.experiments,
    });
    this.auditWorkbench = normalizeWorkbench(doc.auditWorkbench, {
      branchIds: new Set(this.branches.map((b) => b.id)),
      experiments: this.experiments,
      nodeKeys: wb.byKey,
    });

    // 审阅会话：逐条对账（损坏/缺失/分支推进/指纹变化 → 原决定保留、转待复核并记录原因）。
    // 对账是确定性、幂等的纯函数，刷新 / 重启 / 合流后标注与冲突记录逐字节一致。
    this.reviewSessions = sanitizeReviewSessions(doc.reviewSessions, wb, { now: Date.now() });
    this.activeReviewId = this.reviewSessions.some((x) => x.id === doc.activeReviewId) ? doc.activeReviewId : null;
    this._reviewProposals = new Map();
    this.reviewConflict = null;
    this._reviewSyncedRevs = {};
    this._reviewAuthoredRevs = new Map();
    for (const s of this.reviewSessions) this._reviewSyncedRevs[s.id] = s.rev;
    // 合流响应重新装载时，保留本页尚未逐项合并/放弃的内存态审阅冲突与本地决定
    if (savedReviewConflict && this.reviewSessions.some((x) => x.id === savedReviewConflict.sessionId)) {
      this.reviewConflict = { ...savedReviewConflict, serverRev: this.reviewSessionById(savedReviewConflict.sessionId)?.rev ?? savedReviewConflict.serverRev };
      this._reviewProposals = new Map([...savedProposals]);
      this._reviewSyncedRevs[savedReviewConflict.sessionId] = this.reviewSessionById(savedReviewConflict.sessionId)?.rev ?? this._reviewSyncedRevs[savedReviewConflict.sessionId];
    }

    this._adoptNotify(doc, { seed });
  }

  /**
   * 装载通知中心状态（确定性、幂等）：
   *  1. 清洗事件 / 规则 / 通知项 / 队列；
   *  2. 从审阅会话【派生】缺失的通知事件（append-only 并集，id 幂等）；
   *  3. 按规则物化通知项（规则修改水位保证旧事件不补发）；
   *  4. 心跳推进到期 / 稍后 / 退避并补入 FIFO 队列。
   * 刷新、重启后规则、队列、重试次数、升级状态、确认记录与送达结果由此重建。
   */
  _adoptNotify(doc, { seed = false } = {}) {
    const now = Date.now();
    const prevEvents = sanitizeNotifyEvents(doc.notifyEvents);
    const synced = syncNotifyEvents(prevEvents, this.reviewSessions, { now });
    this.notifyEvents = synced.events;
    this.notifyRules = sanitizeRules(doc.notifyRules, { now });
    const cleanItems = sanitizeNotifications(doc.notifications, { now });
    const mat = materializeNotifications(cleanItems, this.notifyRules, this.notifyEvents, { now });
    const cleanOutbox = sanitizeOutbox(doc.notifyOutbox, { now });
    const pumped = pumpNotifications(mat.items, cleanOutbox, { now, backoffMs: this.notifyBackoffMs });
    this.notifications = pumped.items;
    this.notifyOutbox = pumped.outbox;

    // 队列中引用已不存在 / 已终态通知项的陈旧条目移除（幂等）
    const liveIds = new Set(this.notifications.map((n) => n.id));
    this.notifyOutbox = this.notifyOutbox.filter((o) => {
      if (!liveIds.has(o.notifyId)) return false;
      const it = this.notifications.find((x) => x.id === o.notifyId);
      return it && (it.status === 'pending' || it.status === 'sent');
    });

    this._notifyRuleSyncedRevs = {};
    for (const r of this.notifyRules) {
      this._notifyRuleSyncedRevs[r.id] = Math.max(r.rev || 0, r.deleteRev || 0);
    }
    this._notifyItemBase = new Map(this.notifications.map((n) => [n.id, { status: n.status, ackedAt: n.ackedAt ?? null }]));
    // 装载到的通知项都来自已持久化的权威文档：标记为服务端已知；本次装载新物化的项除外
    this._notifyServerKnownItems = new Set((Array.isArray(doc.notifications) ? doc.notifications : []).map((n) => n.id));
    this._notifyAuthoredRuleRevs = new Map();
    if (!this._notifyRuleDrafts) this._notifyRuleDrafts = new Map();
    if (!this._notifyItemDrafts) this._notifyItemDrafts = new Map();
    // 冲突锁 / 本地未提交操作只由 409 流程显式清理；合流重载时保留（调用方负责传入）。
    this._notifyLockedRules = this._notifyLockedRules || new Set();
    this._notifyLockedItems = this._notifyLockedItems || new Set();
    this.notifyConflict = this.notifyConflict || null;
    // 被锁定的规则 / 项若在新文档里消失，清理其锁
    const ruleIds = new Set(this.notifyRules.map((r) => r.id));
    for (const rid of [...this._notifyLockedRules]) if (!ruleIds.has(rid)) this._notifyLockedRules.delete(rid);
    const itemIds = new Set(this.notifications.map((n) => n.id));
    for (const nid of [...this._notifyLockedItems]) if (!itemIds.has(nid)) this._notifyLockedItems.delete(nid);
    if (!this._notifyLockedRules.size && !this._notifyLockedItems.size) this.notifyConflict = null;
    if (seed) this._notifyNeedsPersist = synced.newEvents.length > 0 || mat.added.length > 0 || pumped.enqueued > 0 || pumped.changed;
    this._startNotifyTicker();
  }

  /** 测试 / 装配时注入发送通道：{ async send(item) -> {ok, error?, detail?}, isOnline() }。 */
  setNotifyTransport(transport) { this._transport = transport; }

  _isOnline() {
    if (this._transport?.isOnline) return !!this._transport.isOnline();
    return this.online;
  }

  _startNotifyTicker() {
    if (this._notifyTimer || typeof setInterval !== 'function') return;
    this._notifyTimer = setInterval(() => {
      try { this.pumpNotify({ persist: true }); this.flushOutbox().catch(() => {}); } catch {}
    }, this.notifyTickMs);
    // 不阻止 Node 测试进程退出
    if (this._notifyTimer?.unref) this._notifyTimer.unref?.();
  }

  /**
   * 通知心跳：先从当前审阅会话派生新事件，再物化 / 推进 / 入队。
   * 由审阅动作、定时 ticker、页面操作调用；纯函数 + 原地替换，结果确定。
   */
  pumpNotify({ persist = false, now = Date.now() } = {}) {
    const synced = syncNotifyEvents(this.notifyEvents, this.reviewSessions, { now });
    this.notifyEvents = synced.events;
    const mat = materializeNotifications(this.notifications, this.notifyRules, this.notifyEvents, { now });
    this.notifications = mat.items;
    const pumped = pumpNotifications(this.notifications, this.notifyOutbox, { now, backoffMs: this.notifyBackoffMs });
    this.notifications = pumped.items;
    this.notifyOutbox = pumped.outbox;
    // 有未解决版本冲突的锁定项不参与发送：其本地动作保留为草稿（横幅里重试 / 放弃）。
    // pump 可能把仍是 pending 的锁定项重新入队，这里移出（不立墓碑——解锁后重试 /
    // 重新应用草稿时应能再次入队）；墓碑条目（本页已终结）则连旧副本一并挡住。
    if (this._notifyLockedItems.size || this._notifyOutboxTombstones.size) {
      const locked = [];
      const dead = [];
      for (const o of this.notifyOutbox) {
        if (this._notifyLockedItems.has(o.notifyId)) locked.push(o.id);
        else if (this._notifyOutboxTombstones.has(o.id)) dead.push(o.id);
      }
      if (locked.length) this.notifyOutbox = this.notifyOutbox.filter((o) => !locked.includes(o.id));
      if (dead.length) this._removeOutboxEntries(dead);
    }
    // pump 产生的状态推进（到期 pending / 稍后回 pending）标记为本页自写。
    // OCC 基线不在这里乐观前进，只在服务端确认保存后更新（避免超前基线对旧状态误判 409）。
    for (const n of this.notifications) this._markAuthoredItem(n.id, n.status);
    if (persist && (synced.newEvents.length || mat.added.length || pumped.changed)) {
      this._dirty = true;
      this.persist();
    }
    if (pumped.enqueued > 0) this.flushOutbox().catch(() => {});
    this._emit('notify', { type: 'pump', newEvents: synced.newEvents.length, added: mat.added.length, enqueued: pumped.enqueued });
    return { newEvents: synced.newEvents, added: mat.added, enqueued: pumped.enqueued };
  }

  async _fetchDoc() {
    const res = await fetch(this.base + '/api/doc');
    if (!res.ok) throw new Error(`GET /api/doc ${res.status}`);
    const data = await res.json();
    return data && (Array.isArray(data.events) || Array.isArray(data.entries)) ? data : null;
  }

  _payload() {
    return {
      events: this.events,
      branches: this.branches,
      currentBranchId: this.currentBranchId,
      versions: this.versions,
      currentVersionId: this.currentVersionId,
      compare: this.compare,
      branchCompare: this.branchCompare,
      experiments: this.experiments,
      auditWorkbench: this.auditWorkbench,
      reviewSessions: this.reviewSessions,
      activeReviewId: this.activeReviewId,
      notifyEvents: this.notifyEvents,
      notifyRules: this.notifyRules,
      notifications: this.notifications,
      notifyOutbox: this.notifyOutbox,
      actor: this.actor,
    };
  }

  _saveTimer = null;
  _saveChain = Promise.resolve();
  _saveVersion = 0;
  _pendingSaves = new Map(); // 防抖保存版本号 -> 该次 PUT 的 promise（送达落定等待用）
  persist() {
    if (this._disposed) return; // dispose() 后一切迟到的防抖保存都是 no-op
    if (this.saveConflict) return; // 几何编辑冲突未解决：不再写任何存储
    const payload = this._payload();
    let merged = null;
    let prevExperiments = null;
    try {
      let prev = JSON.parse(localStorage.getItem(LS_KEY) || 'null')
        || JSON.parse(localStorage.getItem(LS_KEY_LEGACY) || 'null');
      if (prev) {
        prevExperiments = Array.isArray(prev.experiments) ? prev.experiments : null;
        // 连续同步 commit 时，第一次的防抖 PUT 可能还没发出，localStorage 里
        // 尚不含本页刚追加的事件：只把本页已知事件按 id 并集补进去
        // （绝不能快进磁盘上的分支 head，否则会掩盖别的页签对同分支的推进）。
        const known = new Map((prev.events || []).map((e) => [e.id, e]));
        for (const e of this.events) if (!known.has(e.id)) known.set(e.id, e);
        prev = { ...prev, events: [...known.values()] };
        merged = this._checkLocalConflict(prev, payload);
        if (this.saveConflict) return;
        // 审阅会话的多页签乐观锁：另一页签已推进同一会话 rev（或节点指纹/存在性已变）
        // → 409 语义，本地决定保留为提案、绝不覆盖
        const reviewConflict = this._checkLocalReviewConflict(prev, payload);
        if (reviewConflict) {
          this._onReviewConflict(reviewConflict);
          return;
        }
        // 通知中心多页签乐观锁：规则被另一页签前进 / 删除、通知项被另一窗口处理
        const notifyConflict = this._checkLocalNotifyConflict(prev, payload);
        if (notifyConflict) {
          this._onNotifyConflict(notifyConflict);
          return;
        }
      }
      // 本地多页签合流：merged 已含本页当前分支最新提交，直接落合并结果
      const finalDoc = merged || { ...payload, rev: this.rev };
      // 实验按 id 合入磁盘（别的页签可能建了实验；完成结果永不被降级覆盖）
      finalDoc.experiments = mergeExperiments(prevExperiments || finalDoc.experiments || [], payload.experiments);
      // 审阅会话按 id 合入磁盘（rev 更大者胜出；冲突记录并集）
      finalDoc.reviewSessions = mergeReviewSessions(
        Array.isArray(prev?.reviewSessions) ? prev.reviewSessions : (finalDoc.reviewSessions || []),
        payload.reviewSessions || []);
      // 通知中心：事件 append-only 并集；规则按 rev 墓碑；通知项走得更远者胜出 + 历史并集；队列 FIFO 并集
      finalDoc.notifyEvents = mergeNotifyEvents(
        Array.isArray(prev?.notifyEvents) ? prev.notifyEvents : [], finalDoc.notifyEvents || []);
      finalDoc.notifyRules = mergeRules(
        Array.isArray(prev?.notifyRules) ? prev.notifyRules : [], finalDoc.notifyRules || []);
      finalDoc.notifications = mergeNotifications(
        Array.isArray(prev?.notifications) ? prev.notifications : [], finalDoc.notifications || []);
      // 队列 FIFO 并集，但先剔除本页已终结（送达/确认/转交/陈旧清理）的条目：
      // 否则防抖窗口里磁盘仍是旧队列，并集会把刚发送出队的条目复活。
      const prevOutbox = (Array.isArray(prev?.notifyOutbox) ? prev.notifyOutbox : [])
        .filter((o) => !this._notifyOutboxTombstones.has(o.id));
      finalDoc.notifyOutbox = mergeOutbox(prevOutbox, finalDoc.notifyOutbox || []);
      finalDoc.activeReviewId = finalDoc.reviewSessions.some((x) => x.id === finalDoc.activeReviewId)
        ? finalDoc.activeReviewId
        : (payload.activeReviewId && finalDoc.reviewSessions.some((x) => x.id === payload.activeReviewId) ? payload.activeReviewId : null);
      localStorage.setItem(LS_KEY, JSON.stringify(finalDoc));
      // 记录本页自己写入过的会话 rev：防抖窗口内重读 localStorage 不把自己的写入误判成外来推进
      for (const rs of payload.reviewSessions || []) {
        if (!this._reviewAuthoredRevs.has(rs.id)) this._reviewAuthoredRevs.set(rs.id, new Set());
        this._reviewAuthoredRevs.get(rs.id).add(rs.rev);
      }
      for (const r of payload.notifyRules || []) {
        if (!this._notifyAuthoredRuleRevs.has(r.id)) this._notifyAuthoredRuleRevs.set(r.id, new Set());
        this._notifyAuthoredRuleRevs.get(r.id).add(Math.max(r.rev || 0, r.deleteRev || 0));
      }
    } catch {}
    this._emit('persist');
    ++this._saveVersion;
    clearTimeout(this._saveTimer);
    const version = this._saveVersion;
    this._saveTimer = setTimeout(() => {
      // 记录本次防抖保存对应的 promise：送达落定等待（_waitSaveSettled）等最新一次，
      // 不能再调 _sendLatest()（会 bump 版本号，使外层 await 的链因版本守卫提前结束）。
      const p = this._sendLatest();
      this._pendingSaves.set(version, p);
      p.finally(() => { if (this._pendingSaves.get(version) === p) this._pendingSaves.delete(version); }).catch(() => {});
    }, 120);
  }

  /** 立即结算防抖保存并等待【最新一次】保存请求落定（不重新排队、不 bump 版本号）。 */
  async _settlePendingSave() {
    clearTimeout(this._saveTimer);
    // 若防抖还没触发（_pendingSaves 尚无条目），立即发起一次并登记
    const version = this._saveVersion;
    if (!this._pendingSaves.has(version) && !this.saveConflict) {
      const p = this._sendLatest();
      this._pendingSaves.set(version, p);
      p.finally(() => { if (this._pendingSaves.get(version) === p) this._pendingSaves.delete(version); }).catch(() => {});
    }
    await Promise.allSettled([...this._pendingSaves.values()]);
  }

  /**
   * localStorage 多页面冲突检测（离线 / 服务端不可用时的同源多页签协调）。
   * 入参 stored：磁盘文档，其事件已补入本页已知事件，但【分支 head 保持磁盘原样】。
   * - 磁盘当前分支 head 不在本页基线链上 -> 另一页签推进了同分支，冲突锁；
   * - 推进在别的分支 / 新分支 -> 合流；
   * - 在本页链上（本页更新或无变化）-> 常规覆盖，返回 null。
   */
  _checkLocalConflict(stored, payload) {
    const myHead = this.branch.headEventId;
    const myBase = this._syncedHeads[this.currentBranchId];
    const storedBranch = stored.branches?.find?.((b) => b.id === this.currentBranchId);
    const storedHead = storedBranch?.headEventId;
    if (!storedBranch || !storedHead || storedHead === myHead || !myBase) return null;
    const byId = new Map((stored.events || []).map((e) => [e.id, e]));

    // 判定磁盘当前分支 head 与本页 head 的关系（事件不可变，只看父链）：
    //  - 磁盘 head 是本页已知事件（本页刚提交/undo/redo 过）：本页自己写的，可覆盖
    //  - 磁盘 head 沿父链能走到【本页 head】：本页已包含磁盘提交 -> 可覆盖
    //  - 磁盘 head 与本页 head 在同基线上分叉：同分支外来推进 -> 冲突
    //  - 走不到本页 base：跨分支/新分支，交给 assessConflict 决定能否合流
    const selfWrote = this.eventsById.has(storedHead);
    if (selfWrote || isAncestor(storedHead, myHead, byId)) {
      // 当前分支本页领先/一致。仅当 stored 含本页不知道的外来事件/分支（别的页签
      // 在*其他分支*上的提交）时才合流；否则常规覆盖，避免无谓改动 rev/状态。
      const hasForeignEvents = (stored.events || []).some((e) => !this.eventsById.has(e.id));
      const hasForeignBranches = (stored.branches || []).some((b) => !this.branches.some((x) => x.id === b.id));
      if (!hasForeignEvents && !hasForeignBranches) return null;
      const merged = mergeDocs(stored, { ...payload, baseHeads: this._syncedHeads });
      merged.reviewSessions = mergeReviewSessions(merged.reviewSessions || [], payload.reviewSessions || []);
      merged.rev = Math.max(Number.isFinite(stored.rev) ? stored.rev : 0, this.rev) + 1;
      this.rev = merged.rev;
      if (merged.events.length > this.events.length) {
        this.events = merged.events;
        this.eventsById = new Map(merged.events.map((e) => [e.id, e]));
      }
      for (const mb of merged.branches) {
        const local = this.branches.find((x) => x.id === mb.id);
        if (!local) this.branches = [...this.branches, mb];
        if (mb.id !== this.currentBranchId) this._syncedHeads[mb.id] = mb.headEventId;
      }
      return merged;
    }

    const reachesBase = isAncestor(myBase, storedHead, byId);
    const client = { ...payload, baseHeads: this._syncedHeads };
    if (reachesBase) {
      // 同一分支、同一基线上的分叉：另一个页签已提交，明确拒绝覆盖
      const info = { reason: 'branch-advanced', branchId: this.currentBranchId, branchName: storedBranch.name, headEventId: storedHead, headSeq: byId.get(storedHead)?.seq ?? null };
      this._onSaveConflict(info, stored.rev);
      return null;
    }
    const verdict = assessConflict(stored, client);
    if (!verdict.mergeable) {
      this._onSaveConflict(verdict, stored.rev);
      return null;
    }
    const merged = mergeDocs(stored, client);
    merged.reviewSessions = mergeReviewSessions(merged.reviewSessions || [], payload.reviewSessions || []);
    merged.rev = Math.max(Number.isFinite(stored.rev) ? stored.rev : 0, this.rev) + 1;
    this.rev = merged.rev;
    if (merged.events.length > this.events.length) {
      this.events = merged.events;
      this.eventsById = new Map(merged.events.map((e) => [e.id, e]));
    }
    for (const mb of merged.branches) {
      const local = this.branches.find((x) => x.id === mb.id);
      if (!local) this.branches = [...this.branches, mb];
      if (mb.id !== this.currentBranchId) this._syncedHeads[mb.id] = mb.headEventId;
    }
    return merged;
  }

  /**
   * localStorage 多页签审阅冲突检测（离线 / 服务端不可用时的协调）。
   * 本页自己写入的 rev 不算外来推进（与几何侧 selfWrote 同理，防抖窗口内
   * localStorage 已是本页最新值）；外来会话 rev 落后于磁盘（另一页签已提交决定）、
   * 或本次推进的节点相对磁盘数据缺失 / 指纹变化 / 分支推进 → review-* 冲突。
   */
  _checkLocalReviewConflict(stored, payload) {
    const storedSessions = new Map((stored.reviewSessions || []).map((x) => [x.id, x]));
    for (const s of payload.reviewSessions || []) {
      const authored = this._reviewAuthoredRevs.get(s.id);
      const srv = storedSessions.get(s.id);
      if (srv && authored?.has(srv.rev)) continue; // 本页自己写的：跳过 rev 锁
      const base = this._reviewSyncedRevs[s.id] ?? 0;
      if (!(s.rev > base)) continue;
      const sigConflict = assessServerReviewConflict(stored, payload);
      if (sigConflict && String(sigConflict.reason).startsWith('review-')) {
        return sigConflict;
      }
      if (srv && srv.rev !== base) {
        return { reason: 'review-advanced', sessionId: s.id, serverRev: srv.rev, session: srv };
      }
      if (!srv) continue; // 新会话：磁盘上没有（或尚未落盘），允许
      for (const n of s.nodes || []) {
        const bad = findReviewNodeDrift(n, stored);
        if (bad) return { reason: bad, sessionId: s.id, nodeKey: n.key, serverRev: srv.rev, session: srv };
      }
    }
    return null;
  }

  /**
   * localStorage 多页签通知中心冲突检测（离线 / 服务端不可用时的协调）。
   * 规则：本页自写 rev 不算外来推进；外来副本 rev 超过本页基线 → notify-rule-advanced。
   * 通知项：本页待改项在磁盘上已被另一页签改了状态 → notify-item-advanced（本地动作保留）。
   */
  _checkLocalNotifyConflict(stored, payload) {
    const storedRules = new Map((stored.notifyRules || []).map((r) => [r.id, r]));
    for (const r of payload.notifyRules || []) {
      const base = this._notifyRuleSyncedRevs[r.id] ?? 0;
      const clientRev = Math.max(r.rev || 0, r.deleteRev || 0);
      if (!(clientRev > base)) continue;
      if (this._notifyAuthoredRuleRevs.get(r.id)?.has(clientRev)) continue;
      const srv = storedRules.get(r.id);
      const srvRev = srv ? Math.max(srv.rev || 0, srv.deleteRev || 0) : 0;
      if (srvRev !== base && srvRev > base) {
        return { kind: 'rule', reason: 'notify-rule-advanced', ruleId: r.id, serverRev: srvRev, rule: srv || null };
      }
    }
    const storedItems = new Map((stored.notifications || []).map((n) => [n.id, n]));
    for (const n of payload.notifications || []) {
      const base = this._notifyItemBase.get(n.id);
      if (!base) continue;
      const srv = storedItems.get(n.id);
      // 防抖窗口内本页乐观动作可能尚未写入 localStorage：磁盘缺该项不算冲突（交给服务端 409）
      if (!srv) continue;
      // 磁盘状态与基线一致：无外来推进
      if (srv.status === base.status && (srv.ackedAt || null) === (base.ackedAt || null)) continue;
      // 磁盘状态是本页在【上一轮】已写入过的状态（如刚送达 delivered、刚确认 acknowledged），
      // 只是本次乐观动作又把本地推进到了更新状态：不是另一窗口的外来推进。
      if (this._notifyAuthoredItemStates.get(n.id)?.has(srv.status)) continue;
      return { kind: 'item', reason: 'notify-item-advanced', notifyId: n.id, serverStatus: srv.status, item: srv };
    }
    return null;
  }

  _sendLatest() {
    if (this.saveConflict) return this._saveChain;
    const v = this._saveVersion;
    this._flushedVersion = v;
    this._notifyBaseSeq = (this._notifyBaseSeq || 0) + 1;
    const myNotifySeq = this._notifyBaseSeq;
    this._saveChain = this._saveChain.then(async () => {
      if (v !== this._saveVersion || this.saveConflict) return;
      // 在保存链真正轮到本次请求时再快照：前一次 409 响应可能已在此 await 期间
      // 把会话基线更新到服务端 rev，不能复用入队时序列化出的过期请求。
      const baseHeads = {};
      for (const b of this.branches) {
        baseHeads[b.id] = b.id === this.currentBranchId
          ? (this._syncedHeads[b.id] ?? b.headEventId)
          : b.headEventId;
      }
      const payload = {
        ...this._payload(), baseRev: this.rev, baseHeads,
        baseReviewRevs: this._baseReviewRevs(),
        baseNotifyRuleRevs: this._baseNotifyRuleRevs(),
        baseNotifyItemRevs: this._baseNotifyItemRevs(),
        // 已终结 outbox 条目的墓碑（瞬态字段，不持久化进文档）：服务端合并时删除其旧副本
        notifyOutboxTombstones: [...this._notifyOutboxTombstones],
      };
      // 本页已终结（送达 / 确认 / 转交 / 陈旧清理）的队列条目绝不出现在载荷里：
      // 否则服务端跨 rev 合并（按 notifyId 并集）会把旧条目合回权威文档。
      if (this._notifyOutboxTombstones.size) {
        payload.notifyOutbox = (payload.notifyOutbox || [])
          .filter((o) => !this._notifyOutboxTombstones.has(o.id));
      }
      // 快照本次请求发出时的乐观动作：后续 409（可能在又一次保存清空 map 后才到达）
      // 用它恢复并保留本地未提交操作。
      const pendingSnapshot = new Map(this._notifyPendingItemActions);
      let body = JSON.stringify(payload);
      // 审阅冲突未解决：该会话的【本地过期内容】不外发（本地决定已保留为提案，等逐项
      // 合并 / 放弃）。但不能直接删除该会话——同 rev 直存时客户端文档即权威，删除会把
      // 服务端权威会话一并清掉。改为携带服务端最新副本（拿不到时才剔除，交给合并并集）。
      if (this.reviewConflict) {
        const cid = this.reviewConflict.sessionId;
        const serverDoc0 = await this._fetchDoc().catch(() => null);
        const serverSession = (serverDoc0?.reviewSessions || []).find((x) => x.id === cid);
        if (serverSession) {
          payload.reviewSessions = (payload.reviewSessions || []).map((x) => (x.id === cid ? serverSession : x));
        } else {
          payload.reviewSessions = (payload.reviewSessions || []).filter((x) => x.id !== cid);
        }
        delete payload.baseReviewRevs[cid];
        body = JSON.stringify(payload);
      }
      // 通知中心冲突未解决：冲突规则 / 通知项的【本地过期内容】不外发（本地未提交操作
      // 保留为 draft），其余通知 / 几何保存照常。携带服务端权威副本而非直接删除——
      // 同 rev 直存时客户端文档即权威，删除会清掉服务端仍存在的规则 / 通知项。
      if (this._hasNotifyLocks()) {
        const serverDoc0 = await this._fetchDoc().catch(() => null);
        if (this._notifyLockedRules.size) {
          const serverRules = new Map((serverDoc0?.notifyRules || []).map((r) => [r.id, r]));
          // 未锁定规则保留本地值；锁定规则替换为服务端权威副本（已在服务端删除则剔除）
          payload.notifyRules = (payload.notifyRules || []).filter((x) => !this._notifyLockedRules.has(x.id));
          for (const rid of this._notifyLockedRules) {
            if (serverRules.has(rid)) payload.notifyRules.push(serverRules.get(rid));
            delete payload.baseNotifyRuleRevs[rid];
          }
        }
        if (this._notifyLockedItems.size) {
          const locked = this._notifyLockedItems;
          const authoritative = new Map((serverDoc0?.notifications || []).map((n) => [n.id, n]));
          // 锁定项替换为服务端权威副本（拿不到 / 已删除则剔除）；其本地乐观转交派生项一并剔除
          const spawnedByLocked = new Set((payload.notifications || [])
            .filter((n) => n.transferOf && locked.has(n.transferOf)).map((n) => n.id));
          payload.notifications = (payload.notifications || [])
            .filter((n) => !locked.has(n.id) && !spawnedByLocked.has(n.id));
          for (const nid of locked) {
            if (authoritative.has(nid)) payload.notifications.push(authoritative.get(nid));
            delete payload.baseNotifyItemRevs[nid];
          }
          payload.notifyOutbox = (payload.notifyOutbox || []).filter((o) => {
            if (locked.has(o.notifyId) || spawnedByLocked.has(o.notifyId)) return false;
            const srv = authoritative.get(o.notifyId);
            return !srv || (srv.status === 'pending' || srv.status === 'sent');
          });
        }
        body = JSON.stringify(payload);
      }
      try {
        // 发请求前再次快照乐观动作：调用方可能在该保存入队后、实际发出前才执行确认/转交。
        const requestSnapshot = new Map([...pendingSnapshot, ...this._notifyPendingItemActions]);
        const res = await fetch(this.base + '/api/doc', {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body,
        });
        if (res.status === 409) {
          const data = await res.json().catch(() => ({}));
          if (typeof data?.sessionId === 'string' && String(data.reason || '').startsWith('review-')) {
            // 审阅冲突（会话 rev 前进 / 节点指纹变化 / 节点缺失 / 分支推进）：
            // 不锁定几何编辑，只锁定该会话；本地决定保留为 proposals，等待逐项合并
            this._onReviewConflict(data);
            return;
          }
          if (String(data.reason || '').startsWith('notify-')) {
            // 通知中心冲突：恢复请求快照里的乐观动作，再回滚权威状态并保留本地未提交操作
            for (const [pid, p] of requestSnapshot) {
              if (!this._notifyPendingItemActions.has(pid)) this._notifyPendingItemActions.set(pid, p);
              if (!this._notifyOptimisticLog.has(pid)) this._notifyOptimisticLog.set(pid, p);
            }
            this._onNotifyConflict(data);
            return;
          }
          this._onSaveConflict(data, Number.isFinite(data?.rev) ? data.rev : null);
          return;
        }
        if (!res.ok) { console.warn('保存失败', res.status); this._emit('saveerror', { status: res.status }); return; }
        const data = await res.json().catch(() => ({}));
        if (data.merged && data.doc) {
          // 与另一页面的不同分支编辑合流：先确认本页推进的审阅会话 rev 是否被服务端接受
          const rejectedReview = this._findRejectedReview(data.doc);
          if (rejectedReview) {
            // 审阅乐观锁失败（另一窗口推进了同一会话）：按 review 409 处理，本地决定保留
            this._onReviewConflict(rejectedReview);
            return;
          }
          // 与另一页面的不同分支编辑合流：采用合并后的权威文档
          const myReview = this.reviewSessions;
          const myActiveReview = this.activeReviewId;
          const myProposals = this._reviewProposals;
          const myNotifyLocks = { rules: new Set(this._notifyLockedRules), items: new Set(this._notifyLockedItems), conflict: this.notifyConflict };
          await this._adopt(data.doc, { seed: false, keepReviewConflict: true });
          // 合流可能把本页已终结（送达/确认/转交）的旧队列条目从服务端并回：按墓碑剔除
          if (this._notifyOutboxTombstones.size) {
            this.notifyOutbox = this.notifyOutbox.filter((o) => !this._notifyOutboxTombstones.has(o.id));
          }
          // 权威队列已删除的墓碑收敛清除；仍残留的继续随后续 PUT 重发
          this._reconcileOutboxTombstones(data.doc?.notifyOutbox || []);
          // 合流文档以服务端为准，但本页刚刚提交且未被服务端纳入的审阅决定要保留为待合并提案
          this._carryReviewProposals(myReview, myProposals, myActiveReview, data.doc);
          // 通知中心冲突锁在合流重载后继续保留（本地未提交操作不丢）
          if (myNotifyLocks.conflict) {
            this._notifyLockedRules = myNotifyLocks.rules;
            this._notifyLockedItems = myNotifyLocks.items;
            this.notifyConflict = myNotifyLocks.conflict;
          }
          this._dirty = false;
          this._emit('load');
          this._emit('saved', { rev: this.rev, merged: true });
          return;
        }
        if (Number.isFinite(data?.rev)) this.rev = data.rev;
        this._syncedHeads[this.currentBranchId] = this.branch.headEventId;
        // 审阅基线只前进到服务端确认接受的 rev：同 rev 直存时服务端文档 == 本页载荷，
        // 载荷中每个会话都是权威值；合流路径（data.merged）在 _carryReviewProposals 中
        // 严格按服务端文档重算，绝不在此把本地未确认的 rev 当作已同步基线。
        for (const s of this.reviewSessions) {
          this._reviewSyncedRevs[s.id] = s.rev;
          this._reviewAuthoredRevs.get(s.id)?.add(s.rev);
        }
        // 通知中心基线前进到服务端确认值（规则 rev / 通知项状态）
        for (const r of this.notifyRules) {
          this._notifyRuleSyncedRevs[r.id] = Math.max(r.rev || 0, r.deleteRev || 0);
          this._notifyAuthoredRuleRevs.get(r.id)?.add(Math.max(r.rev || 0, r.deleteRev || 0));
        }
        for (const n of payload.notifications || []) {
          // 只接受最新一次保存确认的通知项基线，避免旧请求（如送达）的晚到回调把基线
          // 从更新状态（如已确认）回退，导致下一次 PUT 误判 409。
          if (myNotifySeq >= (this._notifyBaseAppliedSeq || 0)) {
            this._notifyItemBase.set(n.id, { status: n.status, ackedAt: n.ackedAt ?? null });
          }
        }
        this._notifyBaseAppliedSeq = Math.max(this._notifyBaseAppliedSeq || 0, myNotifySeq);
        // 直存即权威：载荷 outbox 已剔除墓碑条目，服务端接受后这些墓碑完成使命
        this._notifyOutboxTombstones.clear();
        // 服务端确认后，载荷中的通知项都已成为已知项（下一次保存携带基线）
        for (const n of payload.notifications || []) this._notifyServerKnownItems.add(n.id);
        // 乐观日志保留到对应通知项被显式处理（确认/转交/放弃）或发生 409 后由 adopt 清理，
        // 不能在保存成功时就清空：in-app 送达的“成功保存”可能先于后续冲突响应到达。
        this.online = true;
        this._emit('saved', { rev: this.rev });
        this.flushOutbox().catch(() => {});
      } catch (e) {
        console.warn('保存失败（已写入 localStorage）:', e.message);
        this.online = false;
        this._emit('saveerror', {});
      }
    });
    return this._saveChain;
  }

  _onSaveConflict(info, serverRev) {
    if (this.saveConflict) return;
    const reason = info?.reason === 'branch-advanced' ? 'branch-advanced' : 'revision';
    if (!this._dirty) {
      // 本地没有未保存修改：静默跟随最新内容
      this.load().catch(() => {});
      return;
    }
    this.saveConflict = {
      reason,
      branchName: info?.branchName || this.branch?.name || '当前分支',
      headSeq: info?.headSeq ?? null,
      serverRev,
    };
    clearTimeout(this._saveTimer);
    this._emit('saveconflict', this.saveConflict);
    this._fetchDoc().then((doc) => {
      if (doc) try { localStorage.setItem(LS_KEY, JSON.stringify(doc)); } catch {}
    }).catch(() => {});
  }

  /** 测试/卸载时立即落盘并等待服务端确认 */
  async flushed() {
    let guard = 0;
    for (;;) {
      clearTimeout(this._saveTimer);
      const v = this._saveVersion;
      await this._sendLatest();
      if (this._saveVersion === v) break;
      if (++guard > 20) break;
    }
  }

  /* ---------- 分支 / 当前状态 ---------- */

  get branchesById() { return new Map(this.branches.map((b) => [b.id, b])); }
  get branch() {
    return this.branches.find((b) => b.id === this.currentBranchId)
      || this.branches.find((b) => b.id === MAIN_BRANCH);
  }
  get headEvent() {
    if (this.replayEventId) {
      const ev = this.eventsById.get(this.replayEventId);
      if (ev && !ev.corrupt) return ev;
    }
    if (this.replaySnapshot) return this.replaySnapshot;
    return this.eventsById.get(this.branch.headEventId);
  }
  get current() { return this.headEvent; }
  get model() {
    if (this.dragPreview) return this._dragModel;
    return this.headEvent.model;
  }
  get report() { return this.dragPreview || this.headEvent.report; }
  get replaying() {
    // 显式进入回放即只读（哪怕回放到的恰是 head 事件），直到 exitReplay
    if (this.replayEventId) {
      const ev = this.eventsById.get(this.replayEventId);
      if (ev && !ev.corrupt) return true;
    }
    return !!this.replaySnapshot;
  }
  /** 当前只读回放指向的描述（横幅/审计台共用）。 */
  get replayInfo() {
    if (this.replayEventId) {
      const ev = this.eventsById.get(this.replayEventId);
      if (ev && !ev.corrupt) {
        return { mode: 'event', eventId: ev.id, label: ev.label, actor: ev.actor, t: ev.t, hash: ev.hash };
      }
    }
    if (this.replaySnapshot) {
      const s = this.replaySnapshot;
      return {
        mode: s.__replayKind || 'snapshot',
        eventId: null,
        label: s.__replayLabel || '历史快照',
        actor: s.actor || '',
        t: s.t,
        hash: s.hash,
        side: s.__replaySide || 'after',
        originKey: s.__originKey || null,
      };
    }
    return null;
  }

  /* ---------- 修改 ---------- */

  /**
   * 提交一次修改：结构校验 + 环检测通过后，求解并【追加】一条不可变审计事件。
   * 返回 {ok, errors, cycle}；回放模式 / 冲突锁定 / 环 / 结构错误一律拒绝。
   */
  commit(mutator, { label = '编辑' } = {}) {
    if (this.replaying) {
      this._emit('replayblocked', {});
      return { ok: false, errors: ['回放模式为只读，请先退出回放或另存为新分支'], cycle: null };
    }
    if (this.saveConflict) {
      return { ok: false, errors: ['版本冲突未解决，请先重新加载'], cycle: null };
    }
    const parent = this.headEvent;
    const draft = structuredClone(parent.model);
    mutator(draft);

    const { errors } = validate(draft);
    if (errors.length) { this._emit('reject', { errors, cycle: null, label }); return { ok: false, errors, cycle: null }; }
    const cycle = findCycle(draft.constraints);
    if (cycle) { this._emit('reject', { errors: [], cycle, label }); return { ok: false, errors: [], cycle }; }

    const norm = normalize(draft);
    const report = solve(norm, null);
    for (const r of norm.rects) {
      const p = report.rects[r.id];
      if (p) { r.x = p.x; r.y = p.y; r.w = p.w; r.h = p.h; }
    }

    const ev = makeEvent(parent, this.currentBranchId, norm, report,
      { actor: this.actor || '未署名', label, t: Date.now() });
    this._appendEvent(ev, { newHead: true });
    this._dirty = true;
    this.persist();
    this._emit('change', { label, conflicts: report.conflicts });
    return { ok: true, errors: [], cycle: null, report };
  }

  _appendEvent(ev, { newHead }) {
    this.events = [...this.events, ev];
    this.eventsById.set(ev.id, ev);
    const b = this.branch;
    this._replaceBranch({
      ...b,
      headEventId: ev.id,
      redoTipId: newHead ? null : b.redoTipId,
    });
  }

  _replaceBranch(next) {
    this.branches = this.branches.map((b) => (b.id === next.id ? freeze(next) : b));
  }

  undo() {
    if (this.replaying || !this.canUndo) return;
    const b = this.branch;
    const cur = this.eventsById.get(b.headEventId);
    const tipWas = b.redoTipId || cur.id;
    this._replaceBranch({ ...b, headEventId: cur.parentId, redoTipId: tipWas });
    this.dragPreview = null;
    this._dirty = true;
    this.persist();
    this._emit('change', { label: 'undo' });
  }

  redo() {
    if (this.replaying || !this.canRedo) return;
    const b = this.branch;
    // redo 候选 = head 之后、沿 redoTip 向上走时其父为 head 的第一条（支线则取支线顶端）
    const nextId = this._redoNext(b);
    if (!nextId) return;
    // 走到 redoTip 顶端后清空候选；否则保持 tip 供继续 redo
    const redoTipId = nextId === b.redoTipId ? null : b.redoTipId;
    this._replaceBranch({ ...b, headEventId: nextId, redoTipId });
    this.dragPreview = null;
    this._dirty = true;
    this.persist();
    this._emit('change', { label: 'redo' });
  }

  _redoNext(b) {
    // 直接子事件（head 在 redoTip 链上）
    let tip = b.redoTipId ? this.eventsById.get(b.redoTipId) : null;
    if (!tip) {
      // 无 redoTip 时回退到全表查找 head 的直接子事件
      const kids = this.events.filter((e) => e.branch === b.id && e.parentId === b.headEventId);
      if (!kids.length) return null;
      kids.sort((a, c) => (a.t - c.t) || (a.id < c.id ? -1 : 1));
      return kids[0].id;
    }
    const chain = [];
    let cur = tip, guard = 0;
    while (cur && guard++ < 100000) {
      chain.push(cur);
      if (cur.id === b.headEventId) break;
      cur = cur.parentId ? this.eventsById.get(cur.parentId) : null;
    }
    if (!cur) {
      // redoTip 已不锚定 head：回退到全表
      const kids = this.events.filter((e) => e.branch === b.id && e.parentId === b.headEventId);
      if (!kids.length) return null;
      kids.sort((a, c) => (a.t - c.t) || (a.id < c.id ? -1 : 1));
      return kids[0].id;
    }
    return chain[chain.length - 2]?.id || null;
  }

  get canUndo() {
    if (this.replaying) return false;
    const cur = this.eventsById.get(this.branch.headEventId);
    return !!cur && cur.kind === 'edit' && !!cur.parentId;
  }
  get canRedo() {
    if (this.replaying) return false;
    return !!this._redoNext(this.branch);
  }

  /* ---------- 审计浏览 / 回放 / 分支 ---------- */

  setActor(name) {
    this.actor = String(name || '').slice(0, 40);
    try { localStorage.setItem(ACTOR_KEY, this.actor); } catch {}
  }

  timeline(branchId = this.currentBranchId) {
    const b = this.branches.find((x) => x.id === branchId);
    if (!b) return null;
    return timelineFor(b, this.eventsById, this.branchesById);
  }

  /** 进入只读回放：把画布重放到指定事件那一刻的完整布局。 */
  replay(eventId) {
    const ev = this.eventsById.get(eventId);
    if (!ev) return { ok: false, error: '审计事件不存在' };
    if (ev.corrupt || !ev.model || !ev.report) {
      return { ok: false, error: `该事件无法回放：${ev.corruptReason || '快照损坏'}` };
    }
    this.replayEventId = eventId;
    this.replaySnapshot = null;
    this.dragPreview = null;
    this._emit('replay', { eventId });
    this._emit('change', { label: 'replay' });
    return { ok: true };
  }

  /**
   * 通用快照只读回放：用于工作台查看“求解前”（父事件 / fork 来源 / 实验基准）
   * 等不属于审计链节点的完整模型。快照被克隆成伪事件，绝不写入审计流、绝不持久化。
   */
  replayEntry(entry, { label = '求解前快照', actor = '', t = 0, side = 'before', kind = 'snapshot', originKey = null } = {}) {
    if (!entry || !entry.model || !entry.report) return { ok: false, error: '该快照不可回放' };
    this.replaySnapshot = {
      id: `replay:${originKey || Math.random().toString(36).slice(2)}`,
      branch: null, parentId: null, kind: 'edit', seq: 0,
      t, actor: actor || '快照', label,
      model: structuredClone(entry.model),
      report: structuredClone(entry.report),
      hash: entry.hash || entry.report.hash,
      conflicts: structuredClone(entry.report.conflicts || []),
      __replayKind: kind, __replayLabel: label, __replaySide: side, __originKey: originKey,
    };
    this.replayEventId = null;
    this.dragPreview = null;
    this._emit('replay', { snapshot: true, originKey });
    this._emit('change', { label: 'replay-entry' });
    return { ok: true };
  }

  /** 退出回放，回到分支 head（不改写任何事件）。 */
  exitReplay() {
    if (!this.replayEventId && !this.replaySnapshot) return;
    this.replayEventId = null;
    this.replaySnapshot = null;
    this.dragPreview = null;
    this._emit('replayexit', {});
    this._emit('change', { label: 'replay-exit' });
  }

  /**
   * 从某条历史事件另存为新的编辑分支：
   * - fork-root 事件是来源快照的只读克隆（同指纹），带 provenance 来源关系；
   * - 原事件与原分支任何内容都不被改写。
   */
  forkFromEvent(eventId, name) {
    name = String(name ?? '').trim();
    if (!name) return { ok: false, error: '分支名称不能为空' };
    if (this.branches.some((b) => b.name === name)) return { ok: false, error: `已存在同名分支「${name}」` };
    const source = this.eventsById.get(eventId);
    if (!source || source.corrupt || !source.model) return { ok: false, error: '该事件损坏，无法另存为分支' };
    const sourceBranch = this.branches.find((b) => b.id === source.branch)
      || (source.provenance ? this.branches.find((b) => b.id === source.provenance.branchId) : null);

    const id = uid('b');
    const root = makeForkRootEvent(id, source, sourceBranch || { id: source.branch, name: source.branch },
      { actor: this.actor || '未署名' });
    this.events = [...this.events, root];
    this.eventsById.set(root.id, root);
    const branch = freeze({
      id, name, createdAt: root.t,
      rootEventId: root.id, headEventId: root.id, redoTipId: null,
      source: { branchId: sourceBranch?.id || source.branch, eventId: source.id },
    });
    this.branches = [...this.branches, branch];
    this.currentBranchId = id;
    this.replayEventId = null;
    this.replaySnapshot = null;
    this._syncedHeads[id] = root.id;
    this._dirty = true;
    this.persist();
    this._emit('branch', { type: 'fork', id, sourceEventId: eventId });
    this._emit('change', { label: 'fork' });
    return { ok: true, branch, event: root };
  }

  switchBranch(id) {
    const b = this.branches.find((x) => x.id === id);
    if (!b || id === this.currentBranchId) return { ok: false };
    this.currentBranchId = id;
    this.replayEventId = null;
    this.replaySnapshot = null;
    this.dragPreview = null;
    this._dirty = true; // 记住用户最后停留的分支
    this.persist();
    this._emit('branch', { type: 'switch', id });
    this._emit('change', { label: 'switch-branch' });
    return { ok: true };
  }

  /** 比较两个分支的当前 head（矩形/约束/冲突差异）。 */
  compareBranches(aId, bId) {
    const a = this.eventsById.get(this.branches.find((b) => b.id === aId)?.headEventId);
    const b2 = this.eventsById.get(this.branches.find((b) => b.id === bId)?.headEventId);
    if (!a || !b2) return null;
    return compareVersions(
      { model: a.model, report: a.report, hash: a.hash },
      { model: b2.model, report: b2.report, hash: b2.hash },
    );
  }

  setBranchCompare(a, b) {
    this.branchCompare = { a: a || null, b: b || null };
    this._dirty = true;
    this.persist();
    this._emit('branch', { type: 'compare' });
  }

  /* ---------- 实验审计工作台（视图状态持久化） ---------- */

  /** 当前文档对应的统一时间线（纯函数，每次重建且确定）。 */
  workbench() {
    return buildWorkbench({
      events: this.events, eventsById: this.eventsById,
      branches: this.branches, branchesById: this.branchesById,
      experiments: this.experiments,
    });
  }

  /**
   * 更新工作台视图状态（筛选 / 光标 / 前后面 / 详情展开 / 播放 / 速度）。
   * 只合并提供的字段；persist 控制是否落盘（播放自动推进时节流调用）。
   */
  setWorkbench(patch = {}, { persist = true } = {}) {
    const prev = this.auditWorkbench;
    const next = {
      filter: { ...prev.filter, ...(patch.filter || {}) },
      cursorKey: patch.cursorKey !== undefined ? patch.cursorKey : prev.cursorKey,
      side: patch.side !== undefined ? patch.side : prev.side,
      detailOpen: patch.detailOpen !== undefined ? patch.detailOpen : prev.detailOpen,
      playing: patch.playing !== undefined ? !!patch.playing : prev.playing,
      speedMs: patch.speedMs !== undefined ? patch.speedMs : prev.speedMs,
    };
    this.auditWorkbench = next;
    if (persist) {
      this._dirty = true;
      this.persist();
    }
    this._emit('workbench', { patch });
    return next;
  }

  /**
   * 把画布重放到工作台节点的指定面（after=求解后 / before=求解前）。
   * 不可回放节点被拒绝（其余节点仍可查看）；事件节点走事件回放，变体/求解前走快照回放。
   */
  showWorkbenchNode(node, side = 'after') {
    if (!node || !node.replayable) {
      return { ok: false, error: `节点「${node?.title || '?'}」不可回放（记录仍保留可查看）` };
    }
    const wantBefore = side === 'before';
    if (wantBefore) {
      const base = node.baseEntry;
      if (!base) return { ok: false, error: '该节点没有可回放的“求解前”状态（初始事件 / 基准损坏 / 来源缺失）' };
      const originName = node.kind === 'experiment-variant'
        ? `实验「${node.experiment.name}」基准` : '求解前';
      const res = this.replayEntry(base, {
        label: `${originName} · ${node.title}`,
        actor: node.actor, t: node.t, side: 'before',
        kind: node.kind === 'experiment-variant' ? 'variant-baseline' : 'event-before',
        originKey: node.key,
      });
      if (!res.ok) return res;
    } else if (node.kind === 'edit-event') {
      const res = this.replay(node.fork.eventId);
      if (!res.ok) return res;
    } else {
      const res = this.replayEntry(node.entry, {
        label: node.title, actor: node.actor, t: node.t, side: 'after',
        kind: 'variant-result', originKey: node.key,
      });
      if (!res.ok) return res;
    }
    this.setWorkbench({ cursorKey: node.key, side: wantBefore ? 'before' : 'after' });
    return { ok: true };
  }

  /* ---------- 可恢复审阅会话 ---------- */

  _baseReviewRevs() {
    const out = {};
    for (const s of this.reviewSessions) {
      out[s.id] = this._reviewSyncedRevs[s.id] ?? 0; // 未知会话（本次新建）基线为 0
    }
    return out;
  }

  get activeReview() {
    return this.reviewSessions.find((x) => x.id === this.activeReviewId) || null;
  }

  reviewSessionById(id) { return this.reviewSessions.find((x) => x.id === id) || null; }

  /**
   * 会话视图：用当前统一时间线对会话做一次确定性对账（不写入、不持久化），
   * 返回 { session（已对账）, filteredNow, newNodes, baselineChanged, currentHash, driftByKey, byKey, progress }。
   */
  reviewView(id = this.activeReviewId) {
    const session = this.reviewSessions.find((x) => x.id === id);
    if (!session) return null;
    const view = reconcileSession(session, this.workbench());
    view.progress = sessionProgress(view.session);
    return view;
  }

  /** 从当前筛选结果创建审阅会话（快照：筛选条件 + 顺序 + 每节点指纹）。 */
  createReview(name, { setActive = true, policy = null } = {}) {
    if (this.saveConflict) return { ok: false, error: '版本冲突未解决，请先重新加载' };
    const w = this.workbench();
    const nodes = filterNodes(w.nodes, this.auditWorkbench.filter);
    if (!nodes.length) return { ok: false, error: '当前筛选结果为空，无法创建审阅会话' };
    const policyCheck = validateReviewPolicy(policy);
    if (!policyCheck.ok) return { ok: false, error: policyCheck.error };
    const session = createReviewSession({
      name, actor: this.actor, filter: this.auditWorkbench.filter, nodes,
      branches: this.branches, now: Date.now(), policy: policyCheck.policy,
    });
    this.reviewSessions = [...this.reviewSessions, session];
    this._reviewSyncedRevs[session.id] = 0; // HTTP 首次保存：服务端尚无此会话（base=0）
    if (!this._reviewAuthoredRevs.has(session.id)) this._reviewAuthoredRevs.set(session.id, new Set());
    this._reviewAuthoredRevs.get(session.id).add(session.rev); // 本地自创会话：自己的 rev1 不是外来推进
    this.pumpNotify({});
    if (setActive) this.activeReviewId = session.id;
    this._dirty = true;
    this.persist();
    // 首次保存确认后以服务端 rev 为基线（_sendLatest 的 saved 分支统一同步）
    this._emit('reviews', { type: 'create', id: session.id });
    return { ok: true, session };
  }

  selectReview(id) {
    if (id && !this.reviewSessions.some((x) => x.id === id)) return { ok: false };
    this.activeReviewId = id || null;
    this._dirty = true;
    this.persist();
    this._emit('reviews', { type: 'select', id });
    return { ok: true };
  }

  /**
   * 记录节点决定（通过 / 驳回 / 待复核 + 理由）。
   * 节点损坏/缺失/指纹变化/分支推进、或筛选基线已漂移 → 409：
   * 本地决定保留在 reviewProposals，不写入会话，等待逐项合并 / 刷新基线。
   * 会话本身被另一窗口推进（乐观锁失败）由服务端异步 409 同样处理。
   */
  submitReviewDecision(id, nodeKey, decision, reason) {
    const session = this.reviewSessions.find((x) => x.id === id);
    if (!session) return { ok: false, status: 409, error: '会话不存在（可能已被其他页面删除）' };
    if (this.reviewConflict?.sessionId === id) {
      const p = this._stashProposal(id, nodeKey, decision, reason);
      return { ok: false, status: 409, reason: this.reviewConflict.reason, conflict: this.reviewConflict, proposal: p };
    }
    const view = this.reviewView(id);
    const res = recordDecision(session, view, nodeKey, decision, reason, { actor: this.actor });
    if (res.status !== 200) {
      const p = this._stashProposal(id, nodeKey, decision, reason);
      return { ok: false, status: 409, reason: res.reason, codes: res.codes, proposal: p };
    }
    this._replaceReview(res.session);
    this._dirty = true;
    this.persist();
    this._emit('reviews', { type: 'decision', id, nodeKey });
    return { ok: true, session: res.session };
  }

  /**
   * 多人签署：先校验允许名单与当前节点快照，再把“决定 + 签名”作为一条不可拆分记录保存。
   * 重复签名幂等；409 时本地签名完整保留（含签名 id/理由/签署人），可逐项合并。
   */
  submitReviewSignature(id, nodeKey, decision, reason) {
    const session0 = this.reviewSessions.find((x) => x.id === id);
    if (!session0) return { ok: false, status: 409, error: '会话不存在（可能已被其他页面删除）' };
    const policy = normalizeReviewPolicy(session0.policy);
    if (policy.mode !== 'signoff') return { ok: false, status: 400, reason: 'legacy-decision-required' };
    const proposal = makeSignatureProposal(nodeKey, decision, reason, { actor: this.actor });
    if (!isAllowedSigner(policy, this.actor)) {
      return { ok: false, status: 403, reason: 'signer-not-allowed', allowed: policy.signers, proposal: null };
    }
    if (this.reviewConflict?.sessionId === id) {
      const p = this._stashSignatureProposal(id, proposal);
      return { ok: false, status: 409, reason: this.reviewConflict.reason, conflict: this.reviewConflict, proposal: p };
    }
    const view = this.reviewView(id);
    const res = signReviewNode(session0, view, nodeKey, decision, reason, { actor: this.actor });
    if (res.status === 403) return { ok: false, ...res };
    if (res.status !== 200) {
      const p = this._stashSignatureProposal(id, proposal);
      return { ok: false, status: res.status, reason: res.reason, codes: res.codes, proposal: p };
    }
    if (!res.idempotent) this._replaceReview(res.session);
    this._dirty = true;
    this.persist();
    this._emit('reviews', { type: 'signature', id, nodeKey, idempotent: !!res.idempotent, signature: res.signature });
    return { ok: true, idempotent: !!res.idempotent, session: res.session, signature: res.signature };
  }

  _stashSignatureProposal(id, proposal) {
    const list = this._reviewProposals.get(id) || [];
    // 同一签署人/决定/理由的重复 409 不制造多条本地提案；不同人或不同决定逐项保留。
    const dup = list.some((p) => p.type === 'signature' && p.sig?.id === proposal.sig.id)
      || list.some((p) => p.type === 'signature' && p.nodeKey === proposal.nodeKey
        && p.by === proposal.by && p.decision === proposal.decision && p.reason === proposal.reason);
    if (!dup) list.push(proposal);
    this._reviewProposals.set(id, list);
    this._emit('reviews', { type: 'proposal', id, nodeKey: proposal.nodeKey });
    return proposal;
  }

  _stashProposal(id, nodeKey, decision, reason) {
    const p = { nodeKey, decision, reason: String(reason || '').slice(0, 2000), by: this.actor || '未署名', at: Date.now(), rejected: true };
    const list = this._reviewProposals.get(id) || [];
    list.push(p);
    this._reviewProposals.set(id, list);
    this._emit('reviews', { type: 'proposal', id, nodeKey });
    return p;
  }

  /** 409 后逐项合并：多人会话合入本地签名；单人会话强制落到最新快照的决定。 */
  mergeReviewItem(id, nodeKey, decision, reason, options = {}) {
    const session = this.reviewSessions.find((x) => x.id === id);
    if (!session) return { ok: false, error: '会话不存在' };
    if (normalizeReviewPolicy(session.policy).mode === 'signoff') {
      return this.mergeReviewSignature(id, options.proposal?.sig || null, nodeKey, decision, reason, {
        by: options.by || options.proposal?.by || this.actor,
      });
    }
    const res = mergeReviewItem(session, nodeKey, decision, reason, { actor: this.actor, resolution: 'merged-local' });
    if (res.status !== 200) return { ok: false, error: res.reason };
    this._replaceReview(res.session);
    // 该节点的本地保留提案已被采用
    const list = (this._reviewProposals.get(id) || []).filter((p) => p.nodeKey !== nodeKey);
    this._reviewProposals.set(id, list);
    this._clearReviewConflictIfResolved(id);
    this._dirty = true;
    this.persist();
    this._emit('reviews', { type: 'merge-item', id, nodeKey });
    return { ok: true, session: res.session };
  }

  mergeReviewSignature(id, sig, nodeKey, decision, reason, { by = this.actor } = {}) {
    const session = this.reviewSessions.find((x) => x.id === id);
    if (!session) return { ok: false, error: '会话不存在' };
    const view = this.reviewView(id);
    const actor = by || this.actor;
    const res = mergeReviewSignature(session, view, nodeKey, decision, reason, { actor });
    if (res.status === 403) return { ok: false, status: 403, reason: res.reason, allowed: res.allowed };
    if (res.status !== 200) {
      const p = this._stashSignatureProposal(id, sig || makeSignatureProposal(nodeKey, decision, reason, { actor }));
      return { ok: false, status: res.status, reason: res.reason, codes: res.codes, proposal: p };
    }
    if (!res.idempotent) this._replaceReview(res.session);
    const sigId = res.signature?.id || sig?.id;
    const list = (this._reviewProposals.get(id) || []).filter((p) => {
      if (p.type !== 'signature' || p.nodeKey !== nodeKey) return true;
      if (sigId && p.sig?.id === sigId) return false;
      // 合并时签名 id 可能由纯函数重新生成；同一签署人/决定/理由的提案视为已采用。
      if (p.by === actor && p.decision === decision && p.reason === res.signature?.reason) return false;
      return true;
    });
    this._reviewProposals.set(id, list);
    this._clearReviewConflictIfResolved(id);
    this._dirty = true;
    this.persist();
    this._emit('reviews', { type: 'merge-signature', id, nodeKey });
    return { ok: true, idempotent: !!res.idempotent, session: res.session, signature: res.signature };
  }

  /** 放弃本地保留的某条决定/签名（采用服务端最新值）。 */
  discardReviewProposal(id, nodeKey, { signatureId = null } = {}) {
    const list = (this._reviewProposals.get(id) || []).filter((p) => {
      if (p.nodeKey !== nodeKey) return true;
      if (signatureId) return !(p.type === 'signature' && p.sig?.id === signatureId);
      return false;
    });
    this._reviewProposals.set(id, list);
    this._clearReviewConflictIfResolved(id);
    this._emit('reviews', { type: 'proposal-discard', id, nodeKey });
    return { ok: true };
  }

  reviewProposals(id = this.activeReviewId) {
    return this._reviewProposals.get(id) || [];
  }

  /**
   * 刷新审阅基线到当前筛选结果：保留全部决定与变更历史，新节点成为未处理项，
   * 缺失节点保留在末尾；关闭基线级 / 指纹级冲突（仍损坏 / 缺失 / 支线的节点保留转待复核标注）。
   */
  rebaseReview(id) {
    const session = this.reviewSessions.find((x) => x.id === id);
    if (!session) return { ok: false, error: '会话不存在' };
    if (this.reviewConflict?.sessionId === id && this.reviewConflict.reason === 'review-advanced') {
      return { ok: false, error: '该会话已在另一窗口前进，请先逐项合并或放弃本地决定后再刷新基线' };
    }
    const view = this.reviewView(id);
    const next = rebaseSession(session, view, { actor: this.actor });
    this._replaceReview(next);
    this._clearReviewConflictIfResolved(id, { forceBaseline: true });
    this._dirty = true;
    this.persist();
    this._emit('reviews', { type: 'rebase', id });
    return { ok: true, session: next, added: view.newNodes.length };
  }

  completeReview(id) {
    const session = this.reviewSessions.find((x) => x.id === id);
    if (!session) return { ok: false, error: '会话不存在' };
    const view = this.reviewView(id);
    const res = completeReview(session, view);
    if (res.status !== 200) {
      return { ok: false, error: res.reason === 'has-reject'
        ? `完成条件不允许存在驳回（${res.pending} 个节点驳回）`
        : `还有 ${res.pending} 个节点未完成签署（含系统转待复核）` };
    }
    this._replaceReview(res.session);
    this._dirty = true;
    this.persist();
    this._emit('reviews', { type: 'complete', id });
    return { ok: true, session: res.session };
  }

  reopenReview(id) {
    const session = this.reviewSessions.find((x) => x.id === id);
    if (!session) return { ok: false, error: '会话不存在' };
    const now = Date.now();
    const res = reopenReview(session, { now });
    this._replaceReview(res.session);
    // 重开无法从最终状态稳定派生：显式注入一次 session-reopened 事件（id 幂等）
    this._appendNotifyEvent({
      id: notifyEventId([id, 'session-reopened', now]),
      sessionId: id, nodeKey: null, type: 'session-reopened',
      at: now, actor: this.actor || '未署名', title: res.session.name || id,
    });
    this.pumpNotify({ now });
    this._dirty = true;
    this.persist();
    this._emit('reviews', { type: 'reopen', id });
    return { ok: true, session: res.session };
  }

  /** 当前会话完整审阅报告（快照 + 进度 + 每节点决定/理由/变更 + 冲突记录）。 */
  reviewReport(id = this.activeReviewId, { generatedAt = null } = {}) {
    const session = this.reviewSessions.find((x) => x.id === id);
    if (!session) return null;
    return buildReviewReport(session, this.reviewView(id), { generatedAt });
  }

  _replaceReview(session) {
    this.reviewSessions = this.reviewSessions.map((x) => (x.id === session.id ? session : x));
    // 审阅决定 / 签名 / 冲突对账可能产生新通知事件：派生并物化（纯函数，幂等）
    this.pumpNotify({});
  }

  /** 追加一条显式通知事件（如会话重开，无法从最终状态稳定派生），按 id 幂等。 */
  _appendNotifyEvent(ev) {
    if (this.notifyEvents.some((x) => x.id === ev.id)) return;
    this.notifyEvents = [...this.notifyEvents, ev].sort((a, b) => (a.at - b.at) || (a.id < b.id ? -1 : 1));
  }

  _clearReviewConflictIfResolved(id, { forceBaseline = false } = {}) {
    const c = this.reviewConflict;
    if (!c || c.sessionId !== id) return;
    if (forceBaseline || !(this._reviewProposals.get(id) || []).length) {
      this.reviewConflict = null;
    }
  }

  /** 服务端 409（review-*）：不锁定几何编辑，只锁定该会话；本地决定保留为提案。 */
  _onReviewConflict(info) {
    const id = info.sessionId;
    const mine = this.reviewSessions.find((x) => x.id === id);
    // 409 响应可能附带服务端最新会话（同 rev 冲突路径）；否则立即 GET 权威文档
    const adoptServerSession = (serverSession) => {
      if (!serverSession) return;
      const localDecisions = new Map((mine?.nodes || [])
        .filter((n) => n.decision !== 'pending')
        .map((n) => [n.key, n]));
      const revsed = sanitizeReviewSessions([serverSession], this.workbench())[0];
      // 保留本地（被拒）决定/签名：单人节点按决定保留；多人节点按本地有效签名逐条保留。
      const kept = [];
      for (const [key, n] of localDecisions) {
        const srv = revsed?.nodes.find((x) => x.key === key);
        if (normalizeReviewPolicy(mine.policy).mode === 'signoff') continue;
        if (!srv || srv.decision !== n.decision) {
          kept.push({ nodeKey: key, decision: n.decision, reason: n.reason, by: n.decidedBy || this.actor, at: Date.now(), rejected: true });
        }
      }
      for (const n of mine?.nodes || []) {
        if (normalizeReviewPolicy(mine.policy).mode !== 'signoff') continue;
        const srv = revsed?.nodes.find((x) => x.key === n.key);
        const remoteIds = new Set((srv?.signatures || []).map((s) => s.id));
        for (const sg of activeSignatures(n)) {
          if (remoteIds.has(sg.id)) continue;
          kept.push({
            type: 'signature', nodeKey: n.key, decision: sg.decision, reason: sg.reason || '',
            by: sg.by, at: Date.now(), rejected: true, sig: { ...sg },
          });
        }
      }
      const existing = this._reviewProposals.get(id) || [];
      const keyOf = (p) => `${p.type || 'decision'}|${p.nodeKey}|${p.by || ''}|${p.decision}|${p.reason || ''}|${p.sig?.id || ''}`;
      const keys = new Set(existing.map(keyOf));
      for (const p of kept) if (!keys.has(keyOf(p))) existing.push(p);
      this._reviewProposals.set(id, existing);
      this.reviewSessions = this.reviewSessions.map((x) => (x.id === id ? revsed : x));
      // 以服务端最新 rev 为新基线：下一次逐项合并携带正确的 baseReviewRevs
      this._reviewSyncedRevs[id] = revsed.rev;
      this._reviewAuthoredRevs.delete(id);
    };
    adoptServerSession(info.session || null);
    this.reviewConflict = {
      sessionId: id,
      reason: info.reason,
      nodeKey: info.nodeKey || null,
      serverRev: info.serverRev ?? null,
      at: Date.now(),
    };
    if (!info.session) {
      this._fetchDoc().then((doc) => {
        if (!doc) return;
        const srv = (Array.isArray(doc.reviewSessions) ? doc.reviewSessions : []).find((x) => x.id === id);
        if (srv) {
          adoptServerSession(srv);
          this._emit('reviews', { type: 'conflict', id });
        }
      }).catch(() => {});
    }
    this._emit('reviews', { type: 'conflict', id });
  }

  /**
   * 合流响应里是否有本页推进过、但服务端合并结果并未接纳的会话。
   * 真实 server.py 会在合流前先用 _assess_review_conflict 返回 409；这里是客户端防御，
   * 兼容“文档级合并但会话按 rev 取服务端值”的响应，以及本地 rev 与服务端 rev 数字
   * 恰好相同但内容不同（另一窗口也推进到该 rev）的竞态。
   */
  _findRejectedReview(serverDoc) {
    const byId = new Map((serverDoc.reviewSessions || []).map((x) => [x.id, x]));
    for (const mine of this.reviewSessions) {
      const base = this._reviewSyncedRevs[mine.id] ?? 0;
      if (!(mine.rev > base)) continue;
      const srv = byId.get(mine.id);
      if (!srv) continue; // 全新会话不可能出现在旧服务端文档
      const mineByKey = new Map(mine.nodes.map((n) => [n.key, n]));
      let differs = false;
      for (const n of srv.nodes || []) {
        const m = mineByKey.get(n.key);
        if (!m) continue;
        if (normalizeReviewPolicy(mine.policy).mode === 'signoff') {
          const remoteSig = new Set(activeSignatures(n).map((s) => `${s.by}|${s.decision}|${s.reason || ''}`));
          if (activeSignatures(m).some((s) => !remoteSig.has(`${s.by}|${s.decision}|${s.reason || ''}`))) { differs = true; break; }
        } else if (m.decision !== 'pending' && (m.decision !== n.decision || m.reason !== n.reason)) { differs = true; break; }
      }
      if (srv.rev < mine.rev || (srv.rev === mine.rev && differs)) {
        return { reason: 'review-advanced', sessionId: mine.id, serverRev: srv.rev, session: srv };
      }
    }
    return null;
  }

  /** 跨分支合流（merged 响应）后，把本页已提交但未纳入合流文档的审阅决定保留为提案。 */
  _carryReviewProposals(mySessions, myProposals, myActiveId, mergedDoc) {
    const serverSessions = new Map((mergedDoc.reviewSessions || []).map((s) => [s.id, s]));
    for (const mine of mySessions) {
      const srv = serverSessions.get(mine.id);
      // 基线严格以服务端为准：本页本地 rev 即便数字相同也不代表内容被服务端接受
      this._reviewSyncedRevs[mine.id] = srv ? srv.rev : (this._reviewSyncedRevs[mine.id] ?? 0);
      this._reviewAuthoredRevs.delete(mine.id);
      const kept = [];
      if (normalizeReviewPolicy(mine.policy).mode === 'signoff') {
        for (const n of mine.nodes) {
          const on = srv?.nodes.find((x) => x.key === n.key);
          const remoteSig = new Set(activeSignatures(on || {}).map((s) => `${s.by}|${s.decision}|${s.reason || ''}`));
          for (const sg of activeSignatures(n)) {
            if (remoteSig.has(`${sg.by}|${sg.decision}|${sg.reason || ''}`)) continue;
            kept.push({
              type: 'signature', nodeKey: n.key, decision: sg.decision, reason: sg.reason || '',
              by: sg.by, at: Date.now(), rejected: true, sig: { ...sg },
            });
          }
        }
      } else {
        for (const n of mine.nodes) {
          if (n.decision === 'pending') continue;
          const on = srv?.nodes.find((x) => x.key === n.key);
          if (!on || on.decision !== n.decision || on.reason !== n.reason) {
            kept.push({ nodeKey: n.key, decision: n.decision, reason: n.reason, by: n.decidedBy || this.actor, at: Date.now(), rejected: true });
          }
        }
      }
      const prev = myProposals.get(mine.id) || [];
      const keyOf = (p) => `${p.type || 'decision'}|${p.nodeKey}|${p.by || ''}|${p.decision}|${p.reason || ''}|${p.sig?.id || ''}`;
      const seen = new Set(prev.map(keyOf));
      const all = [...prev];
      for (const p of kept) {
        const k = keyOf(p);
        if (!seen.has(k)) { seen.add(k); all.push(p); }
      }
      if (all.length) this._reviewProposals.set(mine.id, all);
    }
    if (myActiveId && this.reviewSessions.some((x) => x.id === myActiveId)) this.activeReviewId = myActiveId;
  }

  /* ==================== 审阅通知与升级中心 ==================== */

  _baseNotifyRuleRevs() {
    const out = {};
    for (const r of this.notifyRules) out[r.id] = this._notifyRuleSyncedRevs[r.id] ?? 0;
    return out;
  }

  _baseNotifyItemRevs() {
    // 只为服务端已知（已随某次保存确认）的通知项携带基线；全新物化的项不带 base，
    // 否则服务端会把“基线有、服务端无”的新项误判为 notify-item-missing。
    const out = {};
    for (const n of this.notifications) {
      const base = this._notifyItemBase.get(n.id);
      if (base && this._notifyServerKnownItems.has(n.id)) out[n.id] = base;
    }
    return out;
  }

  _hasNotifyLocks() {
    return (this._notifyLockedRules?.size || 0) > 0 || (this._notifyLockedItems?.size || 0) > 0;
  }

  notifyRuleById(id) { return this.notifyRules.find((r) => r.id === id) || null; }
  notificationById(id) { return this.notifications.find((n) => n.id === id) || null; }

  _markAuthoredItem(id, status) {
    if (!id || !status) return;
    const set = this._notifyAuthoredItemStates.get(id) || new Set();
    set.add(status);
    this._notifyAuthoredItemStates.set(id, set);
  }

  /**
   * 修剪队列：引用已不存在 / 已终态（送达·确认·转交·稍后·取消）通知项的条目移除并立墓碑。
   * 确认 / 转交 / 心跳后调用，保证已处理项不再发送，且不会被本地合流的旧队列副本复活。
   */
  _pruneNotifyOutbox() {
    const dead = [];
    for (const o of this.notifyOutbox) {
      const it = this.notifications.find((x) => x.id === o.notifyId);
      if (!it || !['pending', 'sent'].includes(it.status)) dead.push(o.id);
    }
    if (dead.length) this._removeOutboxEntries(dead);
  }

  /**
   * 从 FIFO 队列移除条目并记录墓碑：送达 / 确认 / 转交 / 陈旧清理都走这里。
   * 墓碑保证随后 persist() 与 localStorage / 服务端旧值做并集合流时，
   * 本页已终结的条目不会被磁盘上的旧副本「复活」（他页新增的新条目 id 不同，不受影响）。
   */
  _removeOutboxEntries(ids) {
    const dead = new Set(Array.isArray(ids) ? ids : [ids]);
    if (!dead.size) return;
    for (const id of dead) this._notifyOutboxTombstones.add(id);
    this.notifyOutbox = this.notifyOutbox.filter((o) => !dead.has(o.id));
  }

  /**
   * 保存被服务端接受后收敛墓碑：只清除「权威文档确实不再持有」的条目墓碑；
   * 仍残留在权威队列里的墓碑继续带给后续请求，直到服务端删除为止。
   */
  _reconcileOutboxTombstones(serverOutbox) {
    if (!this._notifyOutboxTombstones.size) return;
    const live = new Set((Array.isArray(serverOutbox) ? serverOutbox : []).map((o) => o.id));
    for (const id of [...this._notifyOutboxTombstones]) if (!live.has(id)) this._notifyOutboxTombstones.delete(id);
  }

  /** 当前操作者的待处理通知（页面内确认 / 稍后 / 转交）。 */
  notifyInbox(recipient = this.actor) {
    return pendingInbox(this.notifications, recipient, { now: Date.now() });
  }

  notifyCounters(recipient = null) {
    return notificationCounters(this.notifications, recipient);
  }

  /** 会话的完整通知时间线报告。 */
  notifyReport(sessionId, { generatedAt = null } = {}) {
    return buildNotifyReport(sessionId, {
      rules: this.notifyRules, events: this.notifyEvents, items: this.notifications,
      outbox: this.notifyOutbox, sessions: this.reviewSessions, generatedAt,
    });
  }

  /* ---------- 规则配置 ---------- */

  saveNotifyRule(sessionId, spec, { editId = null } = {}) {
    if (this.saveConflict) return { ok: false, error: '版本冲突未解决，请先重新加载' };
    if (!this.reviewSessionById(sessionId)) return { ok: false, error: '审阅会话不存在，无法配置通知规则' };
    const now = Date.now();
    if (editId) {
      const old = this.notifyRuleById(editId);
      if (!old) return { ok: false, error: '规则不存在（可能已被其他页面删除）' };
      if (this._notifyLockedRules.has(editId)) {
        const draft = { kind: 'rule', ruleId: editId, spec, at: now, by: this.actor };
        this._stashNotifyDraft(editId, draft);
        return { ok: false, status: 409, reason: 'notify-rule-advanced', conflict: this.notifyConflict, draft };
      }
      let rule;
      try { rule = editRule(old, spec, { now }); } catch (e) { return { ok: false, error: e.message }; }
      this.notifyRules = this.notifyRules.map((x) => (x.id === editId ? rule : x));
      this.pumpNotify({ now });
      this._dirty = true;
      this.persist();
      this._emit('notify', { type: 'rule-edit', id: editId });
      return { ok: true, rule };
    }
    let rule;
    try {
      rule = createRule({
        sessionId, name: spec.name, triggers: spec.triggers, levels: spec.levels,
        actor: this.actor || '未署名', now,
      });
    } catch (e) { return { ok: false, error: e.message }; }
    this.notifyRules = [...this.notifyRules, rule];
    this._notifyRuleSyncedRevs[rule.id] = 0; // HTTP 首次保存：服务端尚无此规则
    if (!this._notifyAuthoredRuleRevs.has(rule.id)) this._notifyAuthoredRuleRevs.set(rule.id, new Set());
    this._notifyAuthoredRuleRevs.get(rule.id).add(rule.rev);
    this.pumpNotify({ now });
    this._dirty = true;
    this.persist();
    this._emit('notify', { type: 'rule-create', id: rule.id });
    return { ok: true, rule };
  }

  /** 启用 / 停用：暂停 / 恢复语义，不推进 rev、不移动 revisedAt。 */
  toggleNotifyRule(id, enabled) {
    const old = this.notifyRuleById(id);
    if (!old) return { ok: false, error: '规则不存在' };
    const rule = editRule(old, { enabled: enabled !== false }, { now: Date.now() });
    this.notifyRules = this.notifyRules.map((x) => (x.id === id ? rule : x));
    this.pumpNotify({});
    this._dirty = true;
    this.persist();
    this._emit('notify', { type: 'rule-toggle', id });
    return { ok: true, rule };
  }

  removeNotifyRule(id) {
    const old = this.notifyRuleById(id);
    if (!old || old.deleted) return { ok: false, error: '规则不存在' };
    const rule = deleteRule(old, { now: Date.now() });
    this.notifyRules = this.notifyRules.map((x) => (x.id === id ? rule : x));
    this._dirty = true;
    this.persist();
    this._emit('notify', { type: 'rule-delete', id });
    return { ok: true, rule };
  }

  /* ---------- 通知项操作：确认 / 稍后 / 转交 / 重排 ---------- */

  _applyNotifyItemAction(id, action, payload = {}, { stashOnConflict = true } = {}) {
    const now = Date.now();
    const by = this.actor || '未署名';
    const before = this.notifications;
    let res;
    if (action === 'ack') res = acknowledgeNotification(before, id, { by, now, note: payload.note || '' });
    else if (action === 'snooze') res = snoozeNotification(before, id, payload.snoozeMin, { by, now });
    else if (action === 'transfer') res = transferNotification(before, id, payload.to, { by, now, reason: payload.reason || '' });
    else if (action === 'retry') res = retryNotification(before, id, { by, now });
    else return { ok: false, status: 400, reason: 'unknown-action' };

    if (res.status === 404) return { ok: false, status: 404, reason: 'notification-missing' };
    if (res.status === 409 || res.status === 400) return { ok: false, ...res };
    if (res.idempotent) return { ok: true, idempotent: true };
    this.notifications = res.items;
    // 记住这次乐观动作：服务端 409（另一窗口已处理同一项）时转成保留草稿并回滚。
    // 转交同时改了原项与派生项；原项记录带 newId，派生项记录用 spawnedBy 指回原项。
    const pendingRec = { action, payload, newId: res.newId || null, at: now, by };
    this._notifyPendingItemActions.set(id, pendingRec);
    if (res.newId) this._notifyPendingItemActions.set(res.newId, { ...pendingRec, newId: null, spawnedBy: id });
    // 持久乐观日志：409 恢复时即使保存链已清空 pending map 也能找回本地动作
    this._notifyOptimisticLog.set(id, pendingRec);
    if (res.newId) this._notifyOptimisticLog.set(res.newId, { ...pendingRec, newId: null, spawnedBy: id });
    // 标记本页自写状态（用于本地多页签冲突检测）；OCC 基线【不】乐观前进，
    // 只在服务端确认保存后更新——否则确认/转交的首个 PUT 会用超前基线对旧服务端状态误判 409。
    for (const n of this.notifications) this._markAuthoredItem(n.id, n.status);
    // 确认 / 转交后，已在队列中的旧通知项不再发送（出队 + 墓碑）
    this._pruneNotifyOutbox();
    this.pumpNotify({ now });
    // 若该通知项此前已收到过“服务端已被另一窗口处理”的 409（当时本地尚无动作而挂起），
    // 现在用刚记录的本地动作完成冲突处理：回滚权威状态并把本地动作保留为草稿。
    const deferred = this._notifyDeferredItemConflicts.get(id);
    if (deferred) {
      this._notifyDeferredItemConflicts.delete(id);
      this._onNotifyConflict({ reason: 'notify-item-advanced', notifyId: id, item: deferred.serverItem, serverStatus: deferred.serverItem.status });
    }
    this._dirty = true;
    this.persist();
    this.flushOutbox().catch(() => {});
    this._emit('notify', { type: action, id, newId: res.newId || null });
    return { ok: true, newId: res.newId || null };
  }

  ackNotification(id, note = '') { return this._applyNotifyItemAction(id, 'ack', { note }); }
  snoozeNotification(id, snoozeMin) { return this._applyNotifyItemAction(id, 'snooze', { snoozeMin }); }
  transferNotification(id, to, reason = '') { return this._applyNotifyItemAction(id, 'transfer', { to, reason }); }
  retryNotification(id) { return this._applyNotifyItemAction(id, 'retry'); }

  /* ---------- 409：版本冲突与本地未提交操作保留 ---------- */

  _stashNotifyDraft(id, draft) {
    if (draft.kind === 'rule') {
      this._notifyRuleDrafts.set(id, draft);
    } else {
      const list = this._notifyItemDrafts.get(id) || [];
      const key = `${draft.action}|${draft.payload?.to || ''}|${draft.payload?.snoozeMin || ''}|${draft.payload?.note || ''}`;
      if (!list.some((d) => `${d.action}|${d.payload?.to || ''}|${d.payload?.snoozeMin || ''}|${d.payload?.note || ''}` === key)) list.push(draft);
      this._notifyItemDrafts.set(id, list);
    }
    this._emit('notify', { type: 'draft', id });
  }

  notifyRuleDrafts(id) { return this._notifyRuleDrafts.get(id) || null; }
  notifyItemDrafts(id) { return this._notifyItemDrafts.get(id) || []; }

  /** 409 解决后把本地保留的规则编辑作为新修订重新提交（采用本地值）。 */
  reapplyNotifyRuleDraft(id) {
    const draft = this._notifyRuleDrafts.get(id);
    if (!draft) return { ok: false, error: '没有待提交的本地规则编辑' };
    const rule = this.notifyRuleById(id);
    if (!rule) { this.discardNotifyRuleDraft(id); return { ok: false, error: '规则已被删除' }; }
    this._notifyLockedRules.delete(id);
    if (!this._hasNotifyLocks()) this.notifyConflict = null;
    const res = this.saveNotifyRule(rule.sessionId, draft.spec, { editId: id });
    if (res.ok) this.discardNotifyRuleDraft(id);
    return res;
  }

  discardNotifyRuleDraft(id) {
    this._notifyRuleDrafts.delete(id);
    this._notifyLockedRules.delete(id);
    if (!this._hasNotifyLocks()) this.notifyConflict = null;
    this._emit('notify', { type: 'draft-discard', id });
    return { ok: true };
  }

  /** 409 解决后把本地保留的通知项动作应用到服务端最新状态。 */
  reapplyNotifyItemDraft(id, draft) {
    this._notifyLockedItems.delete(id);
    if (!this._hasNotifyLocks()) this.notifyConflict = null;
    const res = this._applyNotifyItemAction(id, draft.action, draft.payload || {});
    if (res.ok) {
      const list = (this._notifyItemDrafts.get(id) || []).filter((d) => d !== draft);
      if (list.length) this._notifyItemDrafts.set(id, list); else this._notifyItemDrafts.delete(id);
    }
    return res;
  }

  discardNotifyItemDraft(id, draft) {
    const list = (this._notifyItemDrafts.get(id) || []).filter((d) => d !== draft);
    if (list.length) this._notifyItemDrafts.set(id, list); else this._notifyItemDrafts.delete(id);
    this._notifyLockedItems.delete(id);
    if (!this._hasNotifyLocks()) this.notifyConflict = null;
    this._emit('notify', { type: 'draft-discard', id });
    return { ok: true };
  }

  /**
   * 409 命中的通知项在服务端缺失（通常是本地乐观转交产生、服务端还没有的派生项）：
   * 从乐观日志找回动作，转交到原项上保留为草稿，移除乐观派生项，锁定原项。
   */
  _resolveMissingItemConflict(lockedId, now) {
    let pending = this._notifyPendingItemActions.get(lockedId) || this._notifyOptimisticLog.get(lockedId);
    if (!pending?.action) {
      for (const p of [...this._notifyPendingItemActions.values(), ...this._notifyOptimisticLog.values()]) {
        if (p.newId === lockedId || p.spawnedBy === lockedId) { pending = p; break; }
      }
    }
    if (!pending) return;
    let originalId, spawnedId;
    if (pending.spawnedBy) { originalId = pending.spawnedBy; spawnedId = lockedId; }
    else if (pending.newId) { originalId = lockedId; spawnedId = pending.newId !== lockedId ? pending.newId : null; }
    else { originalId = lockedId; spawnedId = null; }
    this._stashNotifyDraft(originalId, { kind: 'item', notifyId: originalId, action: pending.action, payload: pending.payload || {}, at: now, by: pending.by || this.actor });
    if (spawnedId) this.notifications = this.notifications.filter((x) => x.id !== spawnedId);
    // 原项若无服务端权威副本，保守置回 pending（去掉乐观 transferred / snoozed）
    const orig = this.notifications.find((x) => x.id === originalId);
    if (orig && ['transferred', 'snoozed'].includes(orig.status)) {
      this.notifications = this.notifications.map((x) => x.id === originalId ? { ...x, status: 'pending', ackedAt: null, ackedBy: null, snoozeUntil: null } : x);
    }
    this._notifyItemBase.set(originalId, { status: orig?.status || 'pending', ackedAt: null });
    this._notifyPendingItemActions.delete(originalId);
    this._notifyPendingItemActions.delete(spawnedId);
    this._notifyOptimisticLog.delete(originalId);
    this._notifyOptimisticLog.delete(spawnedId);
    this._notifyLockedItems.add(originalId);
  }

  /**
   * 通知中心 409（规则被另一窗口修改 / 通知项被另一窗口处理）：
   * 采用服务端权威副本，锁定该规则 / 项，本地未提交操作保留为 draft。
   */
  _onNotifyConflict(info) {
    const now = Date.now();
    // 同一轮保存链可能连续收到多个 409（先 advanced、再 missing）：已锁定的不被后续缺 item 的响应清掉
    const alreadyLocked = (info.notifyId && this._notifyLockedItems.has(info.notifyId))
      || (info.ruleId && this._notifyLockedRules.has(info.ruleId));
    const adoptServerRule = (serverRule) => {
      if (!serverRule) return;
      const clean = sanitizeRules([serverRule], { now })[0];
      // 保留本地未提交编辑（以草稿形式），再用服务端权威值整体替换该规则
      const mine = this.notifyRuleById(clean.id);
      if (mine && Math.max(mine.rev || 0, mine.deleteRev || 0) !== this._notifyRuleSyncedRevs[clean.id]) {
        this._stashNotifyDraft(clean.id, { kind: 'rule', ruleId: clean.id, spec: ruleSpecOf(mine), at: now, by: this.actor });
      }
      this.notifyRules = this.notifyRules.map((x) => (x.id === clean.id ? clean : x));
      this._notifyRuleSyncedRevs[clean.id] = Math.max(clean.rev || 0, clean.deleteRev || 0);
      this._notifyAuthoredRuleRevs.delete(clean.id);
      this._notifyLockedRules.add(clean.id);
    };
    const adoptServerItem = (serverItem) => {
      if (!serverItem) return;
      const clean = sanitizeNotifications([serverItem], { now })[0];
      const lockedId = clean.id;
      // 在乐观日志 / 待确认动作里找出与本次 409 项配对的原始转交动作（可能按原项 id 或派生项 id 命中）。
      let pending = this._notifyPendingItemActions.get(lockedId) || this._notifyOptimisticLog.get(lockedId);
      if (!pending?.action) {
        for (const p of [...this._notifyPendingItemActions.values(), ...this._notifyOptimisticLog.values()]) {
          if (p.newId === lockedId || p.spawnedBy === lockedId) { pending = p; break; }
        }
      }
      // 最后兜底：本地该项已被乐观动作改成 transferred / 派生新项，据此重建待重试动作
      if (!pending?.action) {
        const localItem = this.notifications.find((x) => x.id === lockedId);
        const spawned = this.notifications.find((x) => x.transferOf === lockedId);
        if (localItem?.status === 'transferred') {
          pending = { action: 'transfer', payload: { to: spawned?.recipient || localItem.transferredTo, reason: localItem.history?.find((h) => h.action === 'transfer')?.detail || '' }, newId: spawned?.id || null, by: this.actor };
        } else if (localItem?.status === 'snoozed') {
          pending = { action: 'snooze', payload: { snoozeMin: Math.max(1, Math.round((localItem.snoozeUntil - now) / 60000)) }, by: this.actor };
        } else if (localItem?.status === 'acknowledged') {
          pending = { action: 'ack', payload: { note: localItem.history?.find((h) => h.action === 'acknowledge')?.detail || '' }, by: localItem.ackedBy || this.actor };
        }
      }
      // 409 到达时本地还没有对应乐观动作（来自较早一次在飞保存）：挂起该冲突，
      // 等用户随后对同一项执行动作时再恢复本地未提交操作。
      if (!pending?.action) {
        this._notifyDeferredItemConflicts.set(lockedId, { serverItem: clean, info, at: now });
        return;
      }
      // 原项 / 派生项配对：
      // - 409 命中派生项（pending.spawnedBy 指向原项）：originalId=spawnedBy，spawnedId=lockedId；
      // - 否则 409 命中原项：originalId=lockedId，若 pending 带 newId 则它是派生项。
      let originalId, spawnedId;
      if (pending?.spawnedBy) {
        originalId = pending.spawnedBy;
        spawnedId = lockedId;
      } else {
        originalId = lockedId;
        spawnedId = pending?.newId && pending.newId !== lockedId ? pending.newId : null;
      }
      if (pending?.action) {
        const draft = { kind: 'item', notifyId: originalId, action: pending.action, payload: pending.payload || {}, at: now, by: pending.by || this.actor };
        this._stashNotifyDraft(originalId, draft);
        // 409 命中派生项时，也在 409 返回的 notifyId 下保留同一动作，便于按该 id 查询/重试
        if (spawnedId && lockedId === spawnedId) this._stashNotifyDraft(spawnedId, { ...draft, notifyId: spawnedId });
      }
      if (spawnedId) this.notifications = this.notifications.filter((x) => x.id !== spawnedId);
      // 原项恢复服务端权威状态
      const origExists = this.notifications.some((x) => x.id === originalId);
      if (origExists) this.notifications = this.notifications.map((x) => (x.id === originalId ? { ...clean, id: originalId } : x));
      else this.notifications = [...this.notifications, { ...clean, id: originalId }];
      this._notifyItemBase.set(originalId, { status: clean.status, ackedAt: clean.ackedAt ?? null });
      this._notifyPendingItemActions.delete(originalId);
      this._notifyPendingItemActions.delete(spawnedId);
      this._notifyLockedItems.add(originalId);
    };

    if (info.ruleId) adoptServerRule(info.rule || null);
    if (info.notifyId) {
      if (info.item) adoptServerItem(info.item);
      else this._resolveMissingItemConflict(info.notifyId, now);
    }

    // 已处理过的同一冲突：保留首个（含 item / rule 权威值的）冲突描述，不被后续 missing 响应覆盖
    if (!alreadyLocked || info.item || info.rule) {
      this.notifyConflict = {
        kind: info.ruleId ? 'rule' : 'item',
        reason: info.reason, ruleId: info.ruleId || null, notifyId: info.notifyId || null,
        serverRev: info.serverRev ?? null, serverStatus: info.serverStatus || null, at: now,
      };
    }
    const needFetch = (info.ruleId && !info.rule) || (info.notifyId && !info.item && !alreadyLocked);
    if (needFetch) {
      this._fetchDoc().then((doc) => {
        if (!doc) return;
        if (info.ruleId) {
          const r = (doc.notifyRules || []).find((x) => x.id === info.ruleId);
          if (r) { adoptServerRule(r); this._emit('notify', { type: 'conflict' }); }
        }
        if (info.notifyId) {
          const n = (doc.notifications || []).find((x) => x.id === info.notifyId);
          if (n) { adoptServerItem(n); this._emit('notify', { type: 'conflict' }); }
        }
      }).catch(() => {});
    }
    this._emit('notify', { type: 'conflict' });
  }

  /* ---------- 发送队列（断网保留 / 恢复按序重试 / 幂等） ---------- */

  /**
   * 等待当前在飞 / 防抖中的保存链落定一次（不重入发送、不重新 flush 通知队列）。
   * 供默认 in-app 发送通道确认“权威文档已保存”使用，避免 flushed() 的递归竞争。
   */
  async _waitSaveSettled() {
    await this._settlePendingSave();
  }

  /**
   * 按 FIFO 刷新发送队列。默认 in-app 通道：通知项随权威文档保存成功即视为送达，
   * 因此每发送一项先等待一次持久化确认；网络不可用时留在队列，恢复后按原顺序重试。
   * 可通过 setNotifyTransport 注入测试通道（可控在线 / 失败）。
   */
  async flushOutbox() {
    // 单飞：已有刷新在进行时复用其 promise（调用方 await 的是同一次完整 FIFO 刷新），
    // 避免网络恢复时 notifyOnline 与显式调用竞争导致第二个调用立即空返回。
    if (this._flushInFlight) return this._flushInFlight;
    if (this.saveConflict) return;
    this._flushing = true;
    this._flushInFlight = (async () => {
    try {
      let guard = 0;
      while (guard++ < 10000) {
        // 严格 FIFO：按 enqueuedAt 排序，队头决定阻塞。
        const ordered = [...this.notifyOutbox].sort((a, b) => (a.enqueuedAt - b.enqueuedAt) || (a.id < b.id ? -1 : 1));
        // 丢弃引用已终态 / 已不存在通知项的陈旧条目（确认 / 转交 / 取消后不再发送）
        const stale = new Set();
        for (const o of ordered) {
          const it = this.notifications.find((n) => n.id === o.notifyId);
          if (!it || !['pending', 'sent'].includes(it.status)) stale.add(o.id);
        }
        if (stale.size) this._removeOutboxEntries([...stale]);
        // 找到第一个【未锁定】项：它前面的锁定项（版本冲突未解决、本地动作保留为草稿）
        // 保留在原位并跳过，且不阻塞后续无关待处理决定；未锁定队头若仍在退避 / 断网，
        // 则严格顺序阻塞其后续项。
        let head = null;
        for (const o of ordered) {
          if (stale.has(o.id)) continue;
          if (this._notifyLockedItems.has(o.notifyId)) continue;
          head = o;
          break;
        }
        if (!head) break;
        const item = this.notifications.find((n) => n.id === head.notifyId);
        if (head.nextAttemptAt != null && Date.now() < head.nextAttemptAt) break; // 严格顺序：等队头退避
        if (!this._isOnline()) break; // 断网：留在队列，恢复后重试

        let result;
        if (this._transport?.send) {
          try { result = await this._transport.send(item, head); }
          catch (e) { result = { ok: false, error: e?.message || 'transport-error' }; }
        } else {
          // 默认 in-app：权威文档保存确认即送达。不能递归调用 flushed()（会重入保存链，
          // 与正在进行的确认/决定保存竞争），只等待当前在飞 / 防抖中的 PUT 落定一次。
          try {
            await this._waitSaveSettled();
            result = this.online ? { ok: true, detail: 'in-app 已送达并持久化' } : { ok: false, error: '离线，保留在队列' };
          } catch (e) { result = { ok: false, error: e?.message || 'persist-failed' }; }
        }

        // await 期间该项可能已被 409 流程锁定 / 回滚 / 转交：丢弃这次迟到的送达结果，
        // 队列条目保持现状（锁定跳过 / 已终态则移除并立墓碑），绝不覆盖权威状态。
        const after = this.notifications.find((n) => n.id === item.id);
        if (this._notifyLockedItems.has(item.id)) continue;
        if (!after || !['pending', 'sent'].includes(after.status)) {
          this._removeOutboxEntries([head.id]);
          continue;
        }

        const now = Date.now();
        const beforeOutboxIds = new Set(this.notifyOutbox.map((o) => o.id));
        const merged = recordDeliveryAttempt(this.notifications, this.notifyOutbox, item.id, result,
          { now, backoffMs: this.notifyBackoffMs });
        this.notifications = merged.items;
        this.notifyOutbox = merged.outbox;
        // 送达成功 / 达到失败上限而出队的条目立墓碑，防止 persist 合流时被磁盘旧值复活
        for (const oid of beforeOutboxIds) if (!merged.outbox.some((o) => o.id === oid)) this._notifyOutboxTombstones.add(oid);
        // 注意：这里【不】乐观推进 OCC 基线（_notifyItemBase）。基线只能在服务端确认保存后
        // 前进，否则“刚送达、尚未保存”的下一次 PUT 会带新基线对旧服务端状态而误判为 409。
        for (const n of this.notifications) this._markAuthoredItem(n.id, n.status);
        this._dirty = true;
        this.persist();
        // 注入通道（真实邮件 / IM 发送器）与默认 in-app 通道一致：送达 / 失败结果必须
        // 随权威保存一起落定，否则紧接着刷新 / 重启会把已发送项按旧状态重新物化、再次发送。
        // flush 自身持有 _flushing 单飞锁，保存成功回调里嵌套的 flushOutbox 会立即返回，
        // 由本循环回到顶部基于最新队列继续，保证严格 FIFO 连续发送。
        if (result.ok) {
          try { await this._waitSaveSettled(); } catch {}
        }
        this._emit('notify', { type: result.ok ? 'delivered' : 'send-error', id: item.id });
        if (!result.ok) { this.online = false; break; } // 断网：停止，保留队列与顺序
        this.online = true;
        // 回到循环顶部基于【最新】队列重新扫描：等待保存期间 pump / 嵌套 flush
        // 可能已推进队列，绝不能用 await 前的旧快照决定下一个队头。
        continue;
      }
    } finally {
      this._flushing = false;
    }
    })();
    const flight = this._flushInFlight;
    try {
      await flight;
    } finally {
      if (this._flushInFlight === flight) this._flushInFlight = null;
    }
  }

  /** 网络恢复（测试 / 浏览器 online 事件可调用）：按原顺序重试队列。 */
  notifyOnline() {
    if (this.online) return;
    this.online = true;
    this.pumpNotify({ persist: true });
    this.flushOutbox().catch(() => {});
  }

  experimentById(id) { return this.experiments.find((x) => x.id === id) || null; }

  /**
   * 从当前编辑分支（head，或正在回放的历史事件）建立实验并立即排队批量求解。
   * 幂等：相同来源事件 + 相同有序参数变体（名称只是标签，不参与指纹）只返回已存在的实验。
   */
  createExperiment(rawSpecs, { name = '', sourceEventId = null } = {}) {
    if (this.saveConflict) return { ok: false, error: '版本冲突未解决，请先重新加载' };
    const srcId = sourceEventId || this.replayEventId || this.branch.headEventId;
    // 工作台“求解前/变体基准”是临时快照：不允许作为实验来源（它不是审计事件，无法持久化来源）
    const event = this.eventsById.get(srcId);
    if (!event || event.corrupt || !event.model) return { ok: false, error: '来源事件不可用（缺失或损坏），无法建立实验' };
    let specs;
    try {
      specs = prepareSpecs(rawSpecs, event.model);
    } catch (e) {
      return { ok: false, error: e.message };
    }
    const ch = experimentConfigHash(event.id, specs);
    const dup = this.experiments.find((x) => x.source?.eventId === event.id && x.configHash === ch);
    if (dup) {
      this._emit('experiments', { type: 'idempotent', id: dup.id });
      return { ok: true, experiment: dup, idempotent: true };
    }
    const t = Date.now();
    const exp = makeExperiment({
      name: String(name || '').trim() || `实验 ${this.experiments.length + 1}`,
      actor: this.actor || '未署名', event, specs, t,
    });
    exp.runState = 'running'; // 创建即入队并自动开始批量求解
    this.experiments = [...this.experiments, exp];
    this._dirty = true;
    this.persist();
    this._emit('experiments', { type: 'create', id: exp.id });
    this._startRunner(exp.id);
    return { ok: true, experiment: exp, idempotent: false };
  }

  /** 实验是否仍有排队变体（可继续/可暂停/可取消的前提）。 */
  _hasQueued(exp) { return exp.variants.some((v) => v.status === 'queued'); }

  _tick() { return new Promise((r) => setTimeout(r, this.tickMs)); }

  _bumpExp(exp, { now = true } = {}) {
    exp.updatedAt = Date.now();
    this._dirty = true;
    this.persist();
    if (now) this._emit('experiments', { type: 'progress', id: exp.id });
  }

  /**
   * 批量运行器：按 variants 顺序逐个求解；每个变体之间让出事件循环，
   * 以响应暂停/继续/取消。单个变体失败只标 failed，绝不阻塞其他变体。
   * 完成结果只写一次：done/failed/cancelled 是终态，后续运行绝不覆盖。
   */
  async _startRunner(expId) {
    // 运行中的实验不重复启动；暂停后继续会安装新 token（旧运行器下一拍让出）
    const cur = this._runners.get(expId);
    const exp0 = this.experiments.find((x) => x.id === expId);
    if (cur && exp0 && exp0.runState === 'running') return;
    const token = {};
    this._runners.set(expId, { token });
    try {
      await this._runQueue(expId, token);
    } finally {
      if (this._runners.get(expId)?.token === token) this._runners.delete(expId);
    }
  }

  async _runQueue(expId, token) {
    for (;;) {
      const exp = this.experiments.find((x) => x.id === expId);
      if (!exp || token.cancelled) return;
      if (exp.runState !== 'running') return;              // 暂停 / 取消：让出，等继续
      const idx = exp.variants.findIndex((v) => v.status === 'queued');
      if (idx < 0) {
        exp.runState = reconcileRunState('done', exp.variants);
        this._bumpExp(exp);
        return;
      }
      await this._tick();                                  // 暂停/继续/取消的响应点
      const exp2 = this.experiments.find((x) => x.id === expId);
      if (!exp2 || token.cancelled || this._runners.get(expId)?.token !== token || exp2.runState !== 'running') return;
      this.onVariantGate?.(expId, idx);
      const variant = exp2.variants[idx];
      if (variant.status !== 'queued') continue;           // 终态不覆盖（防御）
      const startedAt = Date.now();
      variant.status = 'running';
      this._bumpExp(exp2);

      let outcome;
      try {
        outcome = executeVariant(exp2, variant);
      } catch (e) {
        outcome = { ok: false, error: `求解异常：${e.message}` };
      }
      const exp3 = this.experiments.find((x) => x.id === expId);
      if (!exp3 || token.cancelled || this._runners.get(expId)?.token !== token) return;
      const v3 = exp3.variants.find((v) => v.id === variant.id);
      if (!v3 || v3.status === 'done' || v3.status === 'failed') continue; // 终态不覆盖
      v3.attempts += 1;
      if (outcome.ok) {
        v3.status = 'done';
        v3.error = null;
        v3.result = makeVariantResult(outcome, { startedAt, completedAt: Date.now() });
      } else {
        v3.status = 'failed';
        v3.error = outcome.error || '求解失败';
      }
      if (!exp3.variants.some((v) => v.status === 'queued')) {
        exp3.runState = exp3.variants.some((v) => v.status === 'cancelled') ? 'cancelled' : 'done';
      }
      this._bumpExp(exp3);
    }
  }

  pauseExperiment(id) {
    const exp = this.experiments.find((x) => x.id === id);
    if (!exp) return { ok: false, error: '实验不存在' };
    if (!['queued', 'running'].includes(exp.runState)) return { ok: false, error: '该实验已结束，不能暂停' };
    exp.runState = 'paused';   // 运行器在下一拍（变体之间）让出；正在求解的当前变体正常完成
    this._bumpExp(exp);
    return { ok: true };
  }

  /** 继续：把仍在求解中的“running 变体”视为未落盘（刷新语义），重新排队后重跑。 */
  resumeExperiment(id) {
    const exp = this.experiments.find((x) => x.id === id);
    if (!exp) return { ok: false, error: '实验不存在' };
    if (!['paused', 'queued'].includes(exp.runState)) return { ok: false, error: '该实验不在暂停/排队状态' };
    if (!this._hasQueued(exp)) return { ok: false, error: '没有排队中的变体' };
    exp.runState = 'running';
    this._dirty = true;
    this.persist();
    this._emit('experiments', { type: 'resume', id });
    this._startRunner(id);
    return { ok: true };
  }

  /** 取消：所有排队变体进入 cancelled 终态（完成的结果保留、不覆盖），实验终态 cancelled。 */
  cancelExperiment(id) {
    const exp = this.experiments.find((x) => x.id === id);
    if (!exp) return { ok: false, error: '实验不存在' };
    if (['done', 'cancelled'].includes(exp.runState)) return { ok: false, error: '该实验已结束' };
    const r = this._runners.get(id);
    if (r) r.token.cancelled = true;
    for (const v of exp.variants) if (v.status === 'queued') v.status = 'cancelled';
    exp.runState = 'cancelled';
    this._bumpExp(exp);
    return { ok: true };
  }

  /** 测试/卸载用：停止批量运行器并作废所有防抖保存（之后 persist 完全 no-op）。 */
  dispose() {
    this._disposed = true;
    this._runners.clear();
    clearTimeout(this._saveTimer);
    if (this._notifyTimer) { clearInterval(this._notifyTimer); this._notifyTimer = null; }
    this._saveChain = Promise.resolve();
    this._sendLatest = () => Promise.resolve();
  }

  /** 测试用：等到该实验不再有运行中的变体且运行器已收尾。 */
  async experimentSettled(id) {
    for (let i = 0; i < 100000; i++) {
      const exp = this.experiments.find((x) => x.id === id);
      if (exp && !exp.variants.some((v) => v.status === 'running' || v.status === 'queued') && !this._runners.has(id)) return exp;
      if (exp && this._runners.has(id)) await this._tick();
      else await Promise.resolve();
    }
    throw new Error('experimentSettled 超时');
  }

  experimentCounters(exp) { return variantCounters(exp.variants); }

  /** 完成变体相对基准的矩形/约束/冲突差异（基准损坏或变体不可回放 → null）。 */
  diffVariant(expId, variantId) {
    const exp = this.experiments.find((x) => x.id === expId);
    const v = exp?.variants.find((x) => x.id === variantId);
    if (!exp || !v) return null;
    return diffVariant(exp, v);
  }

  /**
   * 把任意完成变体另存为新的编辑分支：fork-root 与变体结果同指纹，
   * provenance 记录实验来源关系；基准事件 / 实验结果 / 原分支都不被改写。
   */
  forkExperimentVariant(expId, variantId, name) {
    name = String(name ?? '').trim();
    if (!name) return { ok: false, error: '分支名称不能为空' };
    if (this.branches.some((b) => b.name === name)) return { ok: false, error: `已存在同名分支「${name}」` };
    const exp = this.experiments.find((x) => x.id === expId);
    const v = exp?.variants.find((x) => x.id === variantId);
    if (!exp || !v) return { ok: false, error: '变体不存在' };
    if (!variantReplayable(v)) return { ok: false, error: '该变体结果损坏或未完成，无法另存为分支' };

    const id = uid('b');
    const root = makeExperimentForkRootEvent(id, v, exp, { actor: this.actor || '未署名' });
    this.events = [...this.events, root];
    this.eventsById.set(root.id, root);
    const branch = freeze({
      id, name, createdAt: root.t,
      rootEventId: root.id, headEventId: root.id, redoTipId: null,
      source: { branchId: exp.source?.branchId || null, eventId: exp.source?.eventId || root.id },
      experimentSource: { experimentId: exp.id, variantId: v.id },
    });
    this.branches = [...this.branches, branch];
    this.currentBranchId = id;
    this.replayEventId = null;
    this.replaySnapshot = null;
    this._syncedHeads[id] = root.id;
    this._dirty = true;
    this.persist();
    this._emit('branch', { type: 'fork', id, sourceEventId: root.id, fromExperiment: true });
    this._emit('experiments', { type: 'fork', id: expId });
    this._emit('change', { label: 'experiment-fork' });
    return { ok: true, branch, event: root };
  }

  /* ---------- 布局版本（只读快照） ---------- */

  get currentVersion() { return this.versions.find((v) => v.id === this.currentVersionId) || null; }

  saveVersion(name) {
    name = String(name ?? '').trim();
    if (!name) return { ok: false, error: '版本名称不能为空' };
    if (this.versions.some((v) => v.name === name)) return { ok: false, error: `已存在同名版本「${name}」` };
    const v = snapshotVersion(uid('v'), name, this.headEvent);
    this.versions.push(v);
    this.currentVersionId = v.id;
    this._dirty = true;
    this.persist();
    this._emit('versions', { type: 'save', id: v.id });
    return { ok: true, version: v };
  }

  /** 恢复版本：快照内容作为新的审计事件提交（新事件追加，历史与版本都不被改写）。 */
  restoreVersion(id) {
    const v = this.versions.find((x) => x.id === id);
    if (!v) return { ok: false, error: '版本不存在（可能已被其他页面删除）' };
    const res = this.commit((m) => {
      const snap = structuredClone(v.model);
      m.canvas = snap.canvas;
      m.rects = snap.rects;
      m.constraints = snap.constraints;
    }, { label: `恢复版本「${v.name}」` });
    if (!res.ok) return { ok: false, error: '版本内容校验失败，无法恢复' };
    this.currentVersionId = id;
    this.persist();
    this._emit('versions', { type: 'restore', id });
    return { ok: true };
  }

  deleteVersion(id) {
    const v = this.versions.find((x) => x.id === id);
    if (!v) return { ok: false, error: '版本不存在' };
    if (id === this.currentVersionId) return { ok: false, error: '当前版本不能删除：请先恢复/保存到其他版本' };
    if (v.published) return { ok: false, error: '已发布的版本不能删除：请先取消发布标记' };
    this.versions = this.versions.filter((x) => x.id !== id);
    if (this.compare.a === id) this.compare.a = null;
    if (this.compare.b === id) this.compare.b = null;
    this._dirty = true;
    this.persist();
    this._emit('versions', { type: 'delete', id });
    return { ok: true };
  }

  setPublished(id, flag) {
    const v = this.versions.find((x) => x.id === id);
    if (!v) return { ok: false, error: '版本不存在' };
    v.published = !!flag;
    this._dirty = true;
    this.persist();
    this._emit('versions', { type: 'publish', id });
    return { ok: true };
  }

  setCompare(a, b) {
    this.compare = { a: a || null, b: b || null };
    this._dirty = true;
    this.persist();
    this._emit('versions', { type: 'compare' });
  }

  compareById(aId, bId) {
    const a = this.versions.find((v) => v.id === aId);
    const b = this.versions.find((v) => v.id === bId);
    if (!a || !b) return null;
    return compareVersions(a, b);
  }

  /* ---------- 拖动（临时解 + 提交） ---------- */

  previewDrag(pinned, group) {
    if (this.replaying) return this.headEvent.report;
    const rep = solve(this.headEvent.model, { pinned, group });
    this.dragPreview = rep;
    // 渲染需要读 model：临时构造一份带预览坐标的模型
    this._dragModel = withPreviewPositions(this.headEvent.model, rep);
    this._emit('drag');
    return rep;
  }
  endDrag() {
    const rep = this.dragPreview;
    this.dragPreview = null;
    this._dragModel = null;
    if (!rep) return;
    this.commit((m) => {
      for (const r of m.rects) {
        const p = rep.rects[r.id];
        if (p) { r.x = p.x; r.y = p.y; r.w = p.w; r.h = p.h; }
      }
    }, { label: '拖动' });
  }
  cancelDrag() { this.dragPreview = null; this._dragModel = null; this._emit('drag'); }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}

function withPreviewPositions(model, rep) {
  const m = structuredClone(model);
  for (const r of m.rects) {
    const p = rep.rects[r.id];
    if (p) { r.x = p.x; r.y = p.y; r.w = p.w; r.h = p.h; }
  }
  return m;
}

/** 把规则还原成可编辑 spec（409 后本地规则编辑以草稿保留时使用）。 */
function ruleSpecOf(rule) {
  return {
    name: rule.name,
    triggers: { ...rule.triggers },
    levels: (rule.levels || []).map((l) => ({ delayMin: l.delayMin, recipients: [...l.recipients] })),
  };
}

/** 载入时清洗版本列表：结构不完整的一律丢弃，published 归一为布尔。 */
function sanitizeVersions(list) {  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const v of list) {
    if (!v || typeof v.id !== 'string' || typeof v.name !== 'string') continue;
    if (seen.has(v.id)) continue;
    if (!v.model || !Array.isArray(v.model.rects) || !Array.isArray(v.model.constraints)) continue;
    seen.add(v.id);
    out.push({
      id: v.id,
      name: v.name,
      createdAt: Number.isFinite(v.createdAt) ? v.createdAt : 0,
      published: v.published === true,
      model: v.model,
      report: v.report && typeof v.report === 'object' ? v.report : null,
      hash: typeof v.hash === 'string' ? v.hash : (v.report?.hash ?? ''),
    });
  }
  return out;
}
