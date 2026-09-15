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

import { solve, findCycle, constraintLabel } from './solver.js';
import { validate, normalize, seedModel, uid } from './model.js';
import { snapshotVersion, compareVersions } from './versions.js';
import {
  MAIN_BRANCH, makeRootEvent, makeEvent, makeForkRootEvent, makeExperimentForkRootEvent,
  makeMigrationForkRootEvent, migrationBranchId, makeMergeEvent, makeImpactEvent,
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
  applyBatchNotifications, makeBatchRecord, batchId, sanitizeBatches, mergeBatches,
  makeDraft, sanitizeDrafts, mergeDrafts, scheduleIsOpenAt, scheduleClosedReason,
} from './notifications.js';
import {
  createReleaseCandidate, reconcileRelease, releaseView as releaseViewPure,
  approveRelease, revokeRelease, regenerateRelease,
  sanitizeReleases, mergeReleases, assessServerReleaseConflict,
  assessReleaseStaleAgainstDoc, frozenGateBlocked, buildReleaseReport,
} from './releases.js';
import {
  ingestFile, makeBatch, executeFile, reconcileBatchState, batchCounters,
  cancelBatchState, sanitizeMigrations, mergeMigrations,
  migrationDiff, buildMigrationReport, sourceFingerprint,
} from './migration.js';
import {
  buildMergePlan, assembleMergeModel, finalizeMergeModel,
  buildMergeReport, makeMergeDraft, mergeDraftId, findMergeBase,
  choicesToMap, itemKey, mergeMergeDrafts, rebaseConflictChoices,
} from './merge.js';
import {
  analyzeImpact, simulateChanges, normalizeChange, makeImpactSnapshot, impactSnapshotId,
  sanitizeImpactSnapshots, mergeImpactSnapshots, buildImpactReport,
} from './impact.js';
import {
  extractDraft, publishVersion, templateVersion as tplVersion,
  planInstance, mappingFingerprint, diffTemplateVersions, migrateParams,
  deriveInstanceLinks, reconcileInstanceStatuses,
  normalizeDraft as normalizeTplDraft, validateDraft,
  setOverridable as tplSetOverridable, setDraftParamDefault,
  sanitizeTemplates, sanitizeInstances, mergeTemplates, mergeInstances,
  normalizeKeepTags, tplConstraintLabel,
} from './templates.js';

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

    // 旧版布局批量迁移
    this.migrations = [];                 // 迁移批次（含每文件预览/终态结果/原始输入/导入记录）
    this.migrationWarnings = [];
    this._migrationRunners = new Map();   // batchId -> {token}（进行中的批次运行器）

    // 编辑分支三方合并草案（可反复打开；共同祖先 / 冲突选择 / 来源关系 / 合并报告随文档持久化）
    this.mergeDrafts = [];                // merge draft[]（open / completed / abandoned）
    this.activeMergeDraftId = null;       // 当前打开的草案 id（随文档持久化）
    this.mergeConflict = null;            // null | { draftId, reason, targetHeadId, targetHeadSeq, serverRev }

    // 影响分析与安全变更工作台：分析快照（绑定分析时文档版本 / 分支 head）+ 候选变更 + 模拟结果，
    // 全部随文档持久化；刷新 / 重启后可继续逐项放弃候选、查看模拟与报告，应用时一次性写审计事件。
    this.impactSnapshots = [];            // impact snapshot[]（open / applied / abandoned）
    this.activeImpactId = null;           // 当前打开的分析快照 id（随文档持久化）
    this.impactWarnings = [];
    this._impactApplying = null;          // 应用在途标记 { snapshotId, branchId, rollback, conflict }

    // 参数化约束模板：模板（草稿 + 只读版本）与实例链接（文档级，随文档持久化）。
    // 实例在某分支上“链接/固定/脱离”的状态由当前模型约束上的 tpl 标签派生（deriveInstanceLinks），
    // 因此 undo/redo 移动分支 head 时，约束与实例链接天然回到同一状态。
    this.templates = [];                  // template[]
    this.templateInstances = [];          // instance[]
    this.activeTemplateId = null;         // 当前打开的模板 id（随文档持久化）
    this.templateConflict = null;         // null | { templateId, reason:'template-draft-advanced', serverDraftRev, localDraft, localDraftRev }
    this._templateSyncedRevs = {};        // templateId -> 已确认的 draftRev（草稿乐观锁基线）
    this._templateAuthoredRevs = new Map(); // templateId -> Set(draftRev)：本页自写（防抖窗内不误判外来推进）

    // 审阅通知与升级中心
    this.notifyEvents = [];        // append-only 通知事件（决定/签署/冲突/完成），按 id 幂等并集
    this.notifyRules = [];         // 每会话多级升级规则（rev 乐观并发，含工作时段/静音窗口 schedule）
    this.notifications = [];       // 物化通知项（事件 × 级别 × 接收人，幂等 id；deferred=静音延迟）
    this.notifyOutbox = [];        // FIFO 发送队列（稳定 id，断网保留、恢复后按序重试）
    this.notifyBatches = [];       // append-only 批量处理结果（按会话批量确认/稍后/转交；成功项与冲突失败项）
    this.notifyDrafts = [];        // 持久化本地草稿：批量部分版本冲突时为失败项保留（刷新/重启后仍可重试/放弃）
    this._notifyRuleSyncedRevs = {};  // ruleId -> 已与服务端确认的规则 rev（规则乐观锁）
    this._notifyItemBase = new Map();  // notifyId -> 上次同步时的 {status, ackedAt}（通知项乐观锁）
    this._notifyRuleDrafts = new Map(); // ruleId -> 本地未提交规则编辑（规则冲突后保留，内存态）
    this._notifyItemDrafts = new Map(); // notifyId -> [动作描述符]（同一通知被两窗口处理后保留；重启从 notifyDrafts 重建）
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

    // 发布门禁与证据快照
    this.releases = [];                       // 发布候选（不可变证据快照 + 门禁结果 + 审批/撤销记录）
    this.activeReleaseId = null;              // 当前打开的发布候选 id（随文档持久化）
    this._releaseSyncedRevs = {};             // releaseId -> 已与服务端确认的候选 rev（发布乐观锁）
    this._releaseAuthoredRevs = new Map();    // releaseId -> Set(rev)：本页自己写入过的 rev
    this._releaseProposals = new Map();       // releaseId -> [{approver, comment, at, rejected}]（409 后本地保留的审批意见）
    this._releasePendingApprovals = new Map(); // releaseId -> [{id,by}] 本页已本地接受、尚未被服务端确认的批准
    this.releaseConflict = null;              // null | { releaseId, reason, serverRev, release }
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
    // 首次播种 / 迁移后立即回写并等待确认；正常加载不产生版本号竞争。
    // 实例 status 愈合（刷新后与当前 head 标签对齐）也需补存一次，否则刷新结果不落盘。
    if (this._needsInitialPersist || this._notifyNeedsPersist || this._templateStatusHealed) {
      this._needsInitialPersist = false;
      this._notifyNeedsPersist = false;
      this._templateStatusHealed = false;
      this._dirty = true;
      this.persist();
      await this.flushed();
    }
    // 重启后把可能已到期 / 待发送的通知队列按序发送一次
    this.flushOutbox().catch(() => {});
    // 服务中断恢复：刷新/重启时仍在运行的迁移批次已被清洗为“已暂停（running 语义）”，
    // 从已完成文件之后自动续跑（排队项不重跑、完成项不覆盖）；用户显式暂停的批次保持暂停。
    this._resumeInterruptedMigrations();
    this._emit('load');;
  }

  /** 把一个（可能是旧版、可能损坏的）文档装载为当前状态。 */
  async _adopt(doc, { seed = false, keepReviewConflict = false } = {}) {
    this._templateStatusHealed = false;
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

    // 旧版布局批量迁移：结构/指纹清洗；running 文件回排队、批次收敛为已暂停（完成项不丢、顺序不变）
    this.migrationWarnings = [];
    this.migrations = sanitizeMigrations(doc.migrations, this.migrationWarnings);
    this._migrationRunners = new Map();

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

    // 发布门禁：候选 / 证据快照 / 门禁结果 / 审批意见 / 撤销记录随文档持久化；
    // 加载时只做结构清洗，过期 / 门禁由 releaseView() 在当前上下文上确定性重算。
    // _releasePendingApprovals 是【本页本地已接受、尚未被服务端确认】的批准：
    // 合流 adopt 必须保留（否则同 rev 并发审批的晚到 merged 响应无法识别本页意见被覆盖）。
    // _releasePendingApprovals 是【本页本地已接受、尚未被服务端确认】的批准：
    // adopt 始终保留（在飞保存的早一轮 merged 响应不能把并发审批检测所需记录清空；
    // 直存成功后的收敛在保存链按服务端确认的批准 id 进行）。
    const savedPendingApprovals = new Map(this._releasePendingApprovals || []);
    const savedReleaseProposals = keepReviewConflict ? new Map(this._releaseProposals || []) : new Map();
    this.releases = sanitizeReleases(doc.releases, { now: Date.now() });
    this.activeReleaseId = this.releases.some((x) => x.id === doc.activeReleaseId) ? doc.activeReleaseId : null;
    this._releaseSyncedRevs = {};
    this._releaseAuthoredRevs = new Map();
    for (const r of this.releases) this._releaseSyncedRevs[r.id] = r.rev;
    this._releaseProposals = savedReleaseProposals;
    this._releasePendingApprovals = savedPendingApprovals;
    if (!keepReviewConflict) this.releaseConflict = null;

    // 编辑分支三方合并草案：草案 / 共同祖先 / 冲突选择 / 来源关系 / 合并报告随文档持久化。
    // 加载时做确定性结构清洗（plan 在需要时由当前事件重建；选择按 key 保留，可逐项重新确认）。
    this.mergeDrafts = sanitizeMergeDrafts(doc.mergeDrafts);
    this.activeMergeDraftId = this.mergeDrafts.some((d) => d.id === doc.activeMergeDraftId) ? doc.activeMergeDraftId : null;
    this.mergeConflict = null;

    // 影响分析与安全变更：分析快照（绑定分析时文档版本 / 分支 head）/ 候选变更 / 模拟结果 /
    // 应用事件随文档持久化。加载时做确定性结构清洗；冲突原因保留到对应 open 快照上。
    this.impactWarnings = [];
    this.impactSnapshots = sanitizeImpactSnapshots(doc.impactSnapshots, this.impactWarnings);
    this.activeImpactId = this.impactSnapshots.some((x) => x.id === doc.activeImpactId) ? doc.activeImpactId : null;

    // 参数化约束模板：模板（草稿 + 只读版本）/ 实例链接随文档持久化。
    // 版本不可改写由 sanitizeTemplates（同 no 保留第一条）与发布流程共同保证；
    // 草稿乐观锁基线在装载时重置（本页自写 rev 由保存成功路径补登）。
    const savedTemplateConflict = keepReviewConflict ? this.templateConflict : null;
    this.templates = sanitizeTemplates(doc.templates);
    this.templateInstances = sanitizeInstances(doc.templateInstances);
    this.activeTemplateId = this.templates.some((t) => t.id === doc.activeTemplateId) ? doc.activeTemplateId : null;
    this._templateSyncedRevs = {};
    this._templateAuthoredRevs = new Map();
    for (const t of this.templates) this._templateSyncedRevs[t.id] = t.draftRev || 0;
    this.templateConflict = savedTemplateConflict && this.templates.some((t) => t.id === savedTemplateConflict.templateId)
      ? { ...savedTemplateConflict, serverDraftRev: this.templateById(savedTemplateConflict.templateId)?.draftRev ?? savedTemplateConflict.serverDraftRev }
      : null;

    // 按【当前分支 head】的 tpl 标签对齐实例记录 status：刷新 / 重启 / 合流重载后，
    // “画布链接已恢复但记录仍是 detached 墓碑”的旧状态（含旧版本存档）在此确定性愈合，
    // 与 undo/redo / 切分支走同一派生规则；有翻转时标记一次，由 load()/保存链补存。
    if (this.templateInstances.length) {
      const { instances, changed } = reconcileInstanceStatuses(this.templateInstances, this.headEvent.model);
      if (changed) {
        this.templateInstances = instances;
        this._templateStatusHealed = true;
      }
    }
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
    this.notifyBatches = sanitizeBatches(doc.notifyBatches);
    this.notifyDrafts = sanitizeDrafts(doc.notifyDrafts);
    const cleanItems = sanitizeNotifications(doc.notifications, { now });
    const mat = materializeNotifications(cleanItems, this.notifyRules, this.notifyEvents, { now });
    const cleanOutbox = sanitizeOutbox(doc.notifyOutbox, { now });
    const pumped = pumpNotifications(mat.items, cleanOutbox, { now, backoffMs: this.notifyBackoffMs, schedules: this._notifySchedules() });
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
    // 持久化草稿（批量部分冲突）→ 重建内存草稿映射；通知项已消失的草稿丢弃
    this._notifyItemDrafts = new Map();
    for (const d of this.notifyDrafts) {
      if (!liveIds.has(d.notifyId)) continue;
      const list = this._notifyItemDrafts.get(d.notifyId) || [];
      const desc = { kind: 'item', notifyId: d.notifyId, action: d.action, payload: d.payload || {}, at: d.at, by: d.by, draftId: d.id, reason: d.reason || '', persisted: true };
      if (!list.some((x) => x.draftId === d.id)) list.push(desc);
      this._notifyItemDrafts.set(d.notifyId, list);
    }
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

  /** ruleId -> 规则（含 schedule），供 pump 计算工作时段 / 静音窗口。 */
  _notifySchedules() {
    const m = new Map();
    for (const r of this.notifyRules) m.set(r.id, r);
    return m;
  }

  /** 某条通知当前是否处于规则静音 / 非工作时段（UI 横幅 / 卡片用）。 */
  notifyScheduleState(item, now = Date.now()) {
    const rule = this.notifyRuleById(item?.ruleId);
    const sch = rule?.schedule;
    if (!sch) return { closed: false, reason: '' };
    const closed = !scheduleIsOpenAt(sch, now);
    return { closed, reason: closed ? scheduleClosedReason(sch, now) : '' };
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
    const pumped = pumpNotifications(this.notifications, this.notifyOutbox, { now, backoffMs: this.notifyBackoffMs, schedules: this._notifySchedules() });
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
      migrations: this.migrations,
      auditWorkbench: this.auditWorkbench,
      reviewSessions: this.reviewSessions,
      activeReviewId: this.activeReviewId,
      notifyEvents: this.notifyEvents,
      notifyRules: this.notifyRules,
      notifications: this.notifications,
      notifyOutbox: this.notifyOutbox,
      notifyBatches: this.notifyBatches,
      notifyDrafts: this.notifyDrafts,
      releases: this.releases,
      activeReleaseId: this.activeReleaseId,
      mergeDrafts: this.mergeDrafts,
      activeMergeDraftId: this.activeMergeDraftId,
      impactSnapshots: this.impactSnapshots,
      activeImpactId: this.activeImpactId,
      templates: this.templates,
      templateInstances: this.templateInstances,
      activeTemplateId: this.activeTemplateId,
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
        // 发布门禁：候选被另一窗口前进（批准 / 撤销 / 重新生成）→ release-* 409，本地审批意见保留
        const releaseConflict = this._checkLocalReleaseConflict(prev, payload);
        if (releaseConflict) {
          this._onReleaseConflict(releaseConflict);
          return;
        }
        // 模板草稿：同一模板草稿被另一页面保存（draftRev 前进）→ 409 语义，
        // 明确提示版本冲突并保留本地草稿，绝不覆盖对方版本
        const templateConflict = this._checkLocalTemplateConflict(prev, payload);
        if (templateConflict) {
          this._onTemplateConflict(templateConflict);
          return;
        }
      }
      // 本地多页签合流：merged 已含本页当前分支最新提交，直接落合并结果
      const finalDoc = merged || { ...payload, rev: this.rev };
      // 实验按 id 合入磁盘（别的页签可能建了实验；完成结果永不被降级覆盖）
      finalDoc.experiments = mergeExperiments(prevExperiments || finalDoc.experiments || [], payload.experiments);
      // 迁移批次按 id 合入磁盘（同批次文件按 id 合并，done/导入记录不被降级覆盖）
      finalDoc.migrations = mergeMigrations(
        Array.isArray(prev?.migrations) ? prev.migrations : (finalDoc.migrations || []),
        payload.migrations || []);
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
      // 批量结果 append-only 并集；本地草稿按稳定 id 并集（失败项在刷新 / 多页签后仍保留）
      finalDoc.notifyBatches = mergeBatches(
        Array.isArray(prev?.notifyBatches) ? prev.notifyBatches : [], finalDoc.notifyBatches || []);
      finalDoc.notifyDrafts = mergeDrafts(
        Array.isArray(prev?.notifyDrafts) ? prev.notifyDrafts : [], finalDoc.notifyDrafts || []);
      // 发布候选按 id 并集（同 id rev 更大者整体胜出；审批/历史记录按 id 并集，审计链不丢）
      finalDoc.releases = mergeReleases(
        Array.isArray(prev?.releases) ? prev.releases : [], finalDoc.releases || []);
      finalDoc.activeReleaseId = finalDoc.releases.some((x) => x.id === finalDoc.activeReleaseId)
        ? finalDoc.activeReleaseId
        : (payload.activeReleaseId && finalDoc.releases.some((x) => x.id === payload.activeReleaseId) ? payload.activeReleaseId : null);
      finalDoc.activeReviewId = finalDoc.reviewSessions.some((x) => x.id === finalDoc.activeReviewId)
        ? finalDoc.activeReviewId
        : (payload.activeReviewId && finalDoc.reviewSessions.some((x) => x.id === payload.activeReviewId) ? payload.activeReviewId : null);
      // 合并草案按 id 合流（完成状态不降级、open 选择按键并集），刷新/多页签后草案与报告一致
      finalDoc.mergeDrafts = mergeMergeDrafts(
        Array.isArray(prev?.mergeDrafts) ? prev.mergeDrafts : (finalDoc.mergeDrafts || []),
        payload.mergeDrafts || []);
      finalDoc.activeMergeDraftId = finalDoc.mergeDrafts.some((x) => x.id === finalDoc.activeMergeDraftId)
        ? finalDoc.activeMergeDraftId
        : (payload.activeMergeDraftId && finalDoc.mergeDrafts.some((x) => x.id === payload.activeMergeDraftId) ? payload.activeMergeDraftId : null);
      // 影响分析快照按 id 合流（applied 不被 open 旧副本降级；open 以最近更新者为准），刷新/多页签后快照一致
      finalDoc.impactSnapshots = mergeImpactSnapshots(
        Array.isArray(prev?.impactSnapshots) ? prev.impactSnapshots : (finalDoc.impactSnapshots || []),
        payload.impactSnapshots || []);
      finalDoc.activeImpactId = finalDoc.impactSnapshots.some((x) => x.id === finalDoc.activeImpactId)
        ? finalDoc.activeImpactId
        : (payload.activeImpactId && finalDoc.impactSnapshots.some((x) => x.id === payload.activeImpactId) ? payload.activeImpactId : null);
      // 参数化约束模板：模板按 id 合流（草稿 draftRev 更大者胜出、已发布版本 no 并集不可改写），
      // 实例按 id 合流（updatedAt 更新者整体胜出、detached 墓碑不复活）
      finalDoc.templates = mergeTemplates(
        Array.isArray(prev?.templates) ? prev.templates : (finalDoc.templates || []),
        payload.templates || []);
      finalDoc.templateInstances = mergeInstances(
        Array.isArray(prev?.templateInstances) ? prev.templateInstances : (finalDoc.templateInstances || []),
        payload.templateInstances || []);
      finalDoc.activeTemplateId = finalDoc.templates.some((x) => x.id === finalDoc.activeTemplateId)
        ? finalDoc.activeTemplateId
        : (payload.activeTemplateId && finalDoc.templates.some((x) => x.id === payload.activeTemplateId) ? payload.activeTemplateId : null);
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
      for (const rc of payload.releases || []) {
        if (!this._releaseAuthoredRevs.has(rc.id)) this._releaseAuthoredRevs.set(rc.id, new Set());
        this._releaseAuthoredRevs.get(rc.id).add(rc.rev);
      }
      for (const t of payload.templates || []) {
        if (!this._templateAuthoredRevs.has(t.id)) this._templateAuthoredRevs.set(t.id, new Set());
        this._templateAuthoredRevs.get(t.id).add(t.draftRev || 0);
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
      merged.releases = mergeReleases(stored.releases || [], payload.releases || []);
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
    merged.releases = mergeReleases(stored.releases || [], payload.releases || []);
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
        baseReleaseRevs: this._baseReleaseRevs(),
        baseTemplateRevs: { ...this._templateSyncedRevs },
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
      // 快照本请求载荷中携带的候选批准：直存成功后只收敛这些批准的 pending，
      // 不能清空整个候选的 pending（在飞的后一轮请求可能在此响应到达前又本地批准）。
      const releaseApprovalsInFlight = new Map();
      // 同时保留批准明细（by/comment），合流响应 409 时用于把被拒批准保留为提案。
      const releaseApprovalDetailsInFlight = new Map();
      for (const r of payload.releases || []) {
        const ids = new Set((r.approvals || []).map((a) => a.id));
        releaseApprovalsInFlight.set(r.id, ids);
        releaseApprovalDetailsInFlight.set(r.id, (r.approvals || []).map((a) => ({ id: a.id, by: a.by, comment: a.comment || '' })));
      }
      // 请求发出前最后快照一次候选 / 批准：上面的 payload 可能是为早一轮防抖保存构造的，
      // await 期间本页刚做的批准只存在于 this.releases，必须带到请求与合流 409 检测里。
      payload.releases = [...this.releases];
      payload.baseReleaseRevs = this._baseReleaseRevs();
      releaseApprovalsInFlight.clear();
      releaseApprovalDetailsInFlight.clear();
      for (const r of payload.releases || []) {
        releaseApprovalsInFlight.set(r.id, new Set((r.approvals || []).map((a) => a.id)));
        releaseApprovalDetailsInFlight.set(r.id, (r.approvals || []).map((a) => ({ id: a.id, by: a.by, comment: a.comment || '' })));
      }
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
      // 发布候选冲突未解决：冲突候选的【本地过期内容】不外发（本地审批意见已保留为
      // proposal），其余候选 / 几何 / 审阅保存照常。携带服务端权威副本而非删除
      // （同 rev 直存时客户端文档即权威，删除会清掉服务端仍存在的候选）。
      if (this.releaseConflict) {
        const cid = this.releaseConflict.releaseId;
        const serverDoc0 = await this._fetchDoc().catch(() => null);
        const serverRelease = (serverDoc0?.releases || []).find((x) => x.id === cid);
        if (serverRelease) {
          payload.releases = (payload.releases || []).map((x) => (x.id === cid ? serverRelease : x));
        } else {
          payload.releases = (payload.releases || []).filter((x) => x.id !== cid);
        }
        delete payload.baseReleaseRevs[cid];
        body = JSON.stringify(payload);
      }
      // 模板草稿冲突未解决：冲突模板的【本地过期草稿】不外发（本地草稿已保留），
      // 其余模板 / 实例 / 几何保存照常。携带服务端权威副本而非删除（同 rev 直存时
      // 客户端文档即权威，删除会清掉服务端仍存在的模板与其版本）。
      if (this.templateConflict) {
        const cid = this.templateConflict.templateId;
        const serverDoc0 = await this._fetchDoc().catch(() => null);
        const serverTemplate = (serverDoc0?.templates || []).find((x) => x.id === cid);
        if (serverTemplate) {
          payload.templates = (payload.templates || []).map((x) => (x.id === cid ? serverTemplate : x));
        } else {
          payload.templates = (payload.templates || []).filter((x) => x.id !== cid);
        }
        delete payload.baseTemplateRevs[cid];
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
          // 影响分析安全变更在途：同分支被另一页面提交（branch-advanced）时由 impact 流程接管：
          // 记录冲突信息，applyImpact 会回滚本地事件推进并保留候选，绝不进入全局只读冲突态。
          if (this._impactApplying && (data.reason === 'branch-advanced' || data.error === 'revision-conflict')) {
            this._impactApplying.conflict = {
              branchId: this._impactApplying.branchId,
              headEventId: data.headEventId || null,
              headSeq: data.headSeq ?? null,
              serverRev: Number.isFinite(data.rev) ? data.rev : null,
            };
            return;
          }
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
          if (typeof data?.releaseId === 'string' && String(data.reason || '').startsWith('release-')) {
            // 发布门禁冲突（候选 rev 前进 / 证据过期 / 门禁阻断）：本地审批意见保留
            this._onReleaseConflict(data);
            return;
          }
          if (typeof data?.templateId === 'string' && String(data.reason || '').startsWith('template-')) {
            // 模板草稿冲突（另一页面已保存更新草稿）：本地草稿保留、明确提示，不覆盖对方
            this._onTemplateConflict({
              reason: data.reason, templateId: data.templateId,
              serverDraftRev: Number.isFinite(data.serverDraftRev) ? data.serverDraftRev : 0,
              localDraftRev: Number.isFinite(data.localDraftRev) ? data.localDraftRev : 0,
              localDraft: (this.templates.find((t) => t.id === data.templateId) || {}).draft || null,
              serverTemplate: data.template || null,
            });
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
          // 先快照本页在【请求发出时】载荷中的候选批准：合流按 rev 取一份会丢掉
          // 本页的同 rev 并发批准；adopt 后 this.releases 已被覆盖，无法再从本地状态读出。
          const rejectedReleasePreMerge = this._findRejectedInMerged(data.doc, releaseApprovalsInFlight);
          const myReview = this.reviewSessions;
          const myActiveReview = this.activeReviewId;
          const myProposals = this._reviewProposals;
          const myNotifyLocks = { rules: new Set(this._notifyLockedRules), items: new Set(this._notifyLockedItems), conflict: this.notifyConflict };
          const myReleases = this.releases;
          const myReleaseProposals = this._releaseProposals;
          await this._adopt(data.doc, { seed: false, keepReviewConflict: true });
          // 合流（跨分支 / 不同 rev）同样可能发生在同一候选的并发审批上：合流按 rev 取
          // 服务端值会丢掉本页的批准 / 撤销。优先用请求载荷里的批准 id 判定（adopt 不
          // 依赖待确认集合），再用待确认集合兜底；命中按 release 409 处理，本地意见保留。
          const rejectedRelease = rejectedReleasePreMerge || this._findPendingRejectedRelease(data.doc);
          if (rejectedRelease) {
            if (rejectedReleasePreMerge) {
              this._stashRejectedReleaseApprovals(rejectedReleasePreMerge, releaseApprovalsInFlight, releaseApprovalDetailsInFlight);
            }
            this._onReleaseConflict(rejectedRelease);
            return;
          }
          // 合流可能把本页已终结（送达/确认/转交）的旧队列条目从服务端并回：按墓碑剔除
          if (this._notifyOutboxTombstones.size) {
            this.notifyOutbox = this.notifyOutbox.filter((o) => !this._notifyOutboxTombstones.has(o.id));
          }
          // 权威队列已删除的墓碑收敛清除；仍残留的继续随后续 PUT 重发
          this._reconcileOutboxTombstones(data.doc?.notifyOutbox || []);
          // 合流文档以服务端为准，但本页刚刚提交且未被服务端纳入的审阅决定要保留为待合并提案
          this._carryReviewProposals(myReview, myProposals, myActiveReview, data.doc);
          // 合流文档里被拒的发布候选推进（另一窗口同 rev 批准/撤销）：本地审批意见保留为提案
          this._carryReleaseProposals(myReleases, myReleaseProposals, data.doc);
          // 通知中心冲突锁在合流重载后继续保留（本地未提交操作不丢）
          if (myNotifyLocks.conflict) {
            this._notifyLockedRules = myNotifyLocks.rules;
            this._notifyLockedItems = myNotifyLocks.items;
            this.notifyConflict = myNotifyLocks.conflict;
          }
          // 合流文档已含本页载荷的全部分支：把它们的 head 登记为已同步基线，
          // 否则从新分支切回原分支后首个提交会携带 fork 前的旧 head，被误判 branch-advanced。
          for (const b of this.branches) this._syncedHeads[b.id] = b.headEventId;
          this._dirty = false;
          // 合流文档里的实例 status 可能来自旧副本（仍是 detached 墓碑）：adopt 已按当前
          // head 愈合，若有翻转补存一次，让权威文档与画布链接状态一致。
          if (this._templateStatusHealed) {
            this._templateStatusHealed = false;
            this._dirty = true;
            this.persist();
          }
          this._emit('load');
          this._emit('saved', { rev: this.rev, merged: true });
          return;
        }
        if (Number.isFinite(data?.rev)) this.rev = data.rev;
        this._syncedHeads[this.currentBranchId] = this.branch.headEventId;
        // 直存时客户端文档即权威：载荷中其他分支的 head 也已随本次保存原子确认，
        // 同步它们的乐观基线（否则切回原分支后首个提交携带 fork 前旧 head 会被误判 branch-advanced）。
        for (const b of this.branches) {
          if (b.id !== this.currentBranchId) this._syncedHeads[b.id] = b.headEventId;
        }
        // 审阅基线只前进到服务端确认接受的 rev：同 rev 直存时服务端文档 == 本页载荷，
        // 载荷中每个会话都是权威值；合流路径（data.merged）在 _carryReviewProposals 中
        // 严格按服务端文档重算，绝不在此把本地未确认的 rev 当作已同步基线。
        for (const s of this.reviewSessions) {
          this._reviewSyncedRevs[s.id] = s.rev;
          this._reviewAuthoredRevs.get(s.id)?.add(s.rev);
        }
        // 发布候选基线前进到服务端确认值；只收敛本请求载荷携带的批准 id
        for (const r of this.releases) {
          this._releaseSyncedRevs[r.id] = r.rev;
          this._releaseAuthoredRevs.get(r.id)?.add(r.rev);
          const confirmed = releaseApprovalsInFlight.get(r.id) || new Set();
          if (confirmed.size) {
            const pend = (this._releasePendingApprovals.get(r.id) || []).filter((p) => !p.id || !confirmed.has(p.id));
            if (pend.length) this._releasePendingApprovals.set(r.id, pend);
            else this._releasePendingApprovals.delete(r.id);
          }
        }
        // 模板草稿基线前进到服务端确认值；已发布版本是 no 并集，不推进草稿基线
        for (const t of payload.templates || []) {
          this._templateSyncedRevs[t.id] = Math.max(this._templateSyncedRevs[t.id] || 0, t.draftRev || 0);
          this._templateAuthoredRevs.get(t.id)?.add(t.draftRev || 0);
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
    // head 回到上一条事件后，文档级实例记录（detach 墓碑等）必须随画布 tpl 标签一起回退：
    // 撤销“实例脱离”时实例记录恢复 linked、可升级状态与升级预览同时恢复；撤销“应用/升级”
    // 时记录保持原样（当前 head 上没有其约束，墓碑规则不变）。
    this._reconcileTemplateStatuses();
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
    // 重做“实例脱离”：标签再次移除、约束保留为普通约束，记录重新变为 detached。
    this._reconcileTemplateStatuses();
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
    // 新分支 head 是来源快照：实例记录状态按该 head 的 tpl 标签对齐
    this._reconcileTemplateStatuses();
    this._syncedHeads[id] = root.id;
    // 当前分支从原分支切走：其余已知分支的 head 都来自已装载的权威文档，补齐其乐观基线，
    // 否则以后切回原分支提交时 baseHeads 仍是 fork 前的旧值，会被误判 branch-advanced。
    for (const b of this.branches) {
      if (b.id !== id && this._syncedHeads[b.id] === undefined) this._syncedHeads[b.id] = b.headEventId;
    }
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
    // 切换到的分支 head 来自已装载的权威文档：登记为乐观基线，
    // 否则切分支后的首个提交 baseHeads 缺该分支，会被误判为 branch-advanced。
    if (this._syncedHeads[id] === undefined) this._syncedHeads[id] = b.headEventId;
    // 实例记录的 linked/detached 是相对当前分支 head 的：切换后按新 head 对齐
    this._reconcileTemplateStatuses();
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

  /* ==================== 编辑分支三方合并 ==================== */

  get activeMergeDraft() {
    return this.mergeDrafts.find((d) => d.id === this.activeMergeDraftId) || null;
  }

  mergeDraftById(id) { return this.mergeDrafts.find((d) => d.id === id) || null; }

  /** 取分支 head 事件；损坏 / 缺失返回 null。 */
  _branchHeadEvent(branchId) {
    const b = this.branches.find((x) => x.id === branchId);
    if (!b) return null;
    const ev = this.eventsById.get(b.headEventId);
    return ev && !ev.corrupt && ev.model ? ev : null;
  }

  /** 两分支当前 head 的共同祖先事件（无则 null）。 */
  mergeBaseFor(targetBranchId, sourceBranchId) {
    const t = this._branchHeadEvent(targetBranchId);
    const s = this._branchHeadEvent(sourceBranchId);
    if (!t || !s) return null;
    return findMergeBase(t, s, this.eventsById);
  }

  /**
   * 为一对分支重建确定性合并计划（不落盘）。
   * 可选 headId 覆盖（更新到最新 head / 重开草案时用）。
   */
  buildMergeView(targetBranchId, sourceBranchId, { targetHeadId = null, sourceHeadId = null } = {}) {
    const tb = this.branches.find((x) => x.id === targetBranchId);
    const sb = this.branches.find((x) => x.id === sourceBranchId);
    if (!tb || !sb) return { ok: false, reason: 'branch-missing', message: '分支不存在或已被删除' };
    if (tb.id === sb.id) return { ok: false, reason: 'same-branch', message: '来源分支与目标分支不能相同' };
    const te0 = this.eventsById.get(targetHeadId || tb.headEventId);
    const se0 = this.eventsById.get(sourceHeadId || sb.headEventId);
    const te = te0 && !te0.corrupt && te0.model ? te0 : null;
    const se = se0 && !se0.corrupt && se0.model ? se0 : null;
    if (!te || !se) return { ok: false, reason: 'head-corrupt', message: '分支 head 事件损坏或缺失，无法合并' };
    const plan = buildMergePlan({
      targetEvent: te, sourceEvent: se, targetBranch: tb, sourceBranch: sb, byId: this.eventsById,
    });
    if (!plan.ok) return { ok: false, reason: plan.reason, message: plan.message };
    const models = { base: this.eventsById.get(plan.baseEventId)?.model, target: te.model, source: se.model };
    return { ok: true, plan, models, targetEvent: te, sourceEvent: se };
  }

  /**
   * 打开（或复用）一个合并草案：同对 head 派生确定性 id，重复打开不产生重复草案。
   * 已存在的 open 草案保留其冲突选择；completed 草案直接返回（可查看报告）。
   */
  openMergeDraft(targetBranchId, sourceBranchId) {
    if (this.replaying) return { ok: false, error: '回放模式为只读，请先退出回放' };
    const view = this.buildMergeView(targetBranchId, sourceBranchId);
    if (!view.ok) return { ok: false, error: view.message };
    const { plan } = view;
    const id = mergeDraftId(plan);
    let draft = this.mergeDrafts.find((d) => d.id === id);
    if (!draft) {
      draft = makeMergeDraft(plan, { actor: this.actor || '未署名' });
      this.mergeDrafts = [...this.mergeDrafts, draft];
    } else if (draft.status !== 'open') {
      return { ok: false, idempotent: true, draft, plan: view.plan, models: view.models,
        error: '该合并草案已完成，请直接查看合并事件与报告' };
    }
    this.activeMergeDraftId = id;
    this.mergeConflict = null;
    this._dirty = true;
    this.persist();
    this._emit('merge', { type: 'open', id });
    return { ok: true, draft, plan: view.plan, models: view.models,
      targetEvent: view.targetEvent, sourceEvent: view.sourceEvent };
  }

  selectMergeDraft(id) {
    if (id && !this.mergeDrafts.some((d) => d.id === id)) return { ok: false };
    this.activeMergeDraftId = id || null;
    this._dirty = true;
    this.persist();
    this._emit('merge', { type: 'select', id });
    return { ok: true };
  }

  /** 重建一个已持久化草案对应的计划（共同祖先 / 自动项 / 冲突项随当前事件重新计算）。 */
  viewForDraft(draft) {
    if (!draft) return { ok: false, reason: 'missing', message: '合并草案不存在' };
    return this.buildMergeView(draft.targetBranchId, draft.sourceBranchId, {
      targetHeadId: draft.targetHeadId, sourceHeadId: draft.sourceHeadId,
    });
  }

  /** 草案对应计划与冲突选择 map（自动项不在草案里，由 plan 确定性推出）。 */
  mergeDraftView(id = this.activeMergeDraftId) {
    const draft = this.mergeDraftById(id);
    if (!draft) return null;
    const view = this.viewForDraft(draft);
    if (!view.ok) return { draft, ok: false, reason: view.reason, message: view.message };
    return {
      draft, ok: true, ...view,
      choices: choicesToMap(draft.choices),
      priorChoices: choicesToMap(draft.priorChoices),
    };
  }

  /** 目标分支是否已在草案打开后前进（仅本地视图）。 */
  mergeTargetAdvanced(draft) {
    const tb = this.branches.find((b) => b.id === draft.targetBranchId);
    return !!(tb && draft.status === 'open' && tb.headEventId !== draft.targetHeadId);
  }

  /**
   * 合并提交前核对目标分支 head：本地视图前进优先返回；否则向服务端拉取权威文档核对。
   * 服务端不可达（离线）时退回本地判断；返回 null 表示可以提交。
   */
  async _checkMergeTargetAdvanced(draft) {
    const tb0 = this.branches.find((b) => b.id === draft.targetBranchId);
    if (!tb0) return { targetBranchId: draft.targetBranchId, targetHeadId: null, targetHeadSeq: null };
    if (this.mergeTargetAdvanced(draft)) {
      const head = this.eventsById.get(tb0.headEventId);
      return { targetBranchId: tb0.id, targetHeadId: tb0.headEventId, targetHeadSeq: head?.seq ?? null };
    }
    const sb0 = this.branches.find((b) => b.id === draft.sourceBranchId);
    if (sb0 && sb0.headEventId !== draft.sourceHeadId) {
      const head = this.eventsById.get(sb0.headEventId);
      return {
        sourceAdvanced: true,
        targetBranchId: draft.targetBranchId, targetHeadId: tb0.headEventId,
        targetHeadSeq: this.eventsById.get(tb0.headEventId)?.seq ?? null,
        sourceBranchId: sb0.id, sourceHeadId: sb0.headEventId, sourceHeadSeq: head?.seq ?? null,
      };
    }
    let serverDoc = null;
    try { serverDoc = await this._fetchDoc(); } catch { serverDoc = null; }
    if (!serverDoc) return null; // 离线 / 后端不可用：本地 OCC（保存时仍有分支头检查）兜底
    const srv = (Array.isArray(serverDoc.branches) ? serverDoc.branches : [])
      .find((b) => b && b.id === draft.targetBranchId);
    if (srv && srv.headEventId && srv.headEventId !== draft.targetHeadId) {
      const ev = (Array.isArray(serverDoc.events) ? serverDoc.events : [])
        .find((e) => e && e.id === srv.headEventId);
      return {
        targetBranchId: srv.id, targetHeadId: srv.headEventId,
        targetHeadSeq: ev?.seq ?? null, serverRev: Number.isFinite(serverDoc.rev) ? serverDoc.rev : null,
      };
    }
    const srvS = (Array.isArray(serverDoc.branches) ? serverDoc.branches : [])
      .find((b) => b && b.id === draft.sourceBranchId);
    if (srvS && srvS.headEventId && srvS.headEventId !== draft.sourceHeadId) {
      const evS = (Array.isArray(serverDoc.events) ? serverDoc.events : [])
        .find((e) => e && e.id === srvS.headEventId);
      return {
        sourceAdvanced: true,
        targetBranchId: draft.targetBranchId, targetHeadId: tb0.headEventId,
        sourceBranchId: srvS.id, sourceHeadId: srvS.headEventId, sourceHeadSeq: evS?.seq ?? null,
        serverRev: Number.isFinite(serverDoc.rev) ? serverDoc.rev : null,
      };
    }
    return null;
  }

  /** 更新一项冲突选择（保留目标 / 采用来源 / 手动填写结果；manual=null 表示手动选择删除）。 */
  setMergeResolution(draftId, key, resolution, manual = null) {
    const draft = this.mergeDraftById(draftId);
    if (!draft) return { ok: false, error: '合并草案不存在' };
    if (draft.status !== 'open') return { ok: false, error: '该草案已结束，不能修改选择' };
    const view = this.viewForDraft(draft);
    if (!view.ok) return { ok: false, error: view.message };
    const item = [...view.plan.rects.conflicts, ...view.plan.constraints.conflicts].find((x) => itemKey(x) === key);
    if (!item) return { ok: false, error: '该冲突项不属于当前合并计划（共同祖先可能已变化）' };
    if (!['target', 'source', 'manual'].includes(resolution)) return { ok: false, error: '非法选择' };

    let manualNorm = null;
    if (resolution === 'manual') {
      const chk = this._checkManualMergeValue(item, manual, view.models);
      if (!chk.ok) return { ok: false, error: chk.error };
      manualNorm = chk.value;
    }
    const nowSel = Date.now();
    const choices = draft.choices.filter((c) => c.key !== key);
    choices.push({ key, resolution, at: nowSel, ...(resolution === 'manual' ? { manual: manualNorm } : {}) });
    choices.sort((a, b) => (a.key < b.key ? -1 : 1));
    // 重新确认后，该项的旧选择不再需要作为参考提示
    const priorChoices = (draft.priorChoices || []).filter((c) => c.key !== key);
    this._replaceMergeDraft({ ...draft, choices, priorChoices, updatedAt: nowSel });
    this._dirty = true;
    this.persist();
    this._emit('merge', { type: 'resolution', id: draftId, key });
    return { ok: true };
  }

  /** 手动结果值校验：矩形要形状合法；约束要结构合法且引用存在的矩形（否则阻止完成）。 */
  _checkManualMergeValue(item, value, models) {
    if (value === null || value === undefined) return { ok: true, value: null }; // 手动删除
    if (item.kind === 'rect') {
      const r = value;
      if (!r || typeof r !== 'object' || typeof r.id !== 'string') return { ok: false, error: '手动矩形缺少 id' };
      if (![r.x, r.y, r.w, r.h].every((v) => Number.isFinite(v))) return { ok: false, error: '矩形坐标/尺寸必须是数字' };
      if (!(r.w > 0) || !(r.h > 0)) return { ok: false, error: '矩形宽高必须为正数' };
      return { ok: true, value: {
        id: r.id, name: String(r.name || ''),
        x: r.x, y: r.y, w: r.w, h: r.h,
      } };
    }
    const c = value;
    if (!c || typeof c !== 'object' || typeof c.id !== 'string') return { ok: false, error: '手动约束缺少 id' };
    // 用一次完整合并模型 + validate 校验结构与引用；这里先做字段级兜底
    const known = new Set([...models.target.rects, ...models.source.rects].map((r) => r.id));
    if (!known.has(c.rect)) return { ok: false, error: '手动约束的跟随矩形不存在（会产生悬空引用）' };
    if ((c.kind === 'snap' || c.kind === 'minGap') && !known.has(c.other)) {
      return { ok: false, error: '手动约束引用的锚点矩形不存在（会产生悬空引用）' };
    }
    return { ok: true, value: structuredClone(c) };
  }

  /**
   * 合并预览：应用当前选择后的模型、求解报告、未解决冲突、阻止项。
   * 不写任何审计事件。choices 缺省时取草案已保存的选择。
   */
  previewMerge(draftId, extraChoices = null) {
    const draft = this.mergeDraftById(draftId);
    if (!draft) return { ok: false, errors: [{ code: 'missing', message: '合并草案不存在' }] };
    const view = this.viewForDraft(draft);
    if (!view.ok) return { ok: false, errors: [{ code: view.reason, message: view.message }] };
    const { plan, models } = view;
    const choices = extraChoices || choicesToMap(draft.choices);

    const assembled = assembleMergeModel(plan, choices, models);
    if (!assembled.ok) {
      return {
        ok: false, plan, models, choices,
        unresolved: assembled.unresolved,
        errors: assembled.unresolved.map((k) => ({ code: 'unresolved', message: `冲突项尚未选择处理方式：${k}` })),
      };
    }
    const fin = finalizeMergeModel(assembled.model);
    return {
      ok: fin.ok, plan, models, choices,
      model: fin.model || assembled.model,
      report: fin.report || null,
      errors: fin.errors,
      cycle: fin.cycle,
      unresolved: [],
    };
  }

  /**
   * 更新草案到最新的目标 / 来源 head（用户“更新到最新分支头”）。
   * 旧冲突选择一律【不再直接生效】：
   *   - 新计划中仍是双方冲突的项，旧选择移入 priorChoices 仅供参考，冲突回到未确认状态，
   *     必须逐项再次选择（每项可一键沿用旧选择，但仍是一次明确的重新确认）；
   *   - 新计划里变成自动项 / 对象消失 / 两边趋同的旧选择直接丢弃；
   *   - 新出现的冲突同样为未确认。
   * 只有全部冲突重新选择后才允许提交。
   */
  refreshMergeDraftHeads(draftId, { targetHeadId = null, sourceHeadId = null } = {}) {
    const draft = this.mergeDraftById(draftId);
    if (!draft) return { ok: false, error: '合并草案不存在' };
    if (draft.status !== 'open') return { ok: false, error: '该草案已结束' };
    const tb = this.branches.find((b) => b.id === draft.targetBranchId);
    const sb = this.branches.find((b) => b.id === draft.sourceBranchId);
    const newTargetHead = targetHeadId || tb?.headEventId;
    const newSourceHead = sourceHeadId || sb?.headEventId;
    const view = this.buildMergeView(draft.targetBranchId, draft.sourceBranchId, {
      targetHeadId: newTargetHead, sourceHeadId: newSourceHead,
    });
    if (!view.ok) return { ok: false, error: view.message };
    const newId = mergeDraftId(view.plan);
    const conflictKeys = [...view.plan.rects.conflicts, ...view.plan.constraints.conflicts].map(itemKey);
    const now = Date.now();
    // 旧选择全部重置：仍存在冲突的移入参考列表，其余丢弃；新草案 choices 为空
    const rebased = rebaseConflictChoices(draft.choices, conflictKeys, now);

    if (newId === draft.id) {
      // head 未变（可能只是来源前进）：旧选择同样重置为未确认，仅保留参考
      this._replaceMergeDraft({
        ...draft, choices: rebased.choices, priorChoices: rebased.priorChoices,
        refreshedAt: now, updatedAt: now,
      });
    } else {
      // head 变化：旧 open 草案标记 superseded（保留记录与来源关系），新建草案；旧选择只作参考
      const old = { ...draft, status: 'superseded', supersededBy: newId, updatedAt: now };
      const nd0 = makeMergeDraft(view.plan, { actor: draft.actor || this.actor || '未署名' });
      const nd = freeze({ ...nd0, choices: [], priorChoices: rebased.priorChoices, refreshedAt: now });
      this.mergeDrafts = this.mergeDrafts.map((d) => (d.id === old.id ? freeze({ ...old }) : d));
      if (!this.mergeDrafts.some((d) => d.id === nd.id)) this.mergeDrafts = [...this.mergeDrafts, nd];
      this.activeMergeDraftId = nd.id;
    }
    this.mergeConflict = null;
    this._dirty = true;
    this.persist();
    this._emit('merge', { type: 'refresh-heads', id: this.activeMergeDraftId });
    return { ok: true, id: this.activeMergeDraftId, prior: rebased.priorChoices.length };
  }

  /** 放弃草案（不影响任何事件）。 */
  abandonMergeDraft(draftId) {
    const draft = this.mergeDraftById(draftId);
    if (!draft) return { ok: false, error: '合并草案不存在' };
    if (draft.status === 'open') {
      this._replaceMergeDraft({ ...draft, status: 'abandoned', updatedAt: Date.now() });
      this._dirty = true;
      this.persist();
    }
    if (this.activeMergeDraftId === draftId) this.activeMergeDraftId = null;
    this._emit('merge', { type: 'abandon', id: draftId });
    return { ok: true };
  }

  /**
   * 提交合并：校验全部冲突已解决且结果通过结构 / 悬空 / 环 / 越界检查后，
   * 在【目标分支】head 之后追加一条 kind='merge' 的审计事件。
   * 原分支事件、来源分支与历史一律不改写。
   *
   * 幂等：同草案同结果重复提交直接返回既有 merge 事件，绝不产生重复事件。
   * 合并期间目标分支已前进（另一页面提交，本地或服务端 head 不再是草案基线）
   * -> status 409 merge-target-advanced，不追加任何事件，本地选择原样保留，
   * 用户更新到最新分支头后可逐项重新确认。
   */
  async commitMerge(draftId, { label = '' } = {}) {
    if (this.saveConflict) return { ok: false, status: 409, reason: 'branch-advanced', error: '版本冲突未解决，请先重新加载' };
    const draft = this.mergeDraftById(draftId);
    if (!draft) return { ok: false, status: 404, error: '合并草案不存在' };
    if (draft.status === 'completed' && draft.mergeEventId) {
      const existing = this.eventsById.get(draft.mergeEventId);
      if (existing) return { ok: true, idempotent: true, event: existing, draft };
    }
    if (draft.status !== 'open') return { ok: false, error: '该合并草案已结束' };

    // 合并期间目标 / 来源分支前进：本地已知（localStorage 多页签合流）或服务端权威 head 已变 => 409
    const advancedInfo = await this._checkMergeTargetAdvanced(draft);
    if (advancedInfo) {
      const reason = advancedInfo.sourceAdvanced ? 'merge-source-advanced' : 'merge-target-advanced';
      this.mergeConflict = { draftId, reason, ...advancedInfo, at: Date.now() };
      this._emit('merge', { type: 'conflict', id: draftId });
      return {
        ok: false, status: 409, reason,
        error: advancedInfo.sourceAdvanced
          ? `合并期间来源分支已前进到 #${advancedInfo.sourceHeadSeq ?? '?'}，请更新到最新分支头后逐项重新确认`
          : `合并期间目标分支已前进到 #${advancedInfo.targetHeadSeq ?? '?'}，请更新到最新分支头后逐项重新确认`,
        ...advancedInfo, conflict: this.mergeConflict,
      };
    }

    const view = this.previewMerge(draftId);
    if (!view.ok) {
      const first = view.unresolved?.length
        ? `还有 ${view.unresolved.length} 个冲突未选择处理方式`
        : (view.errors?.[0]?.message || '合并结果未通过校验');
      return { ok: false, reason: 'merge-blocked', error: first, errors: view.errors, unresolved: view.unresolved, cycle: view.cycle };
    }

    const targetEvent = this._branchHeadEvent(draft.targetBranchId);
    const sourceEvent = this._branchHeadEvent(draft.sourceBranchId) || this.eventsById.get(draft.sourceHeadId);
    const tb = this.branches.find((b) => b.id === draft.targetBranchId);
    const sb = this.branches.find((b) => b.id === draft.sourceBranchId);
    const choices = choicesToMap(draft.choices);

    // 二次幂等：同结果指纹的合并事件已在目标分支上 -> 直接复用
    const resultHash = view.report.hash;
    const already = this._findMergeEvent(tb, draft.id, resultHash);
    if (already) {
      this._markDraftCompleted(draft, already, view, choices, tb, sb, targetEvent, sourceEvent, { idempotent: true });
      return { ok: true, idempotent: true, event: already, draft: this.mergeDraftById(draftId) };
    }

    const resolutions = [...choices.entries()].map(([key, ch]) => ({
      key, resolution: ch.resolution, ...(ch.manual ? { manual: true } : {}),
    })).sort((a, b) => (a.key < b.key ? -1 : 1));

    const plan = view.plan;
    const mergeMeta = {
      baseEventId: plan.baseEventId,
      sourceBranchId: plan.sourceBranchId,
      sourceHeadId: plan.sourceHeadId,
      sourceHeadSeq: plan.sourceHeadSeq,
      draftId: draft.id,
      auto: plan.counts.auto,
      conflicts: plan.counts.conflicts,
      resolutions,
      report: null, // 完成后回填完整报告（见下）
    };
    const mergeLabel = label || `合并来源「${sb.name}」#${sourceEvent?.seq ?? plan.sourceHeadSeq} 到「${tb.name}」`;
    const ev = makeMergeEvent(targetEvent, tb.id, view.model, view.report, {
      actor: this.actor || '未署名', label: mergeLabel, t: Date.now(), merge: mergeMeta,
    });

    this.events = [...this.events, ev];
    this.eventsById.set(ev.id, ev);
    this._replaceBranch({
      ...tb,
      headEventId: ev.id,
      redoTipId: null,
    });
    // 合并不是对“当前编辑分支”的提交：完成后切到目标分支，保证保存时它作为 currentBranch
    // 随保存链确认（否则跨分支合流会保留服务端 head，丢掉刚追加的合并事件）。
    const wasCurrent = this.currentBranchId === tb.id;
    this.currentBranchId = tb.id;
    this.replayEventId = null;
    this.replaySnapshot = null;
    // 合并结果成为新 head：实例记录 status 按合并后模型的 tpl 标签对齐
    this._reconcileTemplateStatuses();

    // 回填完整合并报告（合并前后差异 + 逐项裁决）到事件与草案
    const report = buildMergeReport({
      plan, choices, targetEvent, outcome: { model: view.model, report: view.report },
      mergeEventId: ev.id, completedAt: ev.t,
    });
    const evWithReport = freeze({ ...ev, merge: { ...ev.merge, report } });
    this.events = this.events.map((x) => (x.id === ev.id ? evWithReport : x));
    this.eventsById.set(ev.id, evWithReport);

    this._markDraftCompleted(draft, evWithReport, view, choices, tb, sb, targetEvent, sourceEvent, { report });
    this._syncedHeads[tb.id] = draft.targetHeadId; // 乐观基线=合并前 head；保存确认后在 _sendLatest 推进到 ev
    this._dirty = true;
    this.persist();
    this._emit('merge', { type: 'commit', id: draftId, eventId: ev.id });
    this._emit('branch', { type: 'merge-commit', id: tb.id });
    this._emit('change', { label: 'merge' });
    return { ok: true, idempotent: false, event: evWithReport, draft: this.mergeDraftById(draftId), report };
  }

  _findMergeEvent(tb, draftId, resultHash) {
    // 沿目标分支当前链找带同 draftId（或同结果指纹）的 merge 事件
    let cur = this.eventsById.get(tb.headEventId);
    let guard = 0;
    while (cur && guard++ < 100000) {
      if (cur.kind === 'merge' && cur.merge && (cur.merge.draftId === draftId || cur.hash === resultHash)) return cur;
      cur = cur.parentId ? this.eventsById.get(cur.parentId) : null;
    }
    return null;
  }

  _markDraftCompleted(draft, ev, view, choices, tb, sb, targetEvent, sourceEvent, { report = null, idempotent = false } = {}) {
    const fullReport = report || (ev.merge?.report && ev.merge.report.mergeEventId === ev.id
      ? ev.merge.report
      : buildMergeReport({
        plan: view.plan, choices, targetEvent,
        outcome: { model: ev.model, report: ev.report }, mergeEventId: ev.id, completedAt: ev.t,
      }));
    const completed = freeze({
      ...draft,
      status: 'completed',
      completedAt: ev.t,
      mergeEventId: ev.id,
      resultHash: ev.hash,
      targetHeadId: ev.id,
      report: fullReport,
      updatedAt: Date.now(),
    });
    this.mergeDrafts = this.mergeDrafts.map((d) => (d.id === draft.id ? completed : d));
    if (this.activeMergeDraftId === draft.id) this.activeMergeDraftId = draft.id;
    if (!idempotent) this._dirty = true;
  }

  _replaceMergeDraft(next) {
    this.mergeDrafts = this.mergeDrafts.map((d) => (d.id === next.id ? freeze(next) : d));
  }

  /** 查看合并事件的完整合并报告（前后差异 + 逐项裁决）；非合并事件返回 null。 */
  mergeReportForEvent(eventId) {
    const ev = this.eventsById.get(eventId);
    return ev?.kind === 'merge' ? (ev.merge?.report || null) : null;
  }

  /* ==================== 影响分析与安全变更 ==================== */

  get activeImpact() {
    return this.impactSnapshots.find((x) => x.id === this.activeImpactId) || null;
  }

  impactById(id) { return this.impactSnapshots.find((x) => x.id === id) || null; }

  /** 当前分支 head 的只读影响分析预览（不落盘）。rectIds 非空时种子取第一个选中矩形。 */
  previewImpact(seed) {
    if (this.replaying) return { ok: false, error: '回放模式为只读，请先退出回放' };
    const head = this.headEvent;
    if (!head?.model) return { ok: false, error: '当前分支没有可分析的布局' };
    if (!seed || !['rect', 'constraint'].includes(seed.kind)) return { ok: false, error: '请先选择一个矩形或约束' };
    if (seed.kind === 'rect' && !head.model.rects.some((r) => r.id === seed.id)) {
      return { ok: false, error: '选中的矩形不存在' };
    }
    if (seed.kind === 'constraint' && !head.model.constraints.some((c) => c.id === seed.id)) {
      return { ok: false, error: '选中的约束不存在' };
    }
    const impact = analyzeImpact(head.model, seed, { simulation: null, baseReport: head.report });
    if (!impact.seed.valid) return { ok: false, error: '选中的对象不存在，无法展开影响面' };
    return { ok: true, impact, model: head.model, report: head.report };
  }

  /**
   * 为当前分支 head 创建（或复用同内容的）影响分析快照并绑定分析时的文档版本。
   * 快照记录完整基线模型 / 求解报告：之后分支继续前进，分析仍基于同一版本可查看、可模拟。
   */
  createImpactAnalysis(seed, { name = '', changes = null } = {}) {
    if (this.replaying) return { ok: false, error: '回放模式为只读，请先退出回放或另存为新分支' };
    const preview = this.previewImpact(seed);
    if (!preview.ok) return preview;
    const head = this.headEvent;
    const normChanges = this._normalizeChanges(changes || []);
    if (normChanges.errors.length) return { ok: false, error: normChanges.errors[0] };

    const id = impactSnapshotId({
      branchId: this.currentBranchId, headEventId: head.id,
      seed: { kind: seed.kind, id: seed.id }, changes: normChanges.list,
    });
    const existed = this.impactSnapshots.some((x) => x.id === id);
    let snap = this.impactSnapshots.find((x) => x.id === id);
    let simulation = null;
    let impact = preview.impact;
    if (normChanges.list.length) {
      simulation = simulateChanges(head.model, head.report, normChanges.list);
      impact = analyzeImpact(head.model, seed, { simulation, baseReport: head.report });
    }
    if (!snap) {
      snap = makeImpactSnapshot({
        id,
        name: String(name || '').trim() || this._defaultImpactName(seed, head.model),
        seed: { kind: seed.kind, id: seed.id },
        branchId: this.currentBranchId,
        branchName: this.branch?.name || '',
        headEventId: head.id,
        docRev: this.rev,
        baseModel: head.model,
        baseReport: head.report,
        baseHash: head.hash,
        changes: normChanges.list,
        simulation,
        analysis: impact,
        actor: this.actor || '',
      });
      this.impactSnapshots = [...this.impactSnapshots, snap];
    } else if (normChanges.list.length) {
      // 同 id 快照更新候选（同分支 head + 同种子 + 同候选内容才会同 id，正常不会走到；保留确定性兜底）
      snap = this._replaceImpact({ ...snap, changes: normChanges.list, simulation, impact, updatedAt: Date.now() });
    }
    this.activeImpactId = id;
    this._dirty = true;
    this.persist();
    this._emit('impact', { type: 'create', id });
    return { ok: true, snapshot: snap, impact, simulation, reused: existed };
  }

  _defaultImpactName(seed, model) {
    if (seed.kind === 'rect') {
      const r = model.rects.find((x) => x.id === seed.id);
      return `影响分析：矩形「${r?.name || seed.id}」`;
    }
    const c = model.constraints.find((x) => x.id === seed.id);
    const label = c ? constraintLabel(c, new Map(model.rects.map((r) => [r.id, r]))) : seed.id;
    return `影响分析：${label}`;
  }

  _normalizeChanges(rawList) {
    const list = [];
    const errors = [];
    (Array.isArray(rawList) ? rawList : []).forEach((raw, i) => {
      const norm = normalizeChange(raw, { idx: i });
      if (norm.error) errors.push(`第 ${i + 1} 项：${norm.error}`);
      else if (!list.some((x) => x.id === norm.value.id)) list.push(norm.value);
    });
    list.sort((a, b) => (a.id < b.id ? -1 : 1));
    return { list, errors };
  }

  /**
   * 更新快照的候选变更集合（添加 / 替换 / 逐项放弃），并重跑确定性模拟。
   * mode='replace'（默认）整体替换；'discard' 放弃指定 changeId 列表（逐项放弃候选）。
   */
  updateImpactCandidates(id, rawChanges, { mode = 'replace' } = {}) {
    const snap = this.impactById(id);
    if (!snap) return { ok: false, error: '影响分析快照不存在' };
    if (snap.status !== 'open') return { ok: false, error: `该分析已${snap.status === 'applied' ? '应用' : '放弃'}，不能再修改候选` };
    let next;
    if (mode === 'discard') {
      const drop = new Set(Array.isArray(rawChanges) ? rawChanges : [rawChanges]);
      next = snap.changes.filter((c) => !drop.has(c.id));
    } else {
      const norm = this._normalizeChanges(rawChanges);
      if (norm.errors.length) return { ok: false, error: norm.errors[0] };
      next = norm.list;
    }
    const simulation = next.length
      ? simulateChanges(snap.baseModel, snap.baseReport, next)
      : null;
    const impact = analyzeImpact(snap.baseModel, snap.seed, { simulation, baseReport: snap.baseReport });
    const updated = freeze({
      ...snap,
      changes: next,
      simulation,
      impact,
      conflict: null, // 候选变化后旧的版本冲突原因不再适用；应用时重新核对
      updatedAt: Date.now(),
    });
    this._replaceImpact(updated);
    this._dirty = true;
    this.persist();
    this._emit('impact', { type: 'candidates', id });
    return { ok: true, snapshot: this.impactById(id), simulation, impact };
  }

  /** 逐项放弃一个候选变更（其余候选保留并重新模拟）。 */
  discardImpactChange(id, changeId) {
    return this.updateImpactCandidates(id, [changeId], { mode: 'discard' });
  }

  selectImpact(id) {
    if (id && !this.impactSnapshots.some((x) => x.id === id)) return { ok: false };
    this.activeImpactId = id || null;
    this._dirty = true;
    this.persist();
    this._emit('impact', { type: 'select', id });
    return { ok: true };
  }

  /** 放弃整张分析快照（候选与模拟一并标记 abandoned；审计事件不受影响）。 */
  abandonImpact(id) {
    const snap = this.impactById(id);
    if (!snap) return { ok: false, error: '影响分析快照不存在' };
    if (snap.status === 'open') {
      this._replaceImpact(freeze({ ...snap, status: 'abandoned', updatedAt: Date.now() }));
      this._dirty = true;
      this.persist();
    }
    if (this.activeImpactId === id) this.activeImpactId = null;
    this._emit('impact', { type: 'abandon', id });
    return { ok: true };
  }

  /** 用当前候选重跑模拟（纯查看；基线固定为分析时版本）。 */
  resimulateImpact(id, extraChanges = null) {
    const snap = this.impactById(id);
    if (!snap) return { ok: false, error: '影响分析快照不存在' };
    const changes = extraChanges || snap.changes;
    const simulation = simulateChanges(snap.baseModel, snap.baseReport, changes);
    const impact = analyzeImpact(snap.baseModel, snap.seed, { simulation, baseReport: snap.baseReport });
    return { ok: true, simulation, impact };
  }

  /** 快照绑定的分支 head 在本地是否已前进。 */
  impactBranchAdvanced(snap) {
    const b = this.branches.find((x) => x.id === snap.branchId);
    return !!(b && snap.status === 'open' && b.headEventId !== snap.headEventId);
  }

  /**
   * 正式应用一组候选变更：
   *  - 快照绑定分析时文档版本（docRev / headEventId / baseHash）；应用前核对本地与服务端权威 head，
   *    文档或当前分支已前进 -> 409 impact-branch-advanced，不追加任何事件，候选原样保留；
   *  - 模拟阻断项（结构 / 悬空 / 环 / 越界）-> 拒绝，不追加事件，无部分修改；
   *  - 同一组候选（同快照 / 同结果指纹）重复提交 -> 幂等返回既有 impact 事件；
   *  - 通过后在快照分支一次性追加一条 kind='impact' 审计事件（原子提交），快照标记 applied。
   */
  async applyImpact(id, { label = '' } = {}) {
    if (this.replaying) return { ok: false, status: 403, reason: 'replay-readonly', error: '回放模式为只读，请先退出回放或另存为新分支' };
    if (this.saveConflict) return { ok: false, status: 409, reason: 'branch-advanced', error: '版本冲突未解决，请先重新加载' };
    const snap0 = this.impactById(id);
    if (!snap0) return { ok: false, status: 404, error: '影响分析快照不存在' };
    if (snap0.status === 'applied' && snap0.appliedEventId) {
      const existing = this.eventsById.get(snap0.appliedEventId);
      if (existing) return { ok: true, idempotent: true, event: existing, snapshot: snap0 };
    }
    if (snap0.status !== 'open') return { ok: false, error: '该影响分析已放弃，不能应用' };

    // 1) 版本核对：本地分支 head 前进优先返回；否则拉服务端权威文档核对
    const advanced = await this._checkImpactAdvanced(snap0);
    if (advanced) {
      const conflict = { reason: 'impact-branch-advanced', ...advanced, at: Date.now() };
      this._replaceImpact(freeze({ ...snap0, conflict, updatedAt: Math.max(snap0.updatedAt || 0, Date.now()) }));
      this._emit('impact', { type: 'conflict', id });
      // 采用服务端权威文档再保存冲突状态（快照按 id 合流保留），避免随后保存撞上同分支 409
      await this._adoptServerAfterImpactConflict(id);
      this._dirty = true;
      this.persist();
      return {
        ok: false, status: 409, reason: 'impact-branch-advanced',
        error: `分析绑定的分支已前进到 #${advanced.headSeq ?? '?'}，候选变更保留但未应用——请基于最新版本重新分析`,
        ...advanced, conflict,
      };
    }

    // 2) 重跑模拟（权威判定；不依赖快照里可能较旧的 simulation）
    const sim = simulateChanges(snap0.baseModel, snap0.baseReport, snap0.changes);
    if (!sim.ok) {
      const first = sim.errors.find((e) => e.code === 'cycle')
        || sim.errors.find((e) => e.code === 'out-of-bounds')
        || sim.errors[0];
      this._emit('impact', { type: 'blocked', id });
      return { ok: false, reason: 'impact-blocked', error: first?.message || '候选变更未通过安全检查', errors: sim.errors, cycle: sim.cycle };
    }

    // 3) 幂等：同快照 / 同结果指纹的 impact 事件已在分支链上 -> 直接复用
    const branch = this.branches.find((b) => b.id === snap0.branchId);
    const already = this._findImpactEvent(branch, snap0.id, sim.resultHash);
    if (already) {
      this._markImpactApplied(snap0, already, sim, { idempotent: true });
      return { ok: true, idempotent: true, event: already, snapshot: this.impactById(id) };
    }

    // 4) 一次性原子提交：构造 impact 事件、推进分支 head、标记快照 applied、保存。
    //    保存返回 409（应用在途时另一页面恰好提交了同分支）时回滚本地事件推进，快照保留候选与冲突原因。
    const parent = this.eventsById.get(branch.headEventId);
    const impactMeta = {
      snapshotId: snap0.id,
      docRev: snap0.docRev,
      baseHeadId: snap0.headEventId,
      baseHash: snap0.baseHash,
      seed: structuredClone(snap0.seed),
      changes: structuredClone(snap0.changes),
      changeIds: sim.changeIds,
      resultHash: sim.resultHash,
      removedConstraintIds: sim.removedConstraintIds,
    };
    const ev = makeImpactEvent(parent, branch.id, sim.model, sim.report, {
      actor: this.actor || '未署名',
      label: label || `安全变更：${snap0.name}`,
      t: Date.now(),
      impact: impactMeta,
    });

    const prevBranch = this.branches.find((b) => b.id === branch.id);
    const wasCurrent = this.currentBranchId === branch.id;
    const prevCurrent = this.currentBranchId;
    this.events = [...this.events, ev];
    this.eventsById.set(ev.id, ev);
    this._replaceBranch({ ...branch, headEventId: ev.id, redoTipId: null });
    this.currentBranchId = branch.id;
    this.replayEventId = null;
    this.replaySnapshot = null;

    const rollback = (info) => {
      this.events = this.events.filter((x) => x.id !== ev.id);
      this.eventsById.delete(ev.id);
      this._replaceBranch(prevBranch);
      this.currentBranchId = prevCurrent;
      const conflict = {
        reason: 'impact-branch-advanced',
        branchId: branch.id, headEventId: info?.headEventId || null,
        headSeq: info?.headSeq ?? null, serverRev: info?.serverRev ?? null, at: Date.now(),
      };
      const cur = this.impactById(snap0.id) || snap0;
      this._replaceImpact(freeze({ ...cur, conflict }));
      this._emit('impact', { type: 'conflict', id: snap0.id });
    };

    // 快照先以“应用中”状态保存（仍记录候选与基线，任何失败都不丢）。
    // 用在途标记拦截 409：应用期间同分支被另一页面提交时，按 impact 专用冲突处理并回滚本地事件，
    // 绝不设置全局 saveConflict（否则整个编辑器进入只读冲突态，候选也无法继续操作）。
    this._impactApplying = { snapshotId: snap0.id, rollback, branchId: branch.id };
    this._dirty = true;
    let saveError = null;
    try {
      this.persist();
      await this.flushed();
    } catch (e) {
      saveError = e;
    }
    const applying = this._impactApplying || null;
    const impactConflictDuringApply = applying?.conflict || null;
    this._impactApplying = null;
    if (impactConflictDuringApply || this.saveConflict) {
      const info = impactConflictDuringApply || { headSeq: this.saveConflict?.headSeq ?? null, serverRev: this.saveConflict?.serverRev ?? null };
      if (this.saveConflict) this.saveConflict = null; // 由 impact 流程接管：回滚 + 候选保留，不锁编辑器
      rollback(info);
      // 采用服务端权威文档（候选快照在 mergeDocs 中按 id 合流保留），避免随后保存冲突状态时
      // 再次撞上同分支 409 而进入全局只读冲突态；本地事件推进已在 rollback 中撤销。
      await this._adoptServerAfterImpactConflict(applying?.snapshotId || snap0.id);
      this._dirty = true;
      this.persist();
      return {
        ok: false, status: 409, reason: 'impact-branch-advanced',
        error: `应用期间分支已前进${info.headSeq ? `到 #${info.headSeq}` : ''}，已回滚本地修改，候选变更原样保留`,
        conflict: this.impactById(snap0.id)?.conflict || null,
      };
    }
    if (saveError && this.online) {
      rollback(null);
      return { ok: false, error: '保存失败，已回滚本地修改（候选变更保留），请稍后重试' };
    }

    // 5) 成功：回填完整影响报告，快照标记 applied
    this._markImpactApplied(this.impactById(snap0.id) || snap0, ev, sim, {});
    if (!wasCurrent) {
      // 保持用户原分支选择；head 已推进的是快照分支
      this.currentBranchId = prevCurrent;
    }
    this._reconcileTemplateStatuses();
    this._dirty = true;
    this.persist();
    this._emit('impact', { type: 'apply', id: snap0.id, eventId: ev.id });
    this._emit('branch', { type: 'impact-commit', id: branch.id });
    this._emit('change', { label: 'impact' });
    return { ok: true, idempotent: false, event: this.eventsById.get(ev.id), snapshot: this.impactById(snap0.id), simulation: sim };
  }

  /** 应用期间分支前进 409 后：采用服务端权威文档，同时保留本页 open 快照上的冲突原因与候选。 */
  async _adoptServerAfterImpactConflict(activeSnapshotId) {
    let serverDoc = null;
    try { serverDoc = await this._fetchDoc(); } catch { serverDoc = null; }
    if (!serverDoc) return; // 离线：保持本地状态（候选与冲突原因已写入快照）
    // adopt 后当前分支 head 来自服务端权威文档：先把乐观基线前进到服务端 head，
    // 否则随后保存冲突状态的 PUT 会携带过期 baseHeads 而再次撞上 branch-advanced 409。
    const serverHeads = {};
    for (const b of Array.isArray(serverDoc.branches) ? serverDoc.branches : []) {
      if (b && typeof b.id === 'string') serverHeads[b.id] = b.headEventId;
    }
    // 带冲突原因的本地快照优先：时间戳推进到“现在”，确保跨 id 合流时压过服务端旧副本。
    const localSnapshots = this.impactSnapshots.map((snap) => (snap.id === activeSnapshotId
      ? { ...snap, conflict: snap.conflict || { reason: 'impact-branch-advanced', at: Date.now() }, updatedAt: Date.now() }
      : snap));
    const merged = mergeDocs(serverDoc, { ...this._payload(), impactSnapshots: localSnapshots, baseHeads: { ...this._syncedHeads, ...serverHeads } });
    // 冲突 adopt 与普通几何合流不同：当前分支没有要保留的本地提交（应用已回滚），
    // head 必须采用服务端权威值，否则 mergeDocs 会保留客户端旧 head 导致下一次保存再撞 409。
    for (const [bid, headId] of Object.entries(serverHeads)) {
      const mb = merged.branches.find((x) => x.id === bid);
      const sb = serverDoc.branches.find((x) => x.id === bid);
      if (mb && sb) merged.branches = merged.branches.map((x) => (x.id === bid ? freeze(sb) : x));
      this._syncedHeads[bid] = headId;
    }
    // mergeDocs 已合流 impactSnapshots；再强制以本地冲突快照为准（冲突原因不能丢）
    merged.impactSnapshots = mergeImpactSnapshots(serverDoc.impactSnapshots || [], localSnapshots);
    const localConflictSnap = localSnapshots.find((x) => x.id === activeSnapshotId);
    if (localConflictSnap?.conflict) {
      merged.impactSnapshots = merged.impactSnapshots.map((x) => (x.id === activeSnapshotId ? localConflictSnap : x));
      merged.activeImpactId = activeSnapshotId;
    }
    await this._adopt(merged, { seed: false, keepReviewConflict: true });
    if (activeSnapshotId && this.impactById(activeSnapshotId)) this.activeImpactId = activeSnapshotId;
    this.rev = Number.isFinite(merged.rev) ? merged.rev : this.rev;
    // 应用在途的 409 已由 impact 流程处理：清掉可能残留的全局冲突锁，编辑器保持可编辑
    this.saveConflict = null;
    for (const b of this.branches) this._syncedHeads[b.id] = b.headEventId;
  }

  /** 应用前核对快照绑定分支的权威 head（本地优先；否则拉取服务端）；离线退回本地判断。 */
  async _checkImpactAdvanced(snap) {
    const b = this.branches.find((x) => x.id === snap.branchId);
    if (!b) return { branchId: snap.branchId, headEventId: null, headSeq: null };
    if (b.headEventId !== snap.headEventId) {
      const head = this.eventsById.get(b.headEventId);
      return { branchId: b.id, headEventId: b.headEventId, headSeq: head?.seq ?? null };
    }
    let serverDoc = null;
    try { serverDoc = await this._fetchDoc(); } catch { serverDoc = null; }
    if (!serverDoc) return null;
    const srv = (Array.isArray(serverDoc.branches) ? serverDoc.branches : [])
      .find((x) => x && x.id === snap.branchId);
    if (srv && srv.headEventId && srv.headEventId !== snap.headEventId) {
      const ev = (Array.isArray(serverDoc.events) ? serverDoc.events : [])
        .find((e) => e && e.id === srv.headEventId);
      return {
        branchId: snap.branchId, headEventId: srv.headEventId,
        headSeq: ev?.seq ?? null, serverRev: Number.isFinite(serverDoc.rev) ? serverDoc.rev : null,
      };
    }
    return null;
  }

  _findImpactEvent(branch, snapshotId, resultHash) {
    let cur = this.eventsById.get(branch.headEventId);
    let guard = 0;
    while (cur && guard++ < 100000) {
      if (cur.kind === 'impact' && cur.impact && (cur.impact.snapshotId === snapshotId || cur.hash === resultHash)) return cur;
      cur = cur.parentId ? this.eventsById.get(cur.parentId) : null;
    }
    return null;
  }

  _markImpactApplied(snap, ev, sim, { idempotent = false } = {}) {
    const report = buildImpactReport({
      ...snap,
      status: 'applied',
      appliedAt: ev.t,
      appliedEventId: ev.id,
      resultHash: ev.hash,
    }, { generatedAt: ev.t, event: ev });
    const applied = freeze({
      ...snap,
      status: 'applied',
      appliedAt: ev.t,
      appliedEventId: ev.id,
      resultHash: ev.hash,
      report,
      conflict: null,
      updatedAt: Date.now(),
    });
    this.impactSnapshots = this.impactSnapshots.map((x) => (x.id === snap.id ? applied : x));
    if (this.activeImpactId === snap.id) this.activeImpactId = snap.id;
    if (!idempotent) this._dirty = true;
  }

  _replaceImpact(next) {
    const frozen = freeze(next);
    this.impactSnapshots = this.impactSnapshots.map((x) => (x.id === next.id ? frozen : x));
    return frozen;
  }

  /** 影响分析报告（导出用；open 快照也可导出当前模拟报告）。 */
  impactReport(id = this.activeImpactId, { generatedAt = Date.now() } = {}) {
    const snap = this.impactById(id);
    if (!snap) return null;
    if (snap.status === 'applied' && snap.report) return snap.report;
    const ev = snap.appliedEventId ? this.eventsById.get(snap.appliedEventId) : null;
    return buildImpactReport(snap, { generatedAt, event: ev });
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

  /**
   * 合流响应里是否有【本请求载荷携带、但服务端合并结果未纳入】的候选批准 / 撤销。
   * inFlight: Map(releaseId -> Set(approvalId))，在请求构造时快照。
   * 撤销（载荷里没有该批准 id 之外的信息）由调用方单独比对状态。
   */
  _findRejectedInMerged(serverDoc, inFlight) {
    const byId = new Map((serverDoc.releases || []).map((r) => [r.id, r]));
    for (const [id, approvalIds] of (inFlight || new Map()).entries()) {
      if (!approvalIds.size) continue;
      const srv = byId.get(id);
      if (!srv) continue;
      const remoteIds = new Set((srv.approvals || []).map((a) => a.id));
      if ([...approvalIds].some((aid) => !remoteIds.has(aid))) {
        return { reason: 'release-advanced', releaseId: id, serverRev: srv.rev, release: srv };
      }
    }
    return null;
  }

  /** 合流 409 前把被拒批准按批准人保留为本地提案（用载荷快照的 id → 批准人映射）。 */
  _stashRejectedReleaseApprovals(info, inFlight, detailsInFlight) {
    const id = info.releaseId;
    const rejectedIds = inFlight.get(id) || new Set();
    const serverIds = new Set((info.release?.approvals || []).map((a) => a.id));
    for (const a of detailsInFlight?.get(id) || []) {
      if (rejectedIds.has(a.id) && !serverIds.has(a.id)) this._stashReleaseProposal(id, a.comment, a.by);
    }
  }

  /**
   * 合流响应里是否有本页本地已接受、但服务端合并结果并未纳入的批准 / 撤销。
   * 与 _findRejectedRelease 的区别：输入是 adopt 不会重置的 _releasePendingApprovals，
   * 因此即使合流响应先把 this.releases 覆盖成服务端值，本页刚做的批准仍可识别。
   */
  _findPendingRejectedRelease(serverDoc) {
    const byId = new Map((serverDoc.releases || []).map((r) => [r.id, r]));
    for (const [id, pending] of this._releasePendingApprovals.entries()) {
      if (!pending.length) continue;
      const srv = byId.get(id);
      if (!srv) continue;
      const remoteBy = new Set((srv.approvals || []).map((a) => a.by));
      const remoteIds = new Set((srv.approvals || []).map((a) => a.id));
      const missingApproval = pending.some((p) => !p.revocation && !remoteBy.has(p.by) && !remoteIds.has(p.id));
      const missingRevocation = pending.some((p) => p.revocation && srv.state !== 'revoked');
      if (missingApproval || missingRevocation) {
        return { reason: 'release-advanced', releaseId: id, serverRev: srv.rev, release: srv };
      }
    }
    return null;
  }

  /**
   * 合流响应里是否有本页推进过、但服务端合并结果并未接纳的候选。
   * 真实 server.py 会在合流前先用发布乐观锁返回 409；这里是客户端防御，
   * 兼容“文档级合并但候选按 rev 取服务端值”的响应。同 rev 竞态（本页刚批准、
   * adopt 后 this.releases 已被服务端值覆盖）由 _findPendingRejectedRelease 识别。
   */
  _findRejectedRelease(serverDoc) {
    const byId = new Map((serverDoc.releases || []).map((r) => [r.id, r]));
    for (const mine of this.releases) {
      const base = this._releaseSyncedRevs[mine.id] ?? 0;
      if (!(mine.rev > base)) continue;
      const srv = byId.get(mine.id);
      if (!srv) continue;
      if (srv.rev < mine.rev) {
        return { reason: 'release-advanced', releaseId: mine.id, serverRev: srv.rev, release: srv };
      }
    }
    return null;
  }

  /** 跨分支合流（merged 响应）后，把本页已提交但未纳入合流文档的审批意见保留为提案。 */
  _carryReleaseProposals(myReleases, myProposals, mergedDoc) {
    const serverById = new Map((mergedDoc.releases || []).map((r) => [r.id, r]));
    for (const mine of myReleases) {
      const srv = serverById.get(mine.id);
      this._releaseSyncedRevs[mine.id] = srv ? srv.rev : (this._releaseSyncedRevs[mine.id] ?? 0);
      this._releaseAuthoredRevs.delete(mine.id);
      if (mine.state !== 'approved' || !(mine.approvals || []).length) continue;
      const remoteBy = new Set((srv?.approvals || []).map((a) => a.by));
      for (const a of mine.approvals) {
        if (!remoteBy.has(a.by)) this._stashReleaseProposal(mine.id, a.comment);
      }
    }
    // 409 前已在内存保留的提案（同对象在 myProposals 中）继续保留
    for (const [id, list] of (myProposals || new Map()).entries()) {
      const cur = this._releaseProposals.get(id) || [];
      const seen = new Set(cur.map((p) => `${p.approver}|${p.comment}|${p.at}`));
      for (const p of list) if (!seen.has(`${p.approver}|${p.comment}|${p.at}`)) cur.push(p);
      if (cur.length) this._releaseProposals.set(id, cur);
    }
    if (this.activeReleaseId && !this.releases.some((x) => x.id === this.activeReleaseId)) this.activeReleaseId = null;
  }

  /* ==================== 审阅通知与升级中心 ==================== */

  /* ---------- 发布门禁与证据快照 ---------- */

  _baseReleaseRevs() {
    const out = {};
    for (const r of this.releases) out[r.id] = this._releaseSyncedRevs[r.id] ?? 0;
    return out;
  }

  /** 发布候选对账上下文：工作体 + 当前会话/分支/实验/通知状态（确定性纯函数输入）。 */
  _releaseCtx() {
    const workbench = this.workbench();
    return {
      workbench,
      sessions: this.reviewSessions,
      branches: this.branches,
      experiments: this.experiments,
      eventsById: this.eventsById,
      notify: this._releaseNotifyState(),
    };
  }

  _releaseNotifyState() {
    return {
      events: this.notifyEvents, items: this.notifications,
      outbox: this.notifyOutbox, rules: this.notifyRules,
    };
  }

  releaseById(id) { return this.releases.find((x) => x.id === id) || null; }

  get activeRelease() { return this.releases.find((x) => x.id === this.activeReleaseId) || null; }

  /** 候选当前视图：在实时文档状态上重算过期原因与门禁（不写入、不持久化）。 */
  releaseViewFor(id = this.activeReleaseId) {
    const release = this.releases.find((x) => x.id === id);
    if (!release) return null;
    return releaseViewPure(release, this._releaseCtx());
  }

  selectRelease(id) {
    if (id && !this.releases.some((x) => x.id === id)) return { ok: false };
    this.activeReleaseId = id || null;
    this._dirty = true;
    this.persist();
    this._emit('releases', { type: 'select', id });
    return { ok: true };
  }

  /** 从审阅会话创建发布候选：冻结证据快照并运行首次门禁评估。 */
  createRelease(sessionId, { name = '', gatePolicy = {}, setActive = true } = {}) {
    if (this.saveConflict) return { ok: false, error: '版本冲突未解决，请先重新加载' };
    const session = this.reviewSessions.find((x) => x.id === sessionId);
    if (!session) return { ok: false, error: '审阅会话不存在，无法创建发布候选' };
    const view = this.reviewView(sessionId);
    let release;
    try {
      release = createReleaseCandidate(session, view, this._releaseCtx(), {
        name, actor: this.actor, now: Date.now(),
        notify: this._releaseNotifyState(), gatePolicy,
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    this.releases = [...this.releases, release];
    this._releaseSyncedRevs[release.id] = 0; // HTTP 首次保存：服务端尚无此候选
    if (!this._releaseAuthoredRevs.has(release.id)) this._releaseAuthoredRevs.set(release.id, new Set());
    this._releaseAuthoredRevs.get(release.id).add(release.rev);
    if (setActive) this.activeReleaseId = release.id;
    this._dirty = true;
    this.persist();
    this._emit('releases', { type: 'create', id: release.id });
    return { ok: true, release, view: this.releaseViewFor(release.id) };
  }

  /**
   * 批准发布：必须未过期且门禁全过。另一窗口已前进该候选（rev 不匹配）→ 409，
   * 本地审批意见（approver/comment）原样保留为提案，可重试或放弃。
   */
  approveRelease(id, comment = '') {
    const release0 = this.releases.find((x) => x.id === id);
    if (!release0) return { ok: false, status: 404, reason: 'release-missing', error: '发布候选不存在' };
    if (this.releaseConflict?.releaseId === id) {
      const proposal = this._stashReleaseProposal(id, comment);
      return { ok: false, status: 409, reason: this.releaseConflict.reason, conflict: this.releaseConflict, proposal };
    }
    const view = this.releaseViewFor(id);
    if (view.stale) {
      const proposal = this._stashReleaseProposal(id, comment);
      return { ok: false, status: 409, reason: 'release-stale', staleCodes: view.staleCodes, proposal };
    }
    if (!view.gate.ok) {
      return { ok: false, status: 409, reason: 'release-gate-blocked', blockers: view.gate.blockers, gate: view.gate };
    }
    const res = approveRelease(release0, {
      approver: this.actor || '未署名', comment, staleCodes: view.staleCodes, gate: view.gate,
    });
    if (res.status !== 200) {
      const proposal = this._stashReleaseProposal(id, comment);
      return { ok: false, ...res, proposal };
    }
    if (!res.idempotent) this._replaceRelease(res.release);
    // 记录本页本地已接受、尚未被服务端确认的批准：若紧接着的保存走合流响应且服务端
    // 合并结果没有这条批准（另一窗口同 rev 批准），按 release-advanced 409 保留本地意见。
    if (res.approval && !res.idempotent) {
      const list = this._releasePendingApprovals.get(id) || [];
      list.push({ id: res.approval.id, by: res.approval.by });
      this._releasePendingApprovals.set(id, list);
    }
    this._dirty = true;
    this.persist();
    this._emit('releases', { type: 'approve', id, idempotent: !!res.idempotent });
    return { ok: true, idempotent: !!res.idempotent, release: res.release, approval: res.approval };
  }

  /** 撤销已批准候选（必须填写原因）；完整审计链保留。 */
  revokeRelease(id, reason) {
    const release0 = this.releases.find((x) => x.id === id);
    if (!release0) return { ok: false, status: 404, reason: 'release-missing', error: '发布候选不存在' };
    const res = revokeRelease(release0, reason, { actor: this.actor });
    if (res.status !== 200) {
      return { ok: false, ...res, error: res.reason === 'revocation-reason-required' ? '撤销必须填写原因' : res.reason };
    }
    this._replaceRelease(res.release);
    const list = this._releasePendingApprovals.get(id) || [];
    list.push({ revocation: true, by: this.actor });
    this._releasePendingApprovals.set(id, list);
    this._dirty = true;
    this.persist();
    this._emit('releases', { type: 'revoke', id });
    return { ok: true, release: res.release, revocation: res.revocation };
  }

  /** 重新生成证据快照：旧候选标记 superseded（快照/门禁/审批意见保留），另立新候选。 */
  regenerateRelease(id, { name = null } = {}) {
    const old = this.releases.find((x) => x.id === id);
    if (!old) return { ok: false, error: '发布候选不存在' };
    const session = this.reviewSessions.find((x) => x.id === old.sessionId);
    if (!session) return { ok: false, status: 409, reason: 'release-session-missing', error: '原审阅会话已不存在，无法重新生成快照' };
    const view = this.reviewView(session.id);
    const res = regenerateRelease(old, session, view, this._releaseCtx(), {
      name: name || old.name, actor: this.actor, notify: this._releaseNotifyState(),
    });
    if (res.status !== 200) return { ok: false, ...res };
    this.releases = this.releases.map((x) => (x.id === old.id ? res.previous : x));
    this.releases = [...this.releases, res.release];
    this._releaseSyncedRevs[old.id] = this._releaseSyncedRevs[old.id] ?? 0;
    this._releaseSyncedRevs[res.release.id] = 0;
    if (!this._releaseAuthoredRevs.has(res.release.id)) this._releaseAuthoredRevs.set(res.release.id, new Set());
    this._releaseAuthoredRevs.get(res.release.id).add(res.release.rev);
    this._releaseAuthoredRevs.get(old.id)?.add(res.previous.rev);
    if (this.activeReleaseId === old.id) this.activeReleaseId = res.release.id;
    this._dirty = true;
    this.persist();
    this._emit('releases', { type: 'regenerate', id: res.release.id, previousId: old.id });
    return { ok: true, release: res.release, previous: res.previous };
  }

  _replaceRelease(release) {
    this.releases = this.releases.map((x) => (x.id === release.id ? release : x));
  }

  _stashReleaseProposal(id, comment, approver = null) {
    const p = { approver: approver || this.actor || '未署名', comment: String(comment || '').slice(0, 2000), at: Date.now(), rejected: true };
    const list = this._releaseProposals.get(id) || [];
    const dup = list.some((x) => x.approver === p.approver && x.comment === p.comment);
    if (!dup) list.push(p);
    this._releaseProposals.set(id, list);
    this._emit('releases', { type: 'proposal', id });
    return p;
  }

  releaseProposals(id = this.activeReleaseId) { return this._releaseProposals.get(id) || []; }

  /** 409 后在最新候选 rev 上重试本地保留的审批意见（过期候选仍会被拒绝，需先重新生成快照）。 */
  retryReleaseApproval(id, proposal) {
    this.releaseConflict = null;
    const res = this.approveRelease(id, proposal?.comment || '');
    if (res.ok) {
      const list = (this._releaseProposals.get(id) || []).filter((p) => p !== proposal);
      this._releaseProposals.set(id, list);
    }
    return res;
  }

  discardReleaseProposal(id, proposal) {
    const list = (this._releaseProposals.get(id) || []).filter((p) => p !== proposal);
    this._releaseProposals.set(id, list);
    if (this.releaseConflict?.releaseId === id && !list.length) this.releaseConflict = null;
    this._emit('releases', { type: 'proposal-discard', id });
    return { ok: true };
  }

  /** 放弃指定批准人的全部本地保留审批意见。 */
  discardReleaseProposalsBy(id, approver) {
    const list = (this._releaseProposals.get(id) || []).filter((p) => p.approver !== approver);
    this._releaseProposals.set(id, list);
    if (this.releaseConflict?.releaseId === id && !list.length) this.releaseConflict = null;
    this._emit('releases', { type: 'proposal-discard', id });
    return { ok: true };
  }

  _dedupReleaseProposals(id) {
    const list = this._releaseProposals.get(id) || [];
    const seen = new Set();
    const out = [];
    for (const p of list) {
      const key = p.approver + '|' + p.comment;
      if (!seen.has(key)) { seen.add(key); out.push(p); }
    }
    this._releaseProposals.set(id, out);
    return out;
  }

  releaseReport(id = this.activeReleaseId, { generatedAt = null } = {}) {
    const release = this.releases.find((x) => x.id === id);
    if (!release) return null;
    return buildReleaseReport(release, this.releaseViewFor(id), { generatedAt });
  }

  /**
   * localStorage 多页签发布候选冲突检测（离线 / 服务端不可用时的协调）。
   * 本页自写 rev 不算外来推进；候选 rev 被另一页签前进 / 会话缺失 / 冻结门禁被篡改 → release-* 冲突。
   */
  _checkLocalReleaseConflict(stored, payload) {
    const storedById = new Map((stored.releases || []).map((r) => [r.id, r]));
    for (const r of payload.releases || []) {
      const authored = this._releaseAuthoredRevs.get(r.id);
      const srv = storedById.get(r.id);
      if (srv && authored?.has(srv.rev)) continue;
      const base = this._releaseSyncedRevs[r.id] ?? 0;
      if (!(r.rev > base)) continue;
      if (srv && srv.rev !== base) {
        return { reason: 'release-advanced', releaseId: r.id, serverRev: srv.rev, release: srv };
      }
      if (r.state === 'revoked' && !String(r.revocation?.reason || '').trim()) {
        return { reason: 'release-revocation-reason-required', releaseId: r.id };
      }
      if (r.state === 'approved' && r.approvals?.length) {
        const blockers = frozenGateBlocked(r);
        if (blockers.length) return { reason: 'release-gate-blocked', releaseId: r.id, blockers };
      }
      if (!srv) continue;
      // 本地存储陈旧时无法重建完整上下文：只做会话引用与冻结状态校验，实时过期由服务端复验
      const sessExists = (stored.reviewSessions || []).some((s) => s.id === r.sessionId);
      if (!sessExists) return { reason: 'release-session-missing', releaseId: r.id, sessionId: r.sessionId };
    }
    return null;
  }

  /**
   * localStorage 多页签模板草稿冲突检测（离线 / 服务端不可用时的协调）。
   * 只锁【草稿编辑】（draftRev 前进）：发布版本走 no 并集，天然合流、不冲突。
   * 本页自写的 draftRev 不算外来推进；另一页保存了更新草稿 -> template-draft-advanced，
   * 本地草稿原样保留，绝不覆盖对方。
   */
  _checkLocalTemplateConflict(stored, payload) {
    const storedById = new Map((stored.templates || []).map((t) => [t.id, t]));
    for (const t of payload.templates || []) {
      const base = this._templateSyncedRevs[t.id] ?? 0;
      if (!((t.draftRev || 0) > base)) continue;
      const authored = this._templateAuthoredRevs.get(t.id);
      const srv = storedById.get(t.id);
      if (srv && authored?.has(srv.draftRev || 0)) continue;
      if (srv && (srv.draftRev || 0) !== base && (srv.draftRev || 0) > base) {
        return {
          reason: 'template-draft-advanced', templateId: t.id,
          serverDraftRev: srv.draftRev || 0, localDraftRev: t.draftRev || 0,
          localDraft: t.draft, serverTemplate: srv,
        };
      }
    }
    return null;
  }

  /** 模板草稿冲突：采用服务端权威模板，本地草稿保留在冲突状态里（可另存或放弃）。 */
  _onTemplateConflict(info) {
    if (this.templateConflict?.templateId === info.templateId) return;
    const srv = info.serverTemplate;
    if (srv) {
      const clean = sanitizeTemplates([srv])[0];
      if (clean) {
        const i = this.templates.findIndex((x) => x.id === clean.id);
        if (i >= 0) this.templates[i] = clean; else this.templates.push(clean);
        this._templateSyncedRevs[clean.id] = clean.draftRev || 0;
      }
    }
    this.templateConflict = {
      templateId: info.templateId,
      reason: 'template-draft-advanced',
      serverDraftRev: info.serverDraftRev,
      localDraft: info.localDraft || null,
      localDraftRev: info.localDraftRev || 0,
    };
    this._emit('templateconflict', this.templateConflict);
    this._emit('templates', { type: 'conflict' });
  }

  /** 放弃本地过期草稿（采用服务端版本），解除模板草稿冲突锁。 */
  discardLocalTemplateDraft(templateId) {
    if (this.templateConflict?.templateId !== templateId) return;
    this.templateConflict = null;
    this._dirty = true;
    this.persist();
    this._emit('templates', { type: 'conflict-resolved' });
  }

  /** 把冲突中保留的本地草稿另存为一个【新模板】（不覆盖对方版本）。 */
  saveLocalDraftAsNewTemplate(templateId, name) {
    const conf = this.templateConflict;
    if (!conf || conf.templateId !== templateId || !conf.localDraft) return { ok: false, error: '没有可另存的本地草稿' };
    const res = this.createTemplate(name, conf.localDraft, { publish: false });
    if (!res.ok) return res;
    this.templateConflict = null;
    this._emit('templates', { type: 'conflict-resolved' });
    return res;
  }

  /** 服务端 409（release-*）：采用服务端权威候选，本地审批意见保留为提案。 */
  _onReleaseConflict(info) {
    const id = info.releaseId;
    const adopt = (serverRelease) => {
      if (!serverRelease) return;
      const clean = sanitizeReleases([serverRelease])[0];
      if (!clean) return;
      const mine = this.releases.find((x) => x.id === id);
      // 保留本地（被拒）审批意见
      if (mine?.approvals?.length) {
        const remoteBy = new Set(clean.approvals.map((a) => a.by));
        for (const a of mine.approvals) {
          if (!remoteBy.has(a.by)) this._stashReleaseProposal(id, a.comment, a.by);
        }
      }
      // 本页本地已接受但服务端合并结果未纳入的批准：按批准人保留为提案；
      // 合流 409 路径可能已经保留了带意见的同批准人提案，只在缺失时补充一条。
      const pending = this._releasePendingApprovals.get(id) || [];
      const remoteBy = new Set(clean.approvals.map((a) => a.by));
      const remoteIds = new Set(clean.approvals.map((a) => a.id));
      const stashedBy = new Set((this._releaseProposals.get(id) || []).map((p) => p.approver));
      for (const p of pending) {
        if (!p.revocation && !remoteBy.has(p.by) && !remoteIds.has(p.id) && !stashedBy.has(p.by)) {
          this._stashReleaseProposal(id, '', p.by);
          stashedBy.add(p.by);
        }
      }
      this._releasePendingApprovals.delete(id);
      if (this.releases.some((x) => x.id === id)) {
        this.releases = this.releases.map((x) => (x.id === id ? clean : x));
      }
      this._releaseSyncedRevs[id] = clean.rev;
      this._releaseAuthoredRevs.delete(id);
      return stashedBy;
    };
    const stashedBy = adopt(info.release || null) || new Set();
    // 合流响应里可能没有权威候选副本：GET 一次
    if (!info.release) {
      this._fetchDoc().then((doc) => {
        if (!doc) return;
        const srv = (Array.isArray(doc.releases) ? doc.releases : []).find((x) => x.id === id);
        if (srv) {
        const stashed = adopt(srv) || new Set();
        // 延迟 GET 到达的候选可能与合流 409 已保留的提案重复：按批准人去重
        if (stashed.size) this._dedupReleaseProposals(id);
        this._emit('releases', { type: 'conflict', id });
      }
      }).catch(() => {});
    }
    this.releaseConflict = {
      releaseId: id,
      reason: info.reason,
      staleCodes: info.staleCodes || null,
      blockers: info.blockers || null,
      serverRev: info.serverRev ?? null,
      serverRelease: info.release || null,
      at: Date.now(),
    };
    this._emit('releases', { type: 'conflict', id });
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

  /** 会话的完整通知时间线报告（含工作时段 / 静音延迟与批量处理结果）。 */
  notifyReport(sessionId, { generatedAt = null } = {}) {
    return buildNotifyReport(sessionId, {
      rules: this.notifyRules, events: this.notifyEvents, items: this.notifications,
      outbox: this.notifyOutbox, sessions: this.reviewSessions,
      batches: this.notifyBatches, drafts: this.notifyDrafts, generatedAt,
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
        schedule: spec.schedule || null,
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
    else if (action === 'transfer') {
      const rule = this.notifyRuleById(before.find((x) => x.id === id)?.ruleId);
      res = transferNotification(before, id, payload.to, { by, now, reason: payload.reason || '', schedule: rule?.schedule || null });
    }
    else if (action === 'retry') {
      const rule = this.notifyRuleById(before.find((x) => x.id === id)?.ruleId);
      res = retryNotification(before, id, { by, now, schedule: rule?.schedule || null });
    }
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

  /* ---------- 批量：按会话批量确认 / 稍后 / 转交（部分版本冲突保留草稿） ---------- */

  /**
   * 对一批通知项应用同一动作。逐项隔离：成功项照常乐观提交并随权威保存落定；
   * 失败项（缺失 / 不可操作 / 非法参数）不提交，并【保留本地草稿】（notifyDrafts，
   * 随文档持久化，刷新 / 重启后仍可重试或放弃）。返回批量结果与 append-only 记录。
   */
  batchNotify(ids, action, payload = {}, { sessionId = null } = {}) {
    if (this.saveConflict) return { ok: false, error: '版本冲突未解决，请先重新加载' };
    const now = Date.now();
    const by = this.actor || '未署名';
    const uniq = [];
    for (const id of Array.isArray(ids) ? ids : []) if (id && !uniq.includes(id)) uniq.push(id);
    const res = applyBatchNotifications(this.notifications, uniq, action, {
      ...payload, by, now, schedules: this._notifySchedules(),
    });
    this.notifications = res.items;
    // 成功项：注册乐观动作（确认 / 转交的出队、OCC 与单项路径完全一致）
    for (const r of res.results) {
      if (!r.ok) continue;
      const pendingRec = { action, payload, newId: r.newId || null, at: now, by, batch: true };
      this._notifyPendingItemActions.set(r.id, pendingRec);
      this._notifyOptimisticLog.set(r.id, pendingRec);
      if (r.newId) {
        this._notifyPendingItemActions.set(r.newId, { ...pendingRec, newId: null, spawnedBy: r.id });
        this._notifyOptimisticLog.set(r.newId, { ...pendingRec, newId: null, spawnedBy: r.id });
      }
    }
    // 失败项：保留本地草稿（持久化）；已存在同身份草稿则幂等
    let draftAdded = 0;
    for (const r of res.results) {
      if (r.ok) continue;
      const d = makeDraft({ notifyId: r.id, action, payload, by, at: now, reason: r.reason || '版本冲突 / 不可操作' });
      if (this.notifyDrafts.some((x) => x.id === d.id)) continue;
      this.notifyDrafts = mergeDrafts(this.notifyDrafts, [d]);
      draftAdded++;
    }
    // append-only 批量结果（成功 / 失败清单与原因），重启后时间线报告仍一致
    const id2 = batchId();
    const record = makeBatchRecord({ id: id2, sessionId, action, ids: uniq, results: res.results, by, now, payload });
    this.notifyBatches = mergeBatches(this.notifyBatches, [record]);

    for (const n of this.notifications) this._markAuthoredItem(n.id, n.status);
    this._pruneNotifyOutbox();
    this.pumpNotify({ now });
    this._dirty = true;
    this.persist();
    this.flushOutbox().catch(() => {});
    this._emit('notify', { type: 'batch', id: id2, action, success: res.success, failed: res.failed, draftAdded });
    return { ok: true, batchId: id2, record, results: res.results, success: res.success, failed: res.failed };
  }

  /** 当前接收人在指定会话（或全部）收件箱中可批量操作的通知项。 */
  batchableInbox(recipient, { sessionId = null } = {}) {
    return this.notifyInbox(recipient)
      .filter((it) => !sessionId || it.sessionId === sessionId)
      .filter((it) => !this._notifyLockedItems.has(it.id));
  }

  notifyDraftsFor(id) { return this.notifyDrafts.filter((d) => d.notifyId === id); }

  /** 删除一条持久化本地草稿（重试成功或用户放弃后）。 */
  discardNotifyDraftId(draftId) {
    this.notifyDrafts = this.notifyDrafts.filter((d) => d.id !== draftId);
    const list = this._notifyItemDrafts;
    for (const [nid, arr] of list) {
      const rest = arr.filter((d) => d.draftId !== draftId);
      if (rest.length) list.set(nid, rest); else list.delete(nid);
    }
    this._dirty = true;
    this.persist();
    this._emit('notify', { type: 'draft-discard' });
    return { ok: true };
  }

  /* ---------- 409：版本冲突与本地未提交操作保留 ---------- */

  _stashNotifyDraft(id, draft) {
    if (draft.kind === 'rule') {
      this._notifyRuleDrafts.set(id, draft);
    } else {
      const list = this._notifyItemDrafts.get(id) || [];
      const key = `${draft.action}|${draft.payload?.to || ''}|${draft.payload?.snoozeMin || ''}|${draft.payload?.note || ''}`;
      if (!list.some((d) => `${d.action}|${d.payload?.to || ''}|${d.payload?.snoozeMin || ''}|${d.payload?.note || ''}` === key)) list.push(draft);
      this._notifyItemDrafts.set(id, list);
      // 通知项草稿（批量部分版本冲突时保留）同时写入持久化 notifyDrafts：
      // 刷新 / 重启后从权威文档重建内存映射（见 _adoptNotify）。
      if (draft.action === 'ack' || draft.action === 'snooze' || draft.action === 'transfer') {
        const d = makeDraft({
          notifyId: id, action: draft.action, payload: draft.payload || {},
          by: draft.by || this.actor, at: draft.at || Date.now(), reason: draft.reason || '版本冲突，本地操作保留',
        });
        const enriched = { ...draft, draftId: d.id, persisted: true };
        const list2 = this._notifyItemDrafts.get(id) || [];
        const idx = list2.findIndex((x) => x === draft);
        if (idx >= 0) list2[idx] = enriched;
        if (!this.notifyDrafts.some((x) => x.id === d.id)) this.notifyDrafts = mergeDrafts(this.notifyDrafts, [d]);
      }
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
      // 应用成功：移除持久化草稿（成功项已随权威保存提交，失败项不再保留）
      if (draft.draftId) this.notifyDrafts = this.notifyDrafts.filter((d) => d.id !== draft.draftId);
      this._dirty = true;
      this.persist();
    }
    return res;
  }

  discardNotifyItemDraft(id, draft) {
    const list = (this._notifyItemDrafts.get(id) || []).filter((d) => d !== draft);
    if (list.length) this._notifyItemDrafts.set(id, list); else this._notifyItemDrafts.delete(id);
    if (draft?.draftId) this.notifyDrafts = this.notifyDrafts.filter((d) => d.id !== draft.draftId);
    this._notifyLockedItems.delete(id);
    if (!this._hasNotifyLocks()) this.notifyConflict = null;
    this._dirty = true;
    this.persist();
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
        // 严格 FIFO：按 (enqueuedAt, seq, id) 排序，队头决定阻塞。
        // seq 是物化原顺序：静音窗口结束同一拍释放的多条通知据此保持原顺序。
        const ordered = [...this.notifyOutbox].sort((a, b) =>
          (a.enqueuedAt - b.enqueuedAt) || ((a.seq ?? 0) - (b.seq ?? 0)) || (a.id < b.id ? -1 : 1));
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

  /* ==================== 旧版布局批量迁移 ==================== */

  migrationById(id) { return this.migrations.find((x) => x.id === id) || null; }

  /**
   * 导入前预览：解析 + 识别 + dry-run 转换（不建批次、不落盘）。
   * 入参 files:[{name, text}]；返回逐文件 ingest 草稿（含 preview）。
   * 相同内容（sourceHash）的多份文件在返回里标注 duplicateOf。
   */
  previewMigrations(files) {
    const out = [];
    const seen = new Map();
    for (const f of Array.isArray(files) ? files : []) {
      const draft = ingestFile(f.text, { name: f.name, size: f.size });
      if (seen.has(draft.sourceHash)) draft.duplicateOf = seen.get(draft.sourceHash);
      else seen.set(draft.sourceHash, draft.id);
      out.push(draft);
    }
    return out;
  }

  /**
   * 创建迁移批次（已含每文件 dry-run 预览），创建即排队并自动开始正式迁移。
   * 幂等：
   *  - 批次内相同 sourceHash 只保留第一份（其余记入 skippedDuplicates）；
   *  - 跨批次重复提交相同源文件：已成功迁移（或已导入）的文件直接引用既有结果，
   *    不会重复转换、不会产生重复分支（导入时分支 id 由内容指纹确定）。
   */
  createMigrationBatch(rawFiles, { name = '', autoImport = false } = {}) {
    if (this.saveConflict) return { ok: false, error: '版本冲突未解决，请先重新加载' };
    if (!Array.isArray(rawFiles) || !rawFiles.length) return { ok: false, error: '请先选择至少一份布局文件' };
    if (rawFiles.length > 200) return { ok: false, error: '单批次最多 200 份文件' };

    // 跨批次：按 sourceHash 找已成功迁移的文件（幂等引用，不重复转换）
    const priorByHash = new Map();
    for (const b of this.migrations) {
      for (const f of b.files) {
        if (f.sourceHash && (f.status === 'done') && f.result) priorByHash.set(f.sourceHash, { batchId: b.id, file: f });
      }
    }
    const ingested = [];
    const reused = [];
    const skippedDuplicates = [];
    const seen = new Map();
    for (const rf of rawFiles) {
      const draft = ingestFile(rf.text, { name: rf.name, size: rf.size });
      // 批次内完全相同的源文件：只保留第一份，其余记入 skippedDuplicates（不产生重复布局）
      if (seen.has(draft.sourceHash)) {
        skippedDuplicates.push({ name: draft.name, sourceHash: draft.sourceHash, duplicateOf: seen.get(draft.sourceHash) });
        continue;
      }
      seen.set(draft.sourceHash, draft.id);
      const prior = priorByHash.get(draft.sourceHash);
      if (prior) {
        draft.status = 'done';
        draft.detected = prior.file.detected;
        draft.confidence = prior.file.confidence;
        draft.result = prior.file.result;
        draft.startedAt = draft.finishedAt = Date.now();
        draft.reusedFrom = { batchId: prior.batchId, fileId: prior.file.id };
        reused.push({ name: draft.name, sourceHash: draft.sourceHash, batchId: prior.batchId });
      }
      ingested.push(draft);
    }
    if (!ingested.length) return { ok: false, error: '所有文件都与批次内其他文件完全相同（重复源）' };

    const t = Date.now();
    const batch = makeBatch({
      name: name.trim() || `迁移批次 ${new Date(t).toLocaleString()}`,
      actor: this.actor || '未署名',
      files: ingested, autoImport, t,
    });
    if (skippedDuplicates.length) batch.skippedDuplicates = skippedDuplicates;
    // 复用的成功文件不计入 importedCount；其余排队
    batch.runState = reused.length === ingested.length ? 'done' : 'running';
    this.migrations = [...this.migrations, batch];
    this._dirty = true;
    this.persist();
    this._emit('migrations', { type: 'create', id: batch.id, reused });
    if (reused.length) this._emit('migrations', { type: 'idempotent', id: batch.id, reused });
    if (batch.runState === 'running') this._startMigrationRunner(batch.id);
    else if (autoImport) this._autoImportReady(batch);
    return { ok: true, batch, reused };
  }

  /** 重试一个失败文件（保留原始输入，重新走转换管线；成功终态不被覆盖）。 */
  retryMigrationFile(batchId, fileId) {
    const batch = this.migrationById(batchId);
    if (!batch) return { ok: false, error: '迁移批次不存在' };
    const f = batch.files.find((x) => x.id === fileId);
    if (!f) return { ok: false, error: '文件不在批次中' };
    if (f.status !== 'failed') return { ok: false, error: '只有失败文件可以重试' };
    f.status = 'queued';
    f.error = null;
    batch.runState = 'running';
    this._bumpMigration(batch);
    this._startMigrationRunner(batch.id);
    return { ok: true };
  }

  /** 正式迁移运行器：按 files 顺序逐文件转换；文件之间让出事件循环以响应暂停/继续/取消。 */
  async _startMigrationRunner(batchId) {
    const cur = this._migrationRunners.get(batchId);
    const batch0 = this.migrationById(batchId);
    if (cur && batch0 && batch0.runState === 'running') return;
    const token = {};
    this._migrationRunners.set(batchId, { token });
    try {
      await this._runMigrationQueue(batchId, token);
    } finally {
      if (this._migrationRunners.get(batchId)?.token === token) this._migrationRunners.delete(batchId);
    }
  }

  async _runMigrationQueue(batchId, token) {
    for (;;) {
      const batch = this.migrationById(batchId);
      if (!batch || token.cancelled) return;
      if (batch.runState !== 'running') return;
      const f = batch.files.find((x) => x.status === 'queued');
      if (!f) {
        batch.runState = 'done';
        this._bumpMigration(batch);
        if (batch.autoImport) this._autoImportReady(batch);
        return;
      }
      await this._migrationTick();
      let b2 = this.migrationById(batchId);
      if (!b2 || token.cancelled || this._migrationRunners.get(batchId)?.token !== token || b2.runState !== 'running') return;
      if (this.onMigrationGate) await this.onMigrationGate(batchId, b2.files.indexOf(f));
      // gate 返回后不再因“暂停”退出：与实验运行器同语义——文件之间让出，
      // 已开始（已通过 gate）的当前文件正常收尾；仅取消（token / cancelling）立即中止。
      b2 = this.migrationById(batchId);
      if (!b2 || token.cancelled || this._migrationRunners.get(batchId)?.token !== token) return;
      if (b2.runState === 'cancelled' || b2.files.some((x) => x.status === 'cancelled' && x.id === f.id)) return;
      const outcome = executeFile(b2, f.id, { now: Date.now() });
      if (!outcome.skipped) this._bumpMigration(b2);
      if (b2.autoImport && f.status === 'done' && !f.imported && !f.reusedFrom) {
        // autoImport 在批次结束时统一处理（避免部分导入时打断顺序）；此处不动作
      }
    }
  }

  _migrationTick() { return new Promise((r) => setTimeout(r, this.tickMs)); }

  _bumpMigration(batch, { emit = true } = {}) {
    batch.updatedAt = Date.now();
    this._dirty = true;
    this.persist();
    if (emit) this._emit('migrations', { type: 'progress', id: batch.id });
  }

  pauseMigration(batchId) {
    const batch = this.migrationById(batchId);
    if (!batch) return { ok: false, error: '迁移批次不存在' };
    if (!['queued', 'running'].includes(batch.runState)) return { ok: false, error: '该批次已结束，不能暂停' };
    batch.runState = 'paused'; // 运行器在下一拍（文件之间）让出；正在转换的当前文件正常收尾
    this._bumpMigration(batch);
    return { ok: true };
  }

  resumeMigration(batchId) {
    const batch = this.migrationById(batchId);
    if (!batch) return { ok: false, error: '迁移批次不存在' };
    if (!['paused', 'queued'].includes(batch.runState)) return { ok: false, error: '该批次不在暂停/排队状态' };
    if (!batch.files.some((f) => f.status === 'queued')) return { ok: false, error: '没有排队中的文件' };
    batch.runState = 'running';
    this._dirty = true;
    this.persist();
    this._emit('migrations', { type: 'resume', id: batch.id });
    this._startMigrationRunner(batch.id);
    return { ok: true };
  }

  cancelMigration(batchId) {
    const batch = this.migrationById(batchId);
    if (!batch) return { ok: false, error: '迁移批次不存在' };
    if (['done', 'cancelled'].includes(batch.runState)) return { ok: false, error: '该批次已结束' };
    const r = this._migrationRunners.get(batchId);
    if (r) r.token.cancelled = true;
    cancelBatchState(batch);
    this._bumpMigration(batch);
    return { ok: true };
  }

  migrationCounters(batch) { return batchCounters(batch); }

  /**
   * 把一份迁移成功的文件导入为新的编辑分支：
   * - 分支/root 事件 id 由【源文件内容指纹】确定性派生：相同源文件重复提交/重复导入
   *   永远得到同一个分支，绝不产生重复布局；
   * - 约束引用已在转换时重写到稳定重命名后的矩形，导入后仍指向正确对象；
   * - 记录相对导入时分叉点（当前编辑分支 head）的差异摘要。
   */
  importMigrationFile(batchId, fileId, { name = null, switchTo = true } = {}) {
    const batch = this.migrationById(batchId);
    if (!batch) return { ok: false, error: '迁移批次不存在' };
    const f = batch.files.find((x) => x.id === fileId);
    if (!f) return { ok: false, error: '文件不在批次中' };
    if (f.status !== 'done' || !f.result) return { ok: false, error: '该文件未成功迁移，无法导入' };

    const bid = migrationBranchId(f.sourceHash);
    const existing = this.branches.find((b) => b.id === bid);
    if (existing) {
      // 幂等：相同源内容已导入过 —— 不新建分支/事件，仅回填导入记录
      const rootEvent = this.eventsById.get(existing.rootEventId);
      f.imported = {
        at: Date.now(), by: this.actor || '未署名',
        branchId: bid, branchName: existing.name, eventId: existing.rootEventId,
        diff: f.imported?.diff || this._migrationImportDiff(f), idempotent: true,
      };
      if (switchTo) this._switchToMigrationBranch(bid);
      batch.importedCount = batch.files.filter((x) => x.imported).length;
      this._dirty = true;
      this.persist();
      this._emit('migrations', { type: 'import-idempotent', id: batch.id, fileId, branchId: bid });
      return { ok: true, idempotent: true, branch: existing, event: rootEvent };
    }

    const baseName = name || f.result.name || f.name.replace(/\.[^.]+$/, '') || '迁移布局';
    const branchName = this._uniqueBranchName(baseName);
    const root = makeMigrationForkRootEvent(f.result, {
      batchId: batch.id, batchName: batch.name,
      fileId: f.id, fileName: f.name,
      sourceFileHash: f.sourceHash, sourceFormat: f.detected,
    }, { actor: this.actor || '未署名' });
    this.events = [...this.events, root];
    this.eventsById.set(root.id, root);
    const branch = freeze({
      id: bid, name: branchName, createdAt: root.t,
      rootEventId: root.id, headEventId: root.id, redoTipId: null,
      source: {
        kind: 'migration', branchId: null, eventId: null,
        migrationBatchId: batch.id, sourceFileHash: f.sourceHash,
      },
    });
    this.branches = [...this.branches, branch];
    this._syncedHeads[bid] = root.id;
    const diff = this._migrationImportDiff(f);
    f.imported = {
      at: Date.now(), by: this.actor || '未署名',
      branchId: bid, branchName, eventId: root.id, diff, idempotent: false,
    };
    batch.importedCount = batch.files.filter((x) => x.imported).length;
    if (switchTo) this._switchToMigrationBranch(bid);
    this._dirty = true;
    this.persist();
    this._emit('migrations', { type: 'import', id: batch.id, fileId, branchId: bid });
    this._emit('branch', { type: 'fork', id: bid, fromMigration: true });
    this._emit('change', { label: 'migration-import' });
    return { ok: true, idempotent: false, branch, event: root, diff };
  }

  _switchToMigrationBranch(bid) {
    if (this.currentBranchId !== bid) {
      this.currentBranchId = bid;
      this.replayEventId = null;
      this.replaySnapshot = null;
      // 迁移导入分支的 head 是外部布局快照：实例记录状态按该 head 对齐
      this._reconcileTemplateStatuses();
    }
  }

  /** 导入差异：迁移结果相对“导入时当前编辑分支 head”的 compareVersions 差异摘要。 */
  _migrationImportDiff(f) {
    const head = this.headEvent;
    const target = head && head.model && head.report
      ? { model: head.model, report: head.report, hash: head.hash }
      : { model: { rects: [], constraints: [] }, report: { conflicts: [] }, hash: '' };
    try {
      return migrationDiff(target, f.result);
    } catch {
      return null;
    }
  }

  _uniqueBranchName(base) {
    let name = String(base || '迁移布局').slice(0, 40);
    if (!this.branches.some((b) => b.name === name)) return name;
    let n = 2;
    while (this.branches.some((b) => b.name === `${name} ${n}`)) n++;
    return `${name} ${n}`;
  }

  /** 批次自动导入：所有成功且未导入的文件逐个导入为新分支（失败文件保留不动）。 */
  _autoImportReady(batch) {
    for (const f of batch.files) {
      if (f.status === 'done' && f.result) {
        // 已导入过（幂等分支已存在）也回填记录；不重复建分支
        const bid = migrationBranchId(f.sourceHash);
        if (!this.branches.some((b) => b.id === bid)) {
          this.importMigrationFile(batch.id, f.id, { switchTo: false });
        } else if (!f.imported) {
          f.imported = {
            at: Date.now(), by: this.actor || '未署名', branchId: bid,
            branchName: this.branches.find((b) => b.id === bid)?.name || bid,
            eventId: this.branches.find((b) => b.id === bid)?.rootEventId,
            diff: this._migrationImportDiff(f), idempotent: true,
          };
        }
      }
    }
    batch.importedCount = batch.files.filter((x) => x.imported).length;
    this._dirty = true;
    this.persist();
    this._emit('migrations', { type: 'auto-import', id: batch.id });
  }

  /** 迁移报告：源摘要 + 映射表 + 隔离项 + 错误 + 最终分支标识 + 校验和。 */
  migrationReport(batchId, { generatedAt = null } = {}) {
    const batch = this.migrationById(batchId);
    if (!batch) return null;
    return buildMigrationReport(batch, { generatedAt: generatedAt || Date.now(), branchesById: this.branchesById });
  }

  /**
   * 服务中断恢复：加载时对“刷新瞬间仍在运行”（interrupted 标记）的批次自动续跑，
   * 从第一个仍排队的文件（即已完成文件之后）继续；完成项不重跑、不覆盖。
   * 用户主动暂停的批次不带 interrupted，保持暂停等待手动继续。
   */
  _resumeInterruptedMigrations() {
    for (const batch of this.migrations) {
      if (!batch.interrupted) continue;
      delete batch.interrupted;
      if (batch.files.some((f) => f.status === 'queued')) {
        batch.runState = 'running';
        this._startMigrationRunner(batch.id);
        this._emit('migrations', { type: 'resume-after-interrupt', id: batch.id });
      }
    }
  }

  /** 测试用：等待批次所有文件收尾且运行器退出。 */
  async migrationSettled(batchId) {    for (let i = 0; i < 100000; i++) {
      const b = this.migrationById(batchId);
      if (b && !b.files.some((f) => f.status === 'running' || f.status === 'queued') && !this._migrationRunners.has(batchId)) return b;
      if (b && this._migrationRunners.has(batchId)) await this._migrationTick();
      else await Promise.resolve();
    }
    throw new Error('migrationSettled 超时');
  }

  /* ==================== 布局方案实验 ==================== */

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
    this._migrationRunners.clear();
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
    // 新分支 head 是来源快照：实例记录状态按该 head 的 tpl 标签对齐
    this._reconcileTemplateStatuses();
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

  /* ==================== 参数化约束模板 ==================== */

  get activeTemplate() { return this.templates.find((t) => t.id === this.activeTemplateId) || null; }
  templateById(id) { return this.templates.find((t) => t.id === id) || null; }
  instanceById(id) { return this.templateInstances.find((x) => x.id === id) || null; }

  /** 当前分支上每个实例的链接状态（由模型约束 tpl 标签派生，undo/redo 天然一致）。 */
  instanceLinks() {
    return deriveInstanceLinks(this.templateInstances, this.headEvent.model);
  }

  /**
   * 把文档级实例记录的 status 对齐到【当前分支 head】模型：
   * undo 脱离 / redo 脱离 / 切换分支 / 装载合流后，画布标签与实例记录必须同一状态，
   * 升级预览、实例计数等读 status 的地方才不会与画布撕裂。
   * 发生翻转时记录 updatedAt 已在纯函数里推进（合流时压过旧 detached 墓碑）。
   */
  _reconcileTemplateStatuses({ persist = true } = {}) {
    if (!this.templateInstances.length) return false;
    const { instances, changed } = reconcileInstanceStatuses(this.templateInstances, this.headEvent.model);
    if (changed) {
      this.templateInstances = instances;
      if (persist) {
        this._dirty = true;
        this.persist();
      }
    }
    return changed;
  }

  /** 模型中属于某实例的具体约束（当前分支）。 */
  constraintsOfInstance(instanceId) {
    return this.headEvent.model.constraints.filter((c) => c.tpl?.instanceId === instanceId);
  }

  /**
   * 从一组选中矩形与其间约束创建模板（可同时发布 v1）。
   * 草稿与版本都是新对象，不改写任何既有数据。
   */
  createTemplateFromSelection(name, rectIds, { publish = true } = {}) {
    const ex = extractDraft(this.headEvent.model, rectIds);
    if (!ex.ok) return { ok: false, error: ex.errors[0], errors: ex.errors };
    return this.createTemplate(name, ex.draft, { publish });
  }

  /** 纯预览：从一组选中矩形抽取模板草稿（不修改任何状态）。 */
  previewExtractTemplate(rectIds) {
    return extractDraft(this.headEvent.model, rectIds);
  }

  createTemplate(name, draftRaw, { publish = true } = {}) {
    name = String(name ?? '').trim();
    if (!name) return { ok: false, error: '模板名称不能为空' };
    if (this.templates.some((t) => t.name === name)) return { ok: false, error: `已存在同名模板「${name}」` };
    const draft = normalizeTplDraft(draftRaw);
    const errors = validateDraft(draft);
    if (errors.length) return { ok: false, error: errors[0], errors };
    const now = Date.now();
    const id = uid('tpl');
    const t = {
      id, name, createdAt: now, updatedAt: now,
      draftRev: 1, draft, versions: [], publishedNo: 0,
    };
    let firstVersion = null;
    if (publish) {
      const pub = publishVersion(t, { now });
      if (!pub.ok) return { ok: false, error: pub.error, errors: pub.errors };
      t.versions.push(pub.version); t.publishedNo = pub.no;
      firstVersion = pub.version;
    }
    this.templates = [...this.templates, t];
    this.activeTemplateId = id;
    this._templateSyncedRevs[id] = 1;
    this._templateAuthoredRevs.set(id, new Set([1]));
    this._dirty = true;
    this.persist();
    this._emit('templates', { type: 'create', id });
    return { ok: true, template: t, version: firstVersion };
  }

  /** 更新模板【草稿】（乐观锁：基于 baseDraftRev；冲突时保留本地草稿并提示）。 */
  updateTemplateDraft(id, mutator, baseDraftRev) {
    if (this.templateConflict?.templateId === id) return { ok: false, error: '模板草稿存在版本冲突，请先放弃本地草稿或另存为新模板' };
    const t = this.templateById(id);
    if (!t) return { ok: false, error: '模板不存在（可能已被其他页面删除）' };
    if (!t.draft) return { ok: false, error: '该模板没有可编辑草稿' };
    const base = Number.isInteger(baseDraftRev) ? baseDraftRev : (this._templateSyncedRevs[id] ?? t.draftRev);
    if ((t.draftRev || 0) !== base) {
      return { ok: false, conflict: true, reason: 'template-draft-advanced', serverDraftRev: t.draftRev, error: '模板草稿已被另一个页面更新，请刷新后重试' };
    }
    // 离线 / localStorage 多页签：同步核对磁盘上该模板草稿是否已被另一页面前进，
    // 若已前进则立即判冲突（本地草稿参数随返回保留），不写入、不覆盖对方。
    try {
      const stored = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      const srvT = (stored?.templates || []).find((x) => x.id === id);
      if (srvT) {
        const authored = this._templateAuthoredRevs.get(id);
        const diskRev = srvT.draftRev || 0;
        if (diskRev > base && !authored?.has(diskRev)) {
          const clean = sanitizeTemplates([srvT])[0];
          if (clean) {
            const i = this.templates.findIndex((x) => x.id === id);
            if (i >= 0) this.templates[i] = clean;
            this._templateSyncedRevs[id] = clean.draftRev || 0;
          }
          const localDraft = normalizeTplDraft(buildDraftAfterMutator(t.draft, mutator));
          this._onTemplateConflict({
            reason: 'template-draft-advanced', templateId: id,
            serverDraftRev: diskRev, localDraftRev: base,
            localDraft, serverTemplate: srvT,
          });
          return { ok: false, conflict: true, reason: 'template-draft-advanced', serverDraftRev: diskRev, error: '模板草稿已被另一个页面保存，本地草稿已保留' };
        }
      }
    } catch {}
    const draft = structuredClone(t.draft);
    mutator(draft);
    const normalized = normalizeTplDraft(draft);
    const errors = validateDraft(normalized);
    if (errors.length) return { ok: false, error: errors[0], errors };
    const nextRev = Math.max((t.draftRev || 0) + 1, (this._templateSyncedRevs[id] || 0) + 1);
    this._mutateTemplate(id, (x) => {
      x.draft = normalized;
      x.draftRev = nextRev;
      x.updatedAt = Date.now();
    });
    this._templateSyncedRevs[id] = nextRev;
    if (!this._templateAuthoredRevs.has(id)) this._templateAuthoredRevs.set(id, new Set());
    this._templateAuthoredRevs.get(id).add(nextRev);
    this._dirty = true;
    this.persist();
    this._emit('templates', { type: 'draft', id, draftRev: nextRev });
    return { ok: true, draftRev: nextRev, draft: normalized };
  }

  /** 声明某条模板约束的某个参数是否允许实例覆盖（草稿编辑）。 */
  setTemplateOverridable(id, key, field, flag, baseDraftRev) {
    return this.updateTemplateDraft(id, (draft) => {
      const d2 = tplSetOverridable(draft, key, field, flag);
      draft.slots = d2.slots; draft.constraints = d2.constraints;
    }, baseDraftRev);
  }

  /** 修改某条模板约束参数的草稿默认值。 */
  setTemplateParamDefault(id, key, field, value, baseDraftRev) {
    return this.updateTemplateDraft(id, (draft) => {
      const d2 = setDraftParamDefault(draft, key, field, value);
      draft.slots = d2.slots; draft.constraints = d2.constraints;
    }, baseDraftRev);
  }

  /** 发布草稿为新版本（只读，绝不改写既有版本；实例“已应用版本”不受影响）。 */
  publishTemplate(id) {
    const t = this.templateById(id);
    if (!t) return { ok: false, error: '模板不存在' };
    if (this.templateConflict?.templateId === id) return { ok: false, error: '模板草稿存在版本冲突，请先解决' };
    const pub = publishVersion(t, { now: Date.now() });
    if (!pub.ok) return { ok: false, error: pub.error, errors: pub.errors };
    // 幂等/不可改写：同 no 已存在则拒绝（正常流程不会发生）
    if (t.versions.some((v) => v.no === pub.no)) return { ok: false, error: `版本 v${pub.no} 已存在，不能改写` };
    const version = pub.version;
    this._mutateTemplate(id, (x) => {
      x.versions = [...x.versions, version];
      x.publishedNo = pub.no;
      x.updatedAt = Date.now();
    });
    this._dirty = true;
    this.persist();
    this._emit('templates', { type: 'publish', id, no: pub.no });
    return { ok: true, version, no: pub.no };
  }

  setActiveTemplate(id) {
    this.activeTemplateId = id && this.templates.some((t) => t.id === id) ? id : null;
    this._dirty = true;
    this.persist();
    this._emit('templates', { type: 'active' });
  }

  _mutateTemplate(id, fn) {
    this.templates = this.templates.map((t) => {
      if (t.id !== id) return t;
      const clone = structuredClone(t);
      fn(clone);
      return clone;
    });
  }

  /**
   * 应用模板版本到一组槽位映射（首次实例化）。
   * 完整预览（新增约束 / 求解位置 / 未满足 / 冲突链）通过 planTemplate() 获取；
   * 本方法在确认后原子创建实例 + 一次几何提交。任何非法（槽位缺失/重复/悬空/环/越界）都不创建实例。
   */
  applyTemplate({ templateId, versionNo, mapping, params = {} }) {
    const t = this.templateById(templateId);
    if (!t) return { ok: false, error: '模板不存在' };
    const version = tplVersion(t, versionNo || t.publishedNo);
    if (!version) return { ok: false, error: `模板没有版本 v${versionNo}` };
    // 幂等：同模板版本 + 同槽位映射不得重复创建实例
    const mapHash = mappingFingerprint(templateId, version.no, mapping);
    const dup = this.templateInstances.find((x) =>
      x.templateId === templateId && x.status !== 'detached' && x.mapHash === mapHash
      && this._instanceCurrentOnBranch(x.id));
    if (dup) return { ok: false, error: '同一模板版本已应用到这组槽位映射（重复实例被拒绝）', duplicate: true, instanceId: dup.id };

    const instanceId = uid('ti');
    const cidPrefix = instanceId;
    const plan = planInstance({
      template: t, version, model: this.headEvent.model, mapping, params,
      instanceId, existing: null, pin: false, cidPrefix,
    });
    if (!plan.ok) return { ok: false, error: plan.errors[0]?.message || '应用被阻止', errors: plan.errors };

    const now = Date.now();
    const ins = {
      id: instanceId, templateId, templateName: t.name, versionNo: version.no,
      mapping: normalizeMappingOut(mapping, version), params: plan.params,
      constraintIds: plan.constraints.map((c) => c.id),
      mapHash, status: 'linked', pinned: {}, history: [{ t: now, action: 'apply', toNo: version.no }],
      lastError: null, createdAt: now, updatedAt: now,
    };
    const newCids = new Set(ins.constraintIds);
    const res = this.commit((m) => {
      // 以计划中已求解的具体约束为准（复制其几何字段与 tpl 标签）
      m.constraints = [...m.constraints, ...structuredClone(plan.constraints)];
    }, { label: `应用模板「${t.name}」v${version.no}` });
    if (!res.ok) {
      // 提交被拒（环 / 校验 / 回放）：不留下任何实例或部分约束
      return { ok: false, error: res.errors?.[0] || '应用被阻止', errors: res.errors || [], cycle: res.cycle };
    }
    this.templateInstances = [...this.templateInstances, ins];
    this._dirty = true;
    this.persist();
    this._emit('templates', { type: 'apply', instanceId });
    return { ok: true, instance: ins, plan, addedCids: ins.constraintIds };
  }

  /** 纯预览：应用 / 升级后将新增、替换、保留的约束，求解位置、未满足项与冲突链（不修改任何状态）。 */
  planTemplate({ templateId, versionNo, mapping, params = {}, instanceId = null }) {
    const t = this.templateById(templateId);
    if (!t) return { ok: false, errors: [{ code: 'no-template', message: '模板不存在' }] };
    const existing = instanceId ? this.instanceById(instanceId) : null;
    const targetNo = versionNo || (existing ? latestAvailableNo(t, existing.versionNo) : t.publishedNo);
    const version = tplVersion(t, targetNo);
    if (!version) return { ok: false, errors: [{ code: 'no-version', message: `模板没有版本 v${targetNo}` }] };
    const useMapping = mapping || existing?.mapping || {};
    const useParams = params && Object.keys(params).length ? params : existing?.params || {};
    const iid = instanceId || uid('ti');
    const plan = planInstance({
      template: t, version, model: this.headEvent.model,
      mapping: useMapping, params: useParams, instanceId: iid,
      existing, pin: existing ? this._instancePinnedOnBranch(existing) : false,
      cidPrefix: iid,
    });
    return { ok: plan.ok, plan, template: t, version, errors: plan.errors, instance: existing };
  }

  /**
   * 把实例升级到新版本：在一次几何提交里原子替换其约束。
   * 升级失败（环 / 悬空 / 越界 / 校验）只影响该实例：旧约束原样保留、绝不留下部分替换，
   * 并把失败原因记录到实例（随文档持久化，刷新/重启仍可见）。
   */
  upgradeInstance(instanceId, targetNo, { params = null } = {}) {
    const ins = this.instanceById(instanceId);
    if (!ins) return { ok: false, error: '实例不存在' };
    const t = this.templateById(ins.templateId);
    if (!t) return { ok: false, error: '实例引用的模板已不存在（悬空引用）' };
    const fromV = tplVersion(t, ins.versionNo);
    const toV = tplVersion(t, targetNo);
    if (!fromV) return { ok: false, error: `实例固定在已缺失的版本 v${ins.versionNo}` };
    if (!toV) return { ok: false, error: `目标版本 v${targetNo} 不存在` };
    if (targetNo === ins.versionNo) return { ok: false, error: '实例已在该版本' };

    // 迁移旧覆盖（仍存在且仍可覆盖的保留；过期覆盖丢弃并在预览中报告）
    const migrated = migrateParams(fromV, toV, ins.params, ins.mapping);
    const useParams = params !== null ? params : migrated.params;
    const wasPinned = this._instancePinnedOnBranch(ins);

    const plan = planInstance({
      template: t, version: toV, model: this.headEvent.model,
      mapping: migrated.mapping, params: useParams,
      instanceId: ins.id, existing: ins, pin: false, cidPrefix: ins.id,
    });
    if (!plan.ok) {
      const reason = plan.errors[0]?.message || '升级被阻止';
      this._mutateInstance(instanceId, (x) => {
        x.lastError = { at: Date.now(), action: 'upgrade', fromNo: ins.versionNo, toNo: targetNo,
          errors: plan.errors.map((e) => ({ code: e.code, message: e.message })) };
        x.history = [...x.history, { t: Date.now(), action: 'upgrade-failed', fromNo: ins.versionNo, toNo: targetNo, error: reason }];
      });
      this._dirty = true;
      this.persist();
      this._emit('templates', { type: 'upgrade-failed', instanceId });
      // 旧约束未动：验证回滚后模型与实例仍一致
      return { ok: false, error: reason, errors: plan.errors, instance: this.instanceById(instanceId) };
    }

    const oldCids = new Set(ins.constraintIds);
    const res = this.commit((m) => {
      // 原子替换：先移除该实例的全部旧约束，再按计划写入新约束（同键沿用旧 id）
      m.constraints = m.constraints.filter((c) => !(c.tpl?.instanceId === instanceId));
      m.constraints = [...m.constraints, ...structuredClone(plan.constraints)];
    }, { label: `升级实例「${t.name}」v${ins.versionNo}→v${targetNo}` });
    if (!res.ok) {
      const reason = res.errors?.[0] || (res.cycle ? '升级后形成循环依赖' : '升级被阻止');
      this._mutateInstance(instanceId, (x) => {
        x.lastError = { at: Date.now(), action: 'upgrade', fromNo: ins.versionNo, toNo: targetNo, error: reason };
      });
      this._dirty = true;
      this.persist();
      this._emit('templates', { type: 'upgrade-failed', instanceId });
      return { ok: false, error: reason, cycle: res.cycle, instance: this.instanceById(instanceId) };
    }

    const now = Date.now();
    this._mutateInstance(instanceId, (x) => {
      x.versionNo = targetNo;
      x.params = plan.params;
      x.mapping = normalizeMappingOut(migrated.mapping, toV);
      x.constraintIds = plan.constraints.map((c) => c.id);
      x.status = 'linked';
      x.pinned = { ...x.pinned, [targetNo]: false };
      x.mapHash = mappingFingerprint(ins.templateId, targetNo, migrated.mapping);
      x.lastError = null;
      x.updatedAt = now;
      x.history = [...x.history, { t: now, action: 'upgrade', fromNo: ins.versionNo, toNo: targetNo }];
    });
    this._dirty = true;
    this.persist();
    this._emit('templates', { type: 'upgrade', instanceId, fromNo: ins.versionNo, toNo: targetNo });
    return {
      ok: true, plan, dropped: plan.dropped, paramDropped: migrated.dropped,
      templateDiff: diffTemplateVersions(fromV, toV),
    };
  }

  /**
   * 继续固定旧版本：不改动几何，只在该实例当前分支的约束上打 pin 标记（一次可撤销提交），
   * 之后新版本发布不再提示该实例升级。
   */
  pinInstanceVersion(instanceId) {
    const ins = this.instanceById(instanceId);
    if (!ins) return { ok: false, error: '实例不存在' };
    if (this._instancePinnedOnBranch(ins)) return { ok: true, already: true };
    const t = this.templateById(ins.templateId);
    const res = this.commit((m) => {
      for (const c of m.constraints) {
        if (c.tpl?.instanceId === instanceId) c.tpl = { ...c.tpl, pin: true };
      }
    }, { label: `固定实例「${t?.name || instanceId}」在 v${ins.versionNo}` });
    if (!res.ok) return { ok: false, error: res.errors?.[0] || '固定失败' };
    this._mutateInstance(instanceId, (x) => { x.pinned = { ...x.pinned, [x.versionNo]: true }; x.updatedAt = Date.now(); });
    this._dirty = true;
    this.persist();
    this._emit('templates', { type: 'pin', instanceId });
    return { ok: true };
  }

  /** 取消“固定旧版本”（一次可撤销提交，移除 pin 标记，几何不变）。 */
  unpinInstanceVersion(instanceId) {
    const ins = this.instanceById(instanceId);
    if (!ins) return { ok: false, error: '实例不存在' };
    const t = this.templateById(ins.templateId);
    const res = this.commit((m) => {
      for (const c of m.constraints) {
        if (c.tpl?.instanceId === instanceId) c.tpl = { ...c.tpl, pin: false };
      }
    }, { label: `取消固定实例「${t?.name || instanceId}」` });
    if (!res.ok) return { ok: false, error: res.errors?.[0] || '取消固定失败' };
    this._mutateInstance(instanceId, (x) => { x.pinned = { ...x.pinned, [x.versionNo]: false }; x.updatedAt = Date.now(); });
    this._dirty = true;
    this.persist();
    this._emit('templates', { type: 'unpin', instanceId });
    return { ok: true };
  }

  /**
   * 脱离模板：当前分支上该实例的约束保留为普通约束（移除 tpl 标签，一次可撤销提交），
   * 实例记录转为 detached（不再参与升级提示），其他实例不受影响。
   * 记录的 linked/detached 与画布标签由 reconcileInstanceStatuses 在 undo/redo / 装载 /
   * 切分支时统一对齐：撤销脱离会一起恢复记录、约束链接与可升级状态，重做则再次脱离。
   */
  detachInstance(instanceId) {
    const ins = this.instanceById(instanceId);
    if (!ins) return { ok: false, error: '实例不存在' };
    // 以当前 head 上的实际标签为准（记录 status 可能尚未随某次 undo 对齐）
    const linkedOnBranch = this.headEvent.model.constraints.some((c) => c.tpl?.instanceId === instanceId);
    if (ins.status === 'detached' || !linkedOnBranch) return { ok: false, error: '该实例已脱离模板' };
    const t = this.templateById(ins.templateId);
    const res = this.commit((m) => {
      for (const c of m.constraints) {
        if (c.tpl?.instanceId === instanceId) delete c.tpl;
      }
    }, { label: `实例脱离模板「${t?.name || ins.templateName}」` });
    if (!res.ok) return { ok: false, error: res.errors?.[0] || '脱离失败' };
    this._mutateInstance(instanceId, (x) => {
      x.status = 'detached';
      x.updatedAt = Date.now();
      x.history = [...x.history, { t: Date.now(), action: 'detach', fromNo: x.versionNo }];
    });
    this._dirty = true;
    this.persist();
    this._emit('templates', { type: 'detach', instanceId });
    return { ok: true };
  }

  /** 重新计算某实例在当前分支的 pin 状态（看模型标签）。 */
  _instancePinnedOnBranch(ins) {
    return this.headEvent.model.constraints.some((c) => c.tpl?.instanceId === ins.id && c.tpl?.pin);
  }

  /** 该实例在当前分支上是否仍以完整链接存在（用于幂等判定；脱离 / undo 到应用前不算）。 */
  _instanceCurrentOnBranch(instanceId) {
    const links = deriveInstanceLinks(this.templateInstances, this.headEvent.model);
    return links.get(instanceId)?.status === 'linked';
  }

  _mutateInstance(id, fn) {
    this.templateInstances = this.templateInstances.map((x) => {
      if (x.id !== id) return x;
      const clone = structuredClone(x);
      fn(clone);
      return clone;
    });
  }

  /** 模板版本间差异（发布新版本后逐个实例对比用）。 */
  templateVersionDiff(templateId, fromNo, toNo) {
    const t = this.templateById(templateId);
    if (!t) return null;
    const a = tplVersion(t, fromNo), b = tplVersion(t, toNo);
    if (!a || !b) return null;
    return diffTemplateVersions(a, b);
  }

  /**
   * 发布新版本后，逐个链接实例给出“升级会发生什么”的预览：
   * 约束 / 求解差异、是否会失败（环/越界/悬空）、被丢弃的过期覆盖。
   * 纯计算，不修改任何状态。
   */
  upgradePreviewsForNewVersion(templateId, toNo) {
    const t = this.templateById(templateId);
    if (!t || !tplVersion(t, toNo)) return [];
    const links = this.instanceLinks();
    const out = [];
    for (const ins of this.templateInstances) {
      if (ins.templateId !== templateId || ins.status === 'detached') continue;
      const link = links.get(ins.id);
      if (!link || link.status === 'absent') continue; // 未应用到当前分支 / 已 undo
      if (ins.versionNo === toNo) continue;
      const fromV = tplVersion(t, ins.versionNo);
      const toV = tplVersion(t, toNo);
      const pinned = !!link.pinned;
      if (!fromV || !toV) {
        out.push({ instanceId: ins.id, ok: false, pinned, errors: [{ code: 'missing-version', message: '实例固定在已缺失的版本' }] });
        continue;
      }
      const migrated = migrateParams(fromV, toV, ins.params, ins.mapping);
      const plan = planInstance({
        template: t, version: toV, model: this.headEvent.model,
        mapping: migrated.mapping, params: migrated.params,
        instanceId: ins.id, existing: ins, pin: pinned, cidPrefix: ins.id,
      });
      out.push({
        instanceId: ins.id, name: instanceLabel(ins),
        fromNo: ins.versionNo, toNo, pinned,
        ok: plan.ok, errors: plan.errors, changes: plan.changes,
        constraints: plan.constraints || [], model: plan.model || null,
        dropped: [...(plan.dropped || []), ...(migrated.dropped || [])],
        report: plan.report, templateDiff: diffTemplateVersions(fromV, toV),
      });
    }
    return out;
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

/** 仅保留模板版本中真实存在的槽位映射（键排序、值字符串化）。 */
function normalizeMappingOut(mapping, version) {
  const out = {};
  for (const s of version?.slots || []) {
    const v = mapping?.[s.id];
    if (v !== undefined && v !== null && v !== '') out[s.id] = String(v);
  }
  return out;
}

/** 实例可升级到的最高已发布版本号（草稿不计）。 */
function latestAvailableNo(template, fallback) {
  return template.publishedNo || Math.max(0, ...(template.versions || []).map((v) => v.no)) || fallback;
}

/** 在草稿克隆上跑一次 mutator，供冲突时保留“本地草稿”用。 */
function buildDraftAfterMutator(baseDraft, mutator) {
  const d = structuredClone(baseDraft);
  try { mutator(d); } catch {}
  return d;
}

/** 实例的显示名：模板名 + 槽位矩形名。 */
function instanceLabel(ins) {
  return ins.templateName || ins.templateId;
}

/** 把规则还原成可编辑 spec（409 后本地规则编辑以草稿保留时使用）。 */
function ruleSpecOf(rule) {
  return {
    name: rule.name,
    triggers: { ...rule.triggers },
    levels: (rule.levels || []).map((l) => ({ delayMin: l.delayMin, recipients: [...l.recipients] })),
    schedule: rule.schedule
      ? {
          workHours: (rule.schedule.workHours || []).map((r) => ({ ...r })),
          quietWeekly: (rule.schedule.quietWeekly || []).map((r) => ({ ...r })),
          quietWindows: (rule.schedule.quietWindows || []).map((w) => ({ ...w })),
        }
      : null,
  };
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

/* ---------------- 合并草案：清洗 / 合流 ---------------- */

const MERGE_DRAFT_STATUSES = new Set(['open', 'completed', 'abandoned', 'superseded']);

/**
 * 载入时清洗合并草案（确定性、幂等、不重算几何）：
 * - 丢弃结构不完整 / 重复 id（保留第一条）的草案；
 * - choices 只保留 {key,resolution,manual?} 且 resolution 合法（仅已确认选择）；
 * - priorChoices（更新 head 后仅供参考的旧选择）同构清洗，同样只保留合法 resolution；
 * - completed 必须带 mergeEventId/resultHash，否则回退 open（事件可能尚未合流到本页）。
 */
export function sanitizeMergeDrafts(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const d0 of list) {
    if (!d0 || typeof d0 !== 'object' || typeof d0.id !== 'string') continue;
    if (seen.has(d0.id)) continue;
    for (const k of ['targetBranchId', 'sourceBranchId', 'targetHeadId', 'sourceHeadId', 'baseEventId']) {
      if (typeof d0[k] !== 'string') { d0.malformed = true; break; }
    }
    if (d0.malformed) continue;
    seen.add(d0.id);
    let status = MERGE_DRAFT_STATUSES.has(d0.status) ? d0.status : 'open';
    if (status === 'completed' && (typeof d0.mergeEventId !== 'string' || typeof d0.resultHash !== 'string')) {
      status = 'open';
    }
    const cleanChoices = (raw) => (Array.isArray(raw) ? raw : [])
      .filter((c) => c && typeof c.key === 'string' && ['target', 'source', 'manual'].includes(c.resolution))
      .map((c) => ({
        key: c.key,
        resolution: c.resolution,
        ...(c.resolution === 'manual' && c.manual && typeof c.manual === 'object' ? { manual: c.manual } : {}),
        ...(Number.isFinite(c.at) ? { at: c.at } : {}),
      }));
    const choices = cleanChoices(d0.choices);
    // 参考选择里凡已确认的键一律剔除（参考不得与已确认选择并存/覆盖）
    const confirmedKeys = new Set(choices.map((c) => c.key));
    const priorChoices = cleanChoices(d0.priorChoices)
      .filter((c) => !confirmedKeys.has(c.key))
      .filter((c, i, arr) => arr.findIndex((x) => x.key === c.key) === i);
    out.push({
      id: d0.id,
      createdAt: Number.isFinite(d0.createdAt) ? d0.createdAt : 0,
      updatedAt: Number.isFinite(d0.updatedAt) ? d0.updatedAt : (Number.isFinite(d0.createdAt) ? d0.createdAt : 0),
      actor: typeof d0.actor === 'string' ? d0.actor : '',
      status,
      targetBranchId: d0.targetBranchId,
      sourceBranchId: d0.sourceBranchId,
      targetHeadId: d0.targetHeadId,
      sourceHeadId: d0.sourceHeadId,
      baseEventId: d0.baseEventId,
      baseHash: typeof d0.baseHash === 'string' ? d0.baseHash : '',
      targetHeadHash: typeof d0.targetHeadHash === 'string' ? d0.targetHeadHash : '',
      sourceHeadHash: typeof d0.sourceHeadHash === 'string' ? d0.sourceHeadHash : '',
      choices,
      priorChoices,
      refreshedAt: Number.isFinite(d0.refreshedAt) ? d0.refreshedAt : null,
      completedAt: Number.isFinite(d0.completedAt) ? d0.completedAt : null,
      mergeEventId: typeof d0.mergeEventId === 'string' ? d0.mergeEventId : null,
      resultHash: typeof d0.resultHash === 'string' ? d0.resultHash : null,
      report: d0.report && typeof d0.report === 'object' ? d0.report : null,
      conflictStale: d0.conflictStale && typeof d0.conflictStale === 'object' ? d0.conflictStale : null,
      ...(typeof d0.supersededBy === 'string' ? { supersededBy: d0.supersededBy } : {}),
    });
  }
  return out;
}
