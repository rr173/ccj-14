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
  createReviewSession, reconcileSession, recordDecision, mergeReviewItem,
  rebaseSession, completeReview, reopenReview, sanitizeReviewSessions,
  mergeReviewSessions, assessServerReviewConflict, findReviewNodeDrift,
  buildReviewReport, sessionProgress,
} from './reviews.js';

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
    if (this._needsInitialPersist) {
      this._needsInitialPersist = false;
      this._dirty = true;
      this.persist();
      await this.flushed();
    }
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
      actor: this.actor,
    };
  }

  _saveTimer = null;
  _saveChain = Promise.resolve();
  _saveVersion = 0;
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
      }
      // 本地多页签合流：merged 已含本页当前分支最新提交，直接落合并结果
      const finalDoc = merged || { ...payload, rev: this.rev };
      // 实验按 id 合入磁盘（别的页签可能建了实验；完成结果永不被降级覆盖）
      finalDoc.experiments = mergeExperiments(prevExperiments || finalDoc.experiments || [], payload.experiments);
      // 审阅会话按 id 合入磁盘（rev 更大者胜出；冲突记录并集）
      finalDoc.reviewSessions = mergeReviewSessions(
        Array.isArray(prev?.reviewSessions) ? prev.reviewSessions : (finalDoc.reviewSessions || []),
        payload.reviewSessions || []);
      finalDoc.activeReviewId = finalDoc.reviewSessions.some((x) => x.id === finalDoc.activeReviewId)
        ? finalDoc.activeReviewId
        : (payload.activeReviewId && finalDoc.reviewSessions.some((x) => x.id === payload.activeReviewId) ? payload.activeReviewId : null);
      localStorage.setItem(LS_KEY, JSON.stringify(finalDoc));
      // 记录本页自己写入过的会话 rev：防抖窗口内重读 localStorage 不把自己的写入误判成外来推进
      for (const rs of payload.reviewSessions || []) {
        if (!this._reviewAuthoredRevs.has(rs.id)) this._reviewAuthoredRevs.set(rs.id, new Set());
        this._reviewAuthoredRevs.get(rs.id).add(rs.rev);
      }
    } catch {}
    this._emit('persist');
    ++this._saveVersion;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._sendLatest(), 120);
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

  _sendLatest() {
    if (this.saveConflict) return this._saveChain;
    const v = this._saveVersion;
    // baseHeads：每个分支“所依据的服务端事件序号”。当前分支取已确认的 synced
    // （不含本地未确认推进，否则会误判自己已合入）；其余分支取本地 head
    // （它们未被本页编辑，与服务端一致或更新——更新的情况说明来自加载到的最新文档）。
    const baseHeads = {};
    for (const b of this.branches) {
      baseHeads[b.id] = b.id === this.currentBranchId
        ? (this._syncedHeads[b.id] ?? b.headEventId)
        : b.headEventId;
    }
    const snapshot = JSON.stringify({
      ...this._payload(), baseRev: this.rev, baseHeads,
      baseReviewRevs: this._baseReviewRevs(),
    });
    this._saveChain = this._saveChain.then(async () => {
      if (v !== this._saveVersion || this.saveConflict) return;
      // 审阅冲突未解决：该会话决定不再外发（本地决定已保留为提案，等逐项合并 / 放弃）。
      // 几何保存（其他分支/文档字段）仍照常进行：载荷里剔除冲突会话，服务端按 id
      // 并集时保留其权威副本，不会被本页过期内容覆盖。
      let body = snapshot;
      if (this.reviewConflict) {
        const cid = this.reviewConflict.sessionId;
        const parsed = JSON.parse(snapshot);
        parsed.reviewSessions = (parsed.reviewSessions || []).filter((x) => x.id !== cid);
        if (parsed.baseReviewRevs) delete parsed.baseReviewRevs[cid];
        body = JSON.stringify(parsed);
      }
      try {
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
          await this._adopt(data.doc, { seed: false, keepReviewConflict: true });
          // 合流文档以服务端为准，但本页刚刚提交且未被服务端纳入的审阅决定要保留为待合并提案
          this._carryReviewProposals(myReview, myProposals, myActiveReview, data.doc);
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
        this._emit('saved', { rev: this.rev });
      } catch (e) {
        console.warn('保存失败（已写入 localStorage）:', e.message);
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
    clearTimeout(this._saveTimer);
    await this._sendLatest();
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
  createReview(name, { setActive = true } = {}) {
    if (this.saveConflict) return { ok: false, error: '版本冲突未解决，请先重新加载' };
    const w = this.workbench();
    const nodes = filterNodes(w.nodes, this.auditWorkbench.filter);
    if (!nodes.length) return { ok: false, error: '当前筛选结果为空，无法创建审阅会话' };
    const session = createReviewSession({
      name, actor: this.actor, filter: this.auditWorkbench.filter, nodes,
      branches: this.branches, now: Date.now(),
    });
    this.reviewSessions = [...this.reviewSessions, session];
    this._reviewSyncedRevs[session.id] = 0; // HTTP 首次保存：服务端尚无此会话（base=0）
    if (!this._reviewAuthoredRevs.has(session.id)) this._reviewAuthoredRevs.set(session.id, new Set());
    this._reviewAuthoredRevs.get(session.id).add(session.rev); // 本地自创会话：自己的 rev1 不是外来推进
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

  _stashProposal(id, nodeKey, decision, reason) {
    const p = { nodeKey, decision, reason: String(reason || '').slice(0, 2000), by: this.actor || '未署名', at: Date.now(), rejected: true };
    const list = this._reviewProposals.get(id) || [];
    list.push(p);
    this._reviewProposals.set(id, list);
    this._emit('reviews', { type: 'proposal', id, nodeKey });
    return p;
  }

  /** 409 后逐项合并：以本地决定强制落到【最新快照】的该节点上（关闭该节点冲突记录）。 */
  mergeReviewItem(id, nodeKey, decision, reason) {
    const session = this.reviewSessions.find((x) => x.id === id);
    if (!session) return { ok: false, error: '会话不存在' };
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

  /** 放弃本地保留的某条决定（采用服务端最新值）。 */
  discardReviewProposal(id, nodeKey) {
    const list = (this._reviewProposals.get(id) || []).filter((p) => p.nodeKey !== nodeKey);
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
    if (res.status !== 200) return { ok: false, error: `还有 ${res.pending} 个节点未处理（含系统转待复核）` };
    this._replaceReview(res.session);
    this._dirty = true;
    this.persist();
    this._emit('reviews', { type: 'complete', id });
    return { ok: true, session: res.session };
  }

  reopenReview(id) {
    const session = this.reviewSessions.find((x) => x.id === id);
    if (!session) return { ok: false, error: '会话不存在' };
    const res = reopenReview(session);
    this._replaceReview(res.session);
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
      // 保留本地（被拒）决定：服务端节点上仍 pending 或值不同的，进 proposals
      const kept = [];
      for (const [key, n] of localDecisions) {
        const srv = revsed?.nodes.find((x) => x.key === key);
        if (!srv || srv.decision !== n.decision) {
          kept.push({ nodeKey: key, decision: n.decision, reason: n.reason, by: n.decidedBy || this.actor, at: Date.now(), rejected: true });
        }
      }
      const existing = this._reviewProposals.get(id) || [];
      const keys = new Set(existing.map((p) => p.nodeKey + p.decision));
      for (const p of kept) if (!keys.has(p.nodeKey + p.decision)) existing.push(p);
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
        if (m && m.decision !== 'pending' && (m.decision !== n.decision || m.reason !== n.reason)) { differs = true; break; }
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
      for (const n of mine.nodes) {
        if (n.decision === 'pending') continue;
        const on = srv?.nodes.find((x) => x.key === n.key);
        if (!on || on.decision !== n.decision || on.reason !== n.reason) {
          kept.push({ nodeKey: n.key, decision: n.decision, reason: n.reason, by: n.decidedBy || this.actor, at: Date.now(), rejected: true });
        }
      }
      const prev = myProposals.get(mine.id) || [];
      const all = [...prev, ...kept];
      if (all.length) this._reviewProposals.set(mine.id, all);
    }
    if (myActiveId && this.reviewSessions.some((x) => x.id === myActiveId)) this.activeReviewId = myActiveId;
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

/** 载入时清洗版本列表：结构不完整的一律丢弃，published 归一为布尔。 */
function sanitizeVersions(list) {
  if (!Array.isArray(list)) return [];
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
