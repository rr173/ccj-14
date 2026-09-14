/*
 * 审阅通知与升级中心：纯函数模块（无 DOM / 存储依赖）。
 *
 * 建立在既有「可恢复审阅会话 + 多人签署」之上：
 *
 * 1. 通知事件（notifyEvents[]，append-only）
 *    从审阅会话状态确定性派生（决定 / 签署进度 / 冲突 / 完成），事件 id 只依赖
 *    会话 id、节点 key、签名 id、序号等稳定身份，因此按事件幂等：同一事件永远只产生一条。
 *
 * 2. 通知规则（notifyRules[]，按会话配置，多级接收人 / 延迟 / 升级顺序）
 *    rule.rev 单调递增，携带乐观并发；规则修改后 revisedAt 作为水位：旧事件不会因为
 *    新规则 / 新接收人被补发（已物化的 (事件,级别,接收人) 仍保留）。
 *    rule.schedule 配置【每周工作时段】（workHours: 每周 0..10079 分钟的开区间段）
 *    与【静音窗口】（quietWindows: 一次性 [startAt,endAt] 绝对时间窗口 + 可重复的每周段）。
 *
 * 3. 通知项（notifications[]，按事件 × 升级级别 × 接收人幂等物化）
 *    id = hash32(ruleId|rev|eventId|level|recipient)。页面内可
 *    确认(ack) / 稍后提醒(snooze) / 转交(transfer) / 重排队(retry) / 批量(batch*)。
 *    事件在规则任一接收人确认后，后续升级级别不再物化（已经送达的更高级别不撤回）。
 *    静音窗口 / 非工作时段触发的通知：可发送时刻顺延到窗口结束后的第一个工作时刻
 *    （readyAt），状态为 deferred；窗口结束后按物化原顺序（seq / enqueuedAt）继续发送与升级。
 *
 * 4. 发送队列（notifyOutbox[]，严格 FIFO）
 *    due 的通知项按物化顺序入队；网络不可用时留在队列，恢复后按原顺序重试，
 *    每项有稳定 outbox id，重复入队 / 重复发送都按 id 幂等，attempts 持久化。
 *    队头处于 deferred（未到工作时刻）时阻塞后续项，保证「窗口结束后按原顺序」。
 *
 * 5. 批量处理（notifyBatches[]，append-only）
 *    收件箱可按会话批量 确认 / 稍后提醒 / 转交；批请求只提交成功项，遇到版本冲突
 *    （409 / 不可操作 / 缺失）的项保留为本地草稿（notifyDrafts[]），成功项照常提交。
 *    批量结果（成功 / 失败 / 冲突清单与原因）随文档持久化，刷新 / 重启后保持一致。
 *
 * 所有清洗 / 对账都是确定性、幂等的纯函数：刷新、重启、跨窗口合流后规则、队列、
 * 重试次数、升级状态、确认记录、静音计时、队列顺序、批处理结果和最终送达结果逐字节一致。
 */

import { uid } from './model.js';
import { hash32 } from './experiments.js';
import { normalizeReviewPolicy, signatureState, activeSignatures, DECISION_LABEL } from './reviews.js';

export const NOTIFY_FORMAT = 1;

/** 规则触发器（对应用户要求的四类） */
export const TRIGGER_TYPES = ['decision', 'signoff', 'conflict', 'completed'];
export const TRIGGER_LABEL = {
  decision: '决定（通过 / 驳回 / 待复核）',
  signoff: '签署进度（新签名 / 节点确认）',
  conflict: '冲突（指纹漂移 / 缺失 / 损坏 / 分支推进 / 基线变化）',
  completed: '完成状态（标记完成 / 重开）',
};

/** 通知事件类型（从会话状态派生） */
export const EVENT_TYPES = [
  'decision', 'signature', 'node-confirmed', 'conflict', 'conflict-resolved',
  'session-completed', 'session-reopened',
];
export const EVENT_LABEL = {
  decision: '节点决定',
  signature: '新签名',
  'node-confirmed': '节点签署确认',
  conflict: '审阅冲突',
  'conflict-resolved': '冲突解除',
  'session-completed': '会话完成',
  'session-reopened': '会话重开',
};

/** 通知项生命周期状态（deferred：在静音窗口 / 非工作时段内等待，到工作时刻后按原顺序发送） */
export const ITEM_STATES = ['scheduled', 'deferred', 'pending', 'sent', 'delivered', 'acknowledged', 'snoozed', 'transferred', 'failed', 'cancelled'];

const ACTIONABLE = new Set(['pending', 'sent', 'delivered', 'snoozed', 'failed', 'deferred']);
const TERMINAL = new Set(['acknowledged', 'transferred', 'cancelled']);
export const MAX_ATTEMPTS = 5;

/** 每周分钟数（0=本地时间周一 00:00）。 */
export const WEEK_MIN = 7 * 24 * 60;
export const DAY_MIN = 24 * 60;

/* ============================== 工具 ============================== */

export function normalizeRecipient(name) {
  return String(name || '').trim().slice(0, 40);
}

export function notifyItemId(ruleId, rev, eventId, level, recipient) {
  return `ni_${hash32(`${ruleId}|${rev}|${eventId}|${level}|${recipient}`)}`;
}

export function outboxItemId(notifyId) {
  return `ob_${hash32(notifyId)}`;
}

export function notifyEventId(parts) {
  return `ne_${hash32(parts.join('|'))}`;
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/* ============================== 工作时段 / 静音窗口（schedule） ============================== */

/** 本地时间的「周内分钟数」（0 = 周一 00:00 … 10079 = 周日 23:59）。 */
export function minuteOfWeek(d) {
  const x = d instanceof Date ? d : new Date(d);
  // JS getDay(): 周日=0 .. 周六=6 → 周一=0 .. 周日=6
  const day = (x.getDay() + 6) % 7;
  return day * DAY_MIN + x.getHours() * 60 + x.getMinutes();
}

function dateFromWeekMinute(refDate, target) {
  const refMin = minuteOfWeek(refDate);
  let delta = target - refMin;
  if (delta <= 0) delta += WEEK_MIN;
  return new Date(refDate.getTime() + delta * 60_000 - (refDate.getSeconds() * 1000 + refDate.getMilliseconds()));
}

function normalizeWorkRanges(raw) {
  const out = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    const from = clampInt(r?.from, 0, WEEK_MIN - 1, NaN);
    const to = clampInt(r?.to, 0, WEEK_MIN, NaN);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue;
    out.push({ from, to });
  }
  // 确定性合并重叠 / 相邻段
  out.sort((a, b) => (a.from - b.from) || (a.to - b.to));
  const merged = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else merged.push({ ...r });
  }
  return merged;
}

function normalizeQuietWeekly(raw) {
  const out = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    const from = clampInt(r?.from, 0, WEEK_MIN - 1, NaN);
    const to = clampInt(r?.to, 1, WEEK_MIN, NaN);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue;
    out.push({ from, to });
  }
  out.sort((a, b) => (a.from - b.from) || (a.to - b.to));
  return out;
}

function normalizeQuietWindows(raw) {
  const out = [];
  for (const w of Array.isArray(raw) ? raw : []) {
    const startAt = clampInt(w?.startAt, 0, 8.64e15, NaN);
    const endAt = clampInt(w?.endAt, 0, 8.64e15, NaN);
    if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) continue;
    out.push({ startAt, endAt, label: String(w?.label || '').slice(0, 60) });
  }
  out.sort((a, b) => (a.startAt - b.startAt) || (a.endAt - b.endAt));
  return out;
}

/**
 * 规范化规则的工作时间配置：
 *  - workHours：每周工作时段 [{from,to}]（周内分钟，可跨周）；空数组表示全天 24×7 可发送。
 *  - quietWeekly：每周重复的静音段 [{from,to}]（非工作时段之外的额外静音）。
 *  - quietWindows：一次性静音窗口 [{startAt,endAt,label}]（绝对时间，例如节假日 / 临时静默）。
 */
export function normalizeSchedule(raw = {}) {
  return {
    workHours: normalizeWorkRanges(raw.workHours),
    quietWeekly: normalizeQuietWeekly(raw.quietWeekly),
    quietWindows: normalizeQuietWindows(raw.quietWindows),
  };
}

function inWeeklyRanges(min, ranges) {
  return ranges.some((r) => min >= r.from && min < r.to);
}

/** 给定时刻是否处于规则的可发送时间（在工作时段内且不在任何静音窗口内）。 */
export function scheduleIsOpenAt(schedule, at) {
  const sch = schedule && (schedule.workHours || schedule.quietWeekly || schedule.quietWindows)
    ? schedule : normalizeSchedule(schedule);
  const d = new Date(at);
  const min = minuteOfWeek(d);
  if (sch.workHours.length && !inWeeklyRanges(min, sch.workHours)) return false;
  if (sch.quietWeekly.length && inWeeklyRanges(min, sch.quietWeekly)) return false;
  for (const w of sch.quietWindows || []) if (at >= w.startAt && at < w.endAt) return false;
  return true;
}

/** 收集一次性静音窗口在 [base, base+14d] 内的结束时刻（候选）。 */
function quietWindowEnds(sch, base) {
  const out = [];
  const horizon = base + 14 * 24 * 60 * 60_000;
  for (const w of sch.quietWindows || []) {
    if (w.endAt > base && w.endAt <= horizon) out.push(w.endAt);
  }
  return out;
}

/**
 * 计算不早于 earliest 的下一个可发送时刻（schedule 开放）。
 * 若 earliest 本身已开放，直接返回 earliest；否则扫描未来 14 天内所有
 * 工作时段 / 静音段边界，取第一个落在开放区间的时刻。全部配置为空时永远开放。
 */
export function nextOpenAt(schedule, earliest) {
  const sch = normalizeSchedule(schedule);
  const base = earliest;
  if (scheduleIsOpenAt(sch, base)) return base;
  if (!sch.workHours.length && !sch.quietWeekly.length && !sch.quietWindows.length) return base;

  const baseDate = new Date(base);
  const candidates = new Set(quietWindowEnds(sch, base));
  // 未来两周内每周工作段 / 静音段的起点（分钟边界）
  for (let k = 0; k <= 14; k++) {
    const day = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + k);
    day.setHours(0, 0, 0, 0);
    for (const r of sch.workHours) {
      candidates.add(dateFromWeekMinute(day, r.from).getTime());
      candidates.add(dateFromWeekMinute(day, r.to).getTime());
    }
    for (const r of sch.quietWeekly) {
      candidates.add(dateFromWeekMinute(day, r.from).getTime());
      candidates.add(dateFromWeekMinute(day, r.to).getTime());
    }
  }
  const sorted = [...candidates].filter((t) => t >= base).sort((a, b) => a - b);
  for (const t of sorted) {
    if (scheduleIsOpenAt(sch, t)) return t;
  }
  return base; // 兜底：配置极端（无任何工作段）时不无限推迟
}

/**
 * 通知项最早可发送 / 升级时刻：名义到期（事件时间 + 级别延迟，或稍后提醒时刻）
 * 再叠加工作时段与静音窗口顺延。返回绝对时间戳。
 */
export function readyAtFor(schedule, nominalDueAt) {
  const sch = normalizeSchedule(schedule || {});
  if (!sch.workHours.length && !sch.quietWeekly.length && !sch.quietWindows.length) return nominalDueAt;
  return nextOpenAt(sch, nominalDueAt);
}

/** 当前处于静音 / 非工作时段的人类可读说明（用于横幅 / 卡片）。 */
export function scheduleClosedReason(schedule, now = Date.now()) {
  const sch = normalizeSchedule(schedule || {});
  for (const w of sch.quietWindows || []) {
    if (now >= w.startAt && now < w.endAt) return `静音窗口${w.label ? `「${w.label}」` : ''}中，${fmtClock(w.endAt)} 结束`;
  }
  const min = minuteOfWeek(new Date(now));
  if (sch.quietWeekly.length && inWeeklyRanges(min, sch.quietWeekly)) {
    const r = sch.quietWeekly.find((x) => min >= x.from && min < x.to);
    return `每周静音时段中，${fmtClock(nextOpenAt(sch, now))} 恢复`;
  }
  if (sch.workHours.length && !inWeeklyRanges(min, sch.workHours)) {
    return `非工作时段，下个工作时刻 ${fmtClock(nextOpenAt(sch, now))}`;
  }
  return '';
}

const WEEKDAY_CN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
export function formatWeekMinute(m) {
  const day = Math.floor(m / DAY_MIN);
  const hm = m % DAY_MIN;
  const p = (n) => String(n).padStart(2, '0');
  return `${WEEKDAY_CN[day] || ''} ${p(Math.floor(hm / 60))}:${p(hm % 60)}`;
}

function fmtClock(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ============================== 规则 ============================== */

/**
 * 规范化一条多级升级规则：
 * levels: [{delayMin, recipients:[...]}]；level 0 立即发送，后续级别延迟到达且
 * 前一级别无人确认时升级。同级接收人去重，空级别被剔除。
 */
export function normalizeRule(raw = {}, { now = Date.now() } = {}) {
  const enabled = raw.enabled !== false;
  // 未显式配置触发器时默认全部触发；显式给出 triggers 对象时缺省为 false。
  const anyExplicit = raw.triggers && typeof raw.triggers === 'object';
  const triggers = {};
  for (const t of TRIGGER_TYPES) triggers[t] = anyExplicit ? !!raw.triggers[t] : true;

  const seen = new Set();
  const levels = [];
  const rawLevels = Array.isArray(raw.levels) && raw.levels.length
    ? raw.levels
    : [{ delayMin: 0, recipients: Array.isArray(raw.recipients) ? raw.recipients : [] }];
  rawLevels.forEach((lv, i) => {
    const recipients = [];
    const rseen = new Set();
    for (const r of Array.isArray(lv?.recipients) ? lv.recipients : []) {
      const name = normalizeRecipient(r);
      if (!name || rseen.has(name)) continue;
      rseen.add(name);
      if (!seen.has(name)) seen.add(name);
      recipients.push(name);
    }
    if (!recipients.length) return;
    levels.push({
      level: levels.length,
      delayMin: levels.length === 0 ? 0 : clampInt(lv?.delayMin, 0, 60 * 24 * 30, 0),
      recipients,
    });
  });

  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : now;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : uid('nr'),
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : null,
    name: String(raw.name || '通知规则').trim().slice(0, 60) || '通知规则',
    enabled,
    triggers,
    levels,
    schedule: normalizeSchedule(raw.schedule || {}),
    createdAt,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt,
    revisedAt: Number.isFinite(raw.revisedAt) ? raw.revisedAt : (Number.isFinite(raw.createdAt) ? raw.createdAt : now),
    createdBy: String(raw.createdBy || '未署名').trim().slice(0, 40) || '未署名',
    rev: Number.isInteger(raw.rev) && raw.rev >= 1 ? raw.rev : 1,
    deleted: raw.deleted === true,
    deleteRev: Number.isInteger(raw.deleteRev) ? raw.deleteRev : null,
  };
}

export function validateRule(raw) {
  const rule = normalizeRule(raw);
  if (!rule.sessionId) return { ok: false, error: '通知规则必须属于一个审阅会话' };
  if (!rule.levels.length) return { ok: false, error: '请至少配置一个升级级别并填写接收人' };
  if (!TRIGGER_TYPES.some((t) => rule.triggers[t])) return { ok: false, error: '请至少选择一种触发事件' };
  return { ok: true, rule };
}

/** 新建规则（rev=1，revisedAt=now：只对创建之后的事件生效，旧事件不补发）。 */
export function createRule({ sessionId, name, triggers, levels, schedule = null, actor = '', now = Date.now() }) {
  const check = validateRule({
    id: uid('nr'), sessionId, name, triggers, levels, schedule,
    createdAt: now, updatedAt: now, revisedAt: now, createdBy: actor, rev: 1,
  });
  if (!check.ok) throw new Error(check.error);
  return check.rule;
}

/**
 * 修改规则：triggers / levels / schedule / name 的编辑会推进 rev 并把 revisedAt
 * 推到当前时间（旧事件不再因新配置补发）；启用 / 停用切换是「暂停 / 恢复」语义，
 * 不推进 rev、不移动 revisedAt（恢复后未确认旧事件可继续升级）。
 */
export function editRule(rule, patch = {}, { now = Date.now() } = {}) {
  const onlyToggle = Object.keys(patch).every((k) => k === 'enabled');
  if (onlyToggle) {
    return { ...rule, enabled: patch.enabled !== false };
  }
  const next = normalizeRule({
    ...rule,
    name: patch.name ?? rule.name,
    triggers: { ...rule.triggers, ...(patch.triggers || {}) },
    levels: patch.levels ?? rule.levels,
    schedule: patch.schedule ?? rule.schedule,
    updatedAt: now,
    revisedAt: now,
    rev: rule.rev + 1,
  });
  // normalizeRule 不允许外部传入 sessionId 变化（规则与会话绑定）
  next.sessionId = rule.sessionId;
  next.id = rule.id;
  next.createdAt = rule.createdAt;
  next.createdBy = rule.createdBy;
  return next;
}

/** 删除规则（墓碑：保留 id / rev，便于跨窗口合流与时间线报告）。 */
export function deleteRule(rule, { now = Date.now() } = {}) {
  if (rule.deleted) return rule;
  return { ...rule, deleted: true, enabled: false, deleteRev: rule.rev + 1, rev: rule.rev + 1, updatedAt: now, revisedAt: now };
}

/* ============================== 通知事件派生 ============================== */

function typeOf(sn, policy) {
  const st = signatureState(sn, policy);
  return sn.autoReview ? 'review' : st.decision;
}

/**
 * 从审阅会话列表确定性派生全部通知事件（append-only）。
 * 已存在的事件按 id 并集保留；新识别出的事件按 (at,eventId) 排序追加。
 * 返回 { events, newEvents }，绝不修改既有事件。
 */
export function syncNotifyEvents(prevEvents, sessions, { now = Date.now() } = {}) {
  const byId = new Map();
  for (const e of Array.isArray(prevEvents) ? prevEvents : []) {
    if (e && typeof e.id === 'string' && EVENT_TYPES.includes(e.type)) byId.set(e.id, e);
  }
  const add = (e) => { if (!byId.has(e.id)) byId.set(e.id, e); };

  for (const s0 of Array.isArray(sessions) ? sessions : []) {
    if (!s0 || typeof s0.id !== 'string') continue;
    const policy = normalizeReviewPolicy(s0.policy);
    const signoff = policy.mode === 'signoff';
    const nodes = Array.isArray(s0.nodes) ? s0.nodes : [];

    for (const sn0 of nodes) {
      const sn = sn0 || {};
      const key = String(sn.key || '');
      if (!key) continue;

      // 冲突（自动转待复核：损坏 / 缺失 / 指纹漂移 / 分支推进）——每节点至多一条
      if (sn.autoReview) {
        const codes = Array.isArray(sn.autoReview.codes) && sn.autoReview.codes.length
          ? sn.autoReview.codes : [sn.autoReview.code || 'auto-review'];
        add({
          id: notifyEventId([s0.id, key, 'conflict', codes.join(',')]),
          sessionId: s0.id, nodeKey: key, type: 'conflict',
          at: sn.autoReview.at || s0.updatedAt || now,
          actor: '系统',
          codes,
          reason: sn.autoReview.reason || '',
          title: sn.title || key,
        });
      }

      // 显式冲突记录（基线变化等会话级冲突）
      for (const c of Array.isArray(s0.conflicts) ? s0.conflicts : []) {
        if (!c || !c.id) continue;
        add({
          id: notifyEventId([s0.id, key, 'conflict-rec', c.id]),
          sessionId: s0.id, nodeKey: c.nodeKey || key || null, type: 'conflict',
          at: c.at || s0.updatedAt || now, actor: '系统',
          codes: [c.code || 'conflict'], reason: c.text || '', title: sn.title || key || '会话',
          conflictId: c.id,
        });
        if (c.resolved && c.resolvedAt) {
          add({
            id: notifyEventId([s0.id, key, 'conflict-resolved', c.id]),
            sessionId: s0.id, nodeKey: c.nodeKey || key || null, type: 'conflict-resolved',
            at: c.resolvedAt, actor: c.resolution === 'merged-local-signature' ? '审阅人' : '系统',
            codes: [c.code || 'conflict'], reason: c.resolution || 'resolved',
            title: sn.title || key || '会话', conflictId: c.id,
          });
        }
      }

      if (signoff) {
        // 每条有效 / 失效签名都派生一次签署进度事件（id 含签名 id → 幂等）
        for (const sg of Array.isArray(sn.signatures) ? sn.signatures : []) {
          if (!sg || !sg.id) continue;
          add({
            id: notifyEventId([s0.id, key, 'signature', sg.id]),
            sessionId: s0.id, nodeKey: key, type: 'signature',
            at: sg.at || s0.updatedAt || now, actor: sg.by || '未署名',
            decision: sg.decision, reason: sg.reason || '',
            invalid: !!sg.invalid, invalidCode: sg.invalid?.code || null,
            title: sn.title || key, signatureId: sg.id,
          });
        }
        // 节点达到 required 个有效签名 → 确认事件（以 confirmedAt 为准，幂等）
        const st = signatureState(sn, policy);
        if (st.confirmed && sn.confirmedAt) {
          const sigIds = st.active.slice().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)).map((x) => x.id).join(',');
          add({
            id: notifyEventId([s0.id, key, 'confirmed', sigIds]),
            sessionId: s0.id, nodeKey: key, type: 'node-confirmed',
            at: sn.confirmedAt, actor: st.active.map((x) => x.by).join('、'),
            decision: st.decision, title: sn.title || key,
          });
        }
      } else {
        // 单人审阅：首次决定（decidedAt）+ 每次变更（history）
        if (sn.decision && sn.decision !== 'pending' && sn.decidedAt) {
          add({
            id: notifyEventId([s0.id, key, 'decision', 'initial', sn.decidedAt, sn.decision]),
            sessionId: s0.id, nodeKey: key, type: 'decision',
            at: sn.decidedAt, actor: sn.decidedBy || '未署名',
            decision: sn.decision, reason: sn.reason || '', title: sn.title || key,
          });
        }
        for (const h of Array.isArray(sn.history) ? sn.history : []) {
          if (!h || !h.to) continue;
          add({
            id: notifyEventId([s0.id, key, 'decision', 'hist', h.at, h.to, h.signatureId || '']),
            sessionId: s0.id, nodeKey: key, type: 'decision',
            at: h.at || s0.updatedAt || now, actor: h.by || '未署名',
            decision: h.to, reason: h.reason || '', title: sn.title || key, merged: !!h.merged,
          });
        }
      }
    }

    if (s0.status === 'completed' && s0.completedAt) {
      add({
        id: notifyEventId([s0.id, 'session-completed', s0.completedAt]),
        sessionId: s0.id, nodeKey: null, type: 'session-completed',
        at: s0.completedAt, actor: s0.createdBy || '系统', title: s0.name || s0.id,
      });
    }
    // 重开：变更记录里没有直接字段，用 status=active 且曾完成过无法稳定派生，
    // 因此重开由 store 在动作发生时显式注入（reopenEvents），此处不推断。
  }

  const events = [...byId.values()].sort(compareEvents);
  return { events, newEvents: events.filter((e) => !(Array.isArray(prevEvents) ? prevEvents : []).some((p) => p.id === e.id)) };
}

function compareEvents(a, b) {
  return (a.at - b.at)
    || rankEvent(a.type) - rankEvent(b.type)
    || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0)
    || (a.nodeKey || '').localeCompare(b.nodeKey || '')
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function rankEvent(t) {
  return { 'session-reopened': 0, 'session-completed': 1, conflict: 2, 'conflict-resolved': 3, decision: 4, signature: 5, 'node-confirmed': 6 }[t] ?? 9;
}

/** 规则触发器是否关心某类事件。 */
export function ruleMatchesEvent(rule, ev) {
  if (rule.deleted || !rule.enabled) return false;
  const t = ev.type;
  if (t === 'decision') return !!rule.triggers.decision;
  if (t === 'signature' || t === 'node-confirmed') return !!rule.triggers.signoff;
  if (t === 'conflict' || t === 'conflict-resolved') return !!rule.triggers.conflict;
  if (t === 'session-completed' || t === 'session-reopened') return !!rule.triggers.completed;
  return false;
}

/* ============================== 物化（事件 → 通知项） ============================== */

function levelByIndex(rule, level) {
  return (rule.levels || []).find((x) => x.level === level) || null;
}

/**
 * 物化通知项（幂等、确定性）。扫描每个启用规则关心的事件：
 *  - 事件早于规则 revisedAt 且该 (事件,级别,接收人) 此前没有物化过 → 跳过（规则修改不补发旧事件）；
 *  - 事件已被规则任一接收人确认（anchorKey 已确认）→ 尚未物化的更高级别不再升级；
 *  - 已存在的通知项原样保留（改延迟 / 改接收人不会改动历史项）。
 * 不做时间推进（scheduled→pending 在 pumpNotifications），只负责「该有哪些项」。
 */
export function materializeNotifications(prevItems, rules, events, { now = Date.now() } = {}) {
  const items = new Map();
  for (const it of Array.isArray(prevItems) ? prevItems : []) {
    if (it && typeof it.id === 'string') items.set(it.id, it);
  }
  const liveRules = new Map((Array.isArray(rules) ? rules : []).map((r) => [r.id, r]));

  // 确认索引：anchorKey(ruleId|eventId) -> 已确认的最高级别集合
  const acked = new Map();
  for (const it of items.values()) {
    if (it.status === 'acknowledged') {
      const set = acked.get(it.anchorKey) || new Set();
      set.add(it.level);
      acked.set(it.anchorKey, set);
    }
  }
  const isAcked = (ruleId, eventId, level) => {
    for (const [lv] of acked.get(`${ruleId}|${eventId}`) || []) if (lv <= level) return true;
    return false;
  };

  const added = [];
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (!rule || rule.deleted) continue;
    for (const ev of events) {
      if (ev.sessionId !== rule.sessionId) continue;
      if (!ruleMatchesEvent(rule, ev)) continue;
      for (const lv of rule.levels || []) {
        for (const recipient of lv.recipients || []) {
          const id = notifyItemId(rule.id, rule.rev, ev.id, lv.level, recipient);
          if (items.has(id)) continue;
          const anchorKey = `${rule.id}|${ev.id}`;
          // 规则修改水位：旧事件（在本次修订之前发生）且无历史项 → 不补发
          if (ev.at < rule.revisedAt) continue;
          // 升级抑制：事件已被更低 / 同级接收人确认 → 不再物化
          if (lv.level > 0 && isAcked(rule.id, ev.id, lv.level)) continue;
          const item = makeNotificationItem({ rule, level: lv.level, recipient, event: ev, now });
          items.set(id, item);
          added.push(item);
        }
      }
    }
  }

  // 已物化但规则被删除 / 修订不再覆盖的项：保留（历史不删除），不做清理。
  // seq 按物化顺序（dueAt → eventAt → level → id）确定性分配；新插入项顺延，
  // 相对顺序永远一致（刷新 / 重启后由同一排序重建，见 sanitizeNotifications）。
  const all = assignSeq([...items.values()].sort(compareItems));
  return { items: all, added };
}

/** 确定性序号：通知项的「物化原顺序」，静音窗口结束后据此按原顺序继续发送。 */
export function assignSeq(items) {
  let n = 0;
  for (const it of items) it.seq = n++;
  return items;
}

function makeNotificationItem({ rule, level, recipient, event, now }) {
  const lv = levelByIndex(rule, level) || { delayMin: 0 };
  const nominalDueAt = level === 0 ? event.at : event.at + lv.delayMin * 60_000;
  const readyAt = readyAtFor(rule.schedule, nominalDueAt);
  const status = nominalDueAt > now ? 'scheduled' : (readyAt > now ? 'deferred' : 'pending');
  return {
    id: notifyItemId(rule.id, rule.rev, event.id, level, recipient),
    anchorKey: `${rule.id}|${event.id}`,
    ruleId: rule.id,
    ruleRev: rule.rev,
    sessionId: rule.sessionId,
    eventId: event.id,
    eventType: event.type,
    level,
    recipient,
    title: event.title || rule.name,
    summary: summarizeEvent(event),
    eventAt: event.at,
    createdAt: now,
    dueAt: nominalDueAt,
    readyAt,
    seq: 0,
    status,
    attempts: 0,
    lastError: null,
    sentAt: null,
    deliveredAt: null,
    ackedAt: null,
    ackedBy: null,
    snoozeUntil: null,
    transferOf: null,
    history: [{ at: now, action: 'created', by: '系统',
      detail: `级别 ${level + 1} · ${recipient}${status === 'deferred' ? ' · 静音/非工作时段延迟' : ''}` }],
  };
}

/** 人类可读摘要（用于通知正文 / 时间线）。 */
export function summarizeEvent(ev) {
  const who = ev.actor ? `（${ev.actor}）` : '';
  switch (ev.type) {
    case 'decision':
      return `节点「${ev.title}」新决定：${DECISION_LABEL[ev.decision] || ev.decision}${who}${ev.reason ? `：${ev.reason}` : ''}`;
    case 'signature':
      return ev.invalid
        ? `节点「${ev.title}」签名失效（${ev.invalidCode || 'invalid'}）：${ev.actor} 的 ${DECISION_LABEL[ev.decision] || ev.decision}`
        : `节点「${ev.title}」新签名：${ev.actor} → ${DECISION_LABEL[ev.decision] || ev.decision}${who}${ev.reason ? `：${ev.reason}` : ''}`;
    case 'node-confirmed':
      return `节点「${ev.title}」已达有效签名数，确认为 ${DECISION_LABEL[ev.decision] || ev.decision}（${ev.actor || ''}）`;
    case 'conflict':
      return `审阅冲突：节点「${ev.title}」${ev.reason || (ev.codes || []).join('、') || '需要复核'}`;
    case 'conflict-resolved':
      return `冲突已解除：节点「${ev.title}」（${ev.reason || 'resolved'}）`;
    case 'session-completed':
      return `审阅会话「${ev.title}」已标记完成`;
    case 'session-reopened':
      return `审阅会话「${ev.title}」已重新打开`;
    default:
      return ev.title;
  }
}

function compareItems(a, b) {
  return (a.dueAt - b.dueAt) || (a.eventAt - b.eventAt) || (a.level - b.level)
    || ((a.seq ?? 0) - (b.seq ?? 0)) || (a.id < b.id ? -1 : 1);
}

/* ============================== pump：时间推进 + 升级抑制 + 队列 ============================== */

/**
 * 通知心跳（确定性）。在给定时间 now：
 *  1. scheduled 到期（名义到期）→ 若工作时段开放转 pending，否则进入 deferred（静音 / 非工作延迟）；
 *  2. deferred 到工作时刻（readyAt）→ pending（按物化原顺序继续）；
 *  3. snoozed 到点 → 开放则 pending；仍在静音 / 非工作时段则 deferred；
 *  4. 事件已被确认：scheduled/deferred 的更高级别转为 cancelled（不升级）；已 pending/sent 的保留；
 *  5. pending 项按物化顺序（enqueuedAt, seq, id）追加进 FIFO outbox（稳定 outbox id，幂等）；
 *  6. failed 且到达退避时刻（backoffMs）的项重新排队（attempts 保留；落在静音时段则 deferred）。
 * 不实际发送（发送在 store 的传输层），只推进状态与队列。
 */
export function pumpNotifications(items, outbox, { now = Date.now(), backoffMs = 30_000, schedules = null } = {}) {
  const ackedAnchors = new Set();
  for (const it of items) if (it.status === 'acknowledged') ackedAnchors.add(it.anchorKey);
  const scheduleOf = (it) => (schedules && schedules.get(it.ruleId)) || null;

  let changed = false;
  const nextItems = items.map((it0) => {
    let it = it0;
    const ackedHigher = () => ackedAnchors.has(it.anchorKey) && hasLowerAck(items, it);
    if (it.status === 'scheduled' && ackedHigher()) {
      it = { ...it, status: 'cancelled', history: [...it.history, { at: now, action: 'cancelled', by: '系统', detail: '事件已确认，升级取消' }] };
      changed = true;
    } else if (it.status === 'scheduled' && it.dueAt <= now) {
      const ready = it.readyAt ?? it.dueAt;
      if (ready > now) {
        it = { ...it, status: 'deferred', history: appendHist(it.history, now, 'deferred', '进入静音 / 非工作时段，窗口结束后按原顺序发送') };
      } else {
        it = { ...it, status: 'pending' };
      }
      changed = true;
    } else if (it.status === 'deferred') {
      // 事件在延迟期间被确认 → 取消升级
      if (ackedHigher()) {
        it = { ...it, status: 'cancelled', history: appendHist(it.history, now, 'cancelled', '事件已确认，静音中的升级取消') };
        changed = true;
      } else if ((it.readyAt ?? it.dueAt ?? 0) <= now) {
        it = { ...it, status: 'pending', history: appendHist(it.history, now, 'resume', '静音窗口结束，按原顺序继续发送') };
        changed = true;
      }
    } else if (it.status === 'snoozed' && (it.snoozeUntil ?? Infinity) <= now) {
      const sch = scheduleOf(it);
      const ready = sch ? readyAtFor(sch, it.snoozeUntil) : it.snoozeUntil;
      if (ready > now) {
        it = { ...it, status: 'deferred', snoozeUntil: null, readyAt: ready,
          history: appendHist(it.history, now, 'deferred', '稍后提醒到期但处于静音 / 非工作时段，工作时刻继续提醒') };
      } else {
        it = { ...it, status: 'pending', snoozeUntil: null, readyAt: ready,
          history: appendHist(it.history, now, 'snooze-done', it.ackedBy || it.recipient, '稍后提醒到期') };
      }
      changed = true;
    } else if (it.status === 'failed' && it.retryAfter != null && it.retryAfter <= now && it.attempts < MAX_ATTEMPTS) {
      const sch = scheduleOf(it);
      const ready = sch ? readyAtFor(sch, it.retryAfter) : it.retryAfter;
      if (ready > now) {
        it = { ...it, status: 'deferred', retryAfter: null, readyAt: ready,
          history: appendHist(it.history, now, 'deferred', '退避到期但处于静音 / 非工作时段') };
      } else {
        it = { ...it, status: 'pending', retryAfter: null, readyAt: ready };
      }
      changed = true;
    }
    return it;
  });

  // FIFO 入队：按 (enqueuedAt, seq, id) 确定性排序。延迟项在窗口结束的同一拍转 pending，
  // 用 seq（物化原顺序）作次序，保证「窗口结束后按原顺序继续发送」。
  // 已在队列的不重复；同时剔除引用已非 pending（已送达/确认/转交/取消）项的陈旧队列条目，
  // 避免 recordDeliveryAttempt 与 pump 交错时把已送达项重新入队。
  const statusById = new Map(nextItems.map((x) => [x.id, x.status]));
  const seqById = new Map(nextItems.map((x) => [x.id, Number.isFinite(x.seq) ? x.seq : 0]));
  const liveOutbox = (Array.isArray(outbox) ? outbox : [])
    .filter((o) => statusById.get(o.notifyId) === 'pending')
    .map((o) => (Number.isFinite(o.seq) ? o : { ...o, seq: seqById.get(o.notifyId) ?? 0 }));
  const queued = new Set(liveOutbox.map((o) => o.notifyId));
  const enqueued = new Set();
  const additions = [];
  for (const it of [...nextItems].sort(compareQueueOrder)) {
    if (it.status !== 'pending') continue;
    if (queued.has(it.id) || enqueued.has(it.id)) continue;
    enqueued.add(it.id);
    additions.push({
      id: outboxItemId(it.id), notifyId: it.id,
      enqueuedAt: now, seq: Number.isFinite(it.seq) ? it.seq : 0, attempts: 0, status: 'queued',
    });
  }

  const nextOutbox = [...liveOutbox, ...additions].sort(compareOutbox);
  return { items: nextItems, outbox: nextOutbox, changed: changed || additions.length > 0 || liveOutbox.length !== (Array.isArray(outbox) ? outbox.length : 0), enqueued: additions.length };
}

function appendHist(history, at, action, by, detail = '') {
  return [...history, detail ? { at, action, by, detail } : { at, action, by }];
}

function compareQueueOrder(a, b) {
  return (a.dueAt - b.dueAt) || (a.eventAt - b.eventAt) || (a.level - b.level)
    || ((a.seq ?? 0) - (b.seq ?? 0)) || (a.id < b.id ? -1 : 1);
}

function compareOutbox(a, b) {
  return (a.enqueuedAt - b.enqueuedAt) || ((a.seq ?? 0) - (b.seq ?? 0)) || (a.id < b.id ? -1 : 1);
}

function hasLowerAck(items, it) {
  return items.some((x) => x.anchorKey === it.anchorKey && x.status === 'acknowledged' && x.level <= it.level);
}

/* ============================== 队列发送结果归并 ============================== */

/**
 * 传输层尝试发送后的状态归并（由 store 调用，真实网络结果在此落地）。
 *  - 成功：queued/outbox 项移除，通知项 sent/delivered，记录时间；
 *  - 失败：attempts+1，达到 MAX_ATTEMPTS → failed（终态，报告失败原因），
 *    否则保留在队列（status 仍 queued，记录 lastError / nextAttemptAt），按 FIFO 稍后重试。
 * outbox 与通知项都按稳定 id 幂等更新，重复回调不会产生重复发送记录。
 */
export function recordDeliveryAttempt(items, outbox, notifyId, result, { now = Date.now(), backoffMs = 30_000 } = {}) {
  const ob = (Array.isArray(outbox) ? outbox : []).find((o) => o.notifyId === notifyId);
  let nextOutbox = Array.isArray(outbox) ? outbox : [];
  let nextItems = items;

  if (result.ok) {
    nextOutbox = nextOutbox.filter((o) => o.notifyId !== notifyId);
    nextItems = items.map((it) => {
      if (it.id !== notifyId) return it;
      if (it.status === 'sent' || it.status === 'delivered' || TERMINAL.has(it.status)) return it;
      return {
        ...it, status: 'delivered', attempts: it.attempts + 1,
        sentAt: it.sentAt || now, deliveredAt: now, lastError: null, retryAfter: null,
        history: [...it.history, { at: now, action: 'delivered', by: '系统', detail: result.detail || '送达成功' }],
      };
    });
  } else {
    const attempts = (ob?.attempts ?? items.find((i) => i.id === notifyId)?.attempts ?? 0) + 1;
    const giveUp = attempts >= MAX_ATTEMPTS;
    nextOutbox = nextOutbox.map((o) => (o.notifyId === notifyId
      ? { ...o, attempts, status: giveUp ? 'dead' : 'queued', lastError: result.error || '发送失败', nextAttemptAt: giveUp ? null : now + backoffMs }
      : o));
    // 达到上限：从队列移除，通知项置 failed（可在页面手动重排队）
    if (giveUp) nextOutbox = nextOutbox.filter((o) => o.notifyId !== notifyId);
    nextItems = items.map((it) => {
      if (it.id !== notifyId) return it;
      const history = [...it.history, { at: now, action: giveUp ? 'failed' : 'send-error', by: '系统', detail: result.error || '发送失败' }];
      return giveUp
        ? { ...it, status: 'failed', attempts, lastError: result.error || '发送失败', retryAfter: null, history }
        : { ...it, attempts, lastError: result.error || '发送失败', retryAfter: now + backoffMs, history };
    });
  }
  return { items: nextItems, outbox: nextOutbox };
}

/* ============================== 页面操作：确认 / 稍后 / 转交 / 重排 ============================== */

function findItem(items, id) {
  return (items || []).find((x) => x.id === id) || null;
}

/** 确认：通知项进入 acknowledged 终态；同事件更高级别不再升级（在下次 pump 取消未到期项）。 */
export function acknowledgeNotification(items, id, { by = '', now = Date.now(), note = '' } = {}) {
  const it = findItem(items, id);
  if (!it) return { status: 404, reason: 'notification-missing' };
  if (it.status === 'acknowledged') return { status: 200, idempotent: true, items };
  const next = items.map((x) => (x.id === id
    ? { ...x, status: 'acknowledged', ackedAt: now, ackedBy: by, snoozeUntil: null,
        history: [...x.history, { at: now, action: 'acknowledge', by, detail: note || '已确认' }] }
    : x));
  return { status: 200, items: next };
}

/** 稍后提醒：snoozed，到点后由 pump 重新置 pending（不影响升级计时）。 */
export function snoozeNotification(items, id, snoozeMin, { by = '', now = Date.now() } = {}) {
  const it = findItem(items, id);
  if (!it) return { status: 404, reason: 'notification-missing' };
  if (!ACTIONABLE.has(it.status)) return { status: 409, reason: `not-actionable:${it.status}` };
  const mins = clampInt(snoozeMin, 1, 60 * 24 * 30, 15);
  const until = now + mins * 60_000;
  const next = items.map((x) => (x.id === id
    ? { ...x, status: 'snoozed', snoozeUntil: until,
        history: [...x.history, { at: now, action: 'snooze', by, detail: `${mins} 分钟后提醒` }] }
    : x));
  return { status: 200, items: next, until };
}

/**
 * 转交：原项进入 transferred 终态（保留记录），在同级别为新接收人创建一条通知，
 * id 含来源通知 id → 同一转交幂等；重复转交给同一人不产生副本。
 * 新通知按规则工作时段 / 静音窗口决定 readyAt（落在静音中为 deferred）。
 */
export function transferNotification(items, id, to, { by = '', now = Date.now(), reason = '', schedule = null } = {}) {
  const it = findItem(items, id);
  if (!it) return { status: 404, reason: 'notification-missing' };
  if (!ACTIONABLE.has(it.status)) return { status: 409, reason: `not-actionable:${it.status}` };
  const recipient = normalizeRecipient(to);
  if (!recipient) return { status: 400, reason: 'recipient-required' };
  if (recipient === it.recipient) return { status: 400, reason: 'same-recipient' };

  const newId = `ni_${hash32(`${it.ruleId}|${it.ruleRev}|${it.eventId}|${it.level}|${recipient}|transfer|${it.id}`)}`;
  if (items.some((x) => x.id === newId)) {
    return { status: 200, idempotent: true, items, newId };
  }
  const closed = items.map((x) => (x.id === id
    ? { ...x, status: 'transferred', transferredTo: recipient, transferredAt: now,
        history: [...x.history, { at: now, action: 'transfer', by, detail: `转交给 ${recipient}${reason ? `：${reason}` : ''}` }] }
    : x));
  const readyAt = readyAtFor(schedule, now);
  const fresh = {
    id: newId, anchorKey: it.anchorKey, ruleId: it.ruleId, ruleRev: it.ruleRev,
    sessionId: it.sessionId, eventId: it.eventId, eventType: it.eventType,
    level: it.level, recipient, title: it.title, summary: it.summary,
    eventAt: it.eventAt, createdAt: now, dueAt: now, readyAt, seq: 0,
    status: readyAt > now ? 'deferred' : 'pending',
    attempts: 0, lastError: null, sentAt: null, deliveredAt: null, ackedAt: null,
    ackedBy: null, snoozeUntil: null, transferOf: it.id,
    history: [{ at: now, action: 'created', by: '系统',
      detail: `由 ${it.recipient} 转交（级别 ${it.level + 1}）${readyAt > now ? ' · 静音/非工作时段延迟' : ''}` }],
  };
  return { status: 200, items: assignSeq([...closed, fresh].sort(compareItems)), newId };
}

/** 失败项手动重排队：attempts 清零、回到 pending（下一次 pump 重新入队）；落在静音时段则 deferred。 */
export function retryNotification(items, id, { now = Date.now(), by = '', schedule = null } = {}) {
  const it = findItem(items, id);
  if (!it) return { status: 404, reason: 'notification-missing' };
  if (it.status !== 'failed') return { status: 409, reason: 'not-failed' };
  const readyAt = readyAtFor(schedule, now);
  const next = items.map((x) => (x.id === id
    ? { ...x, status: readyAt > now ? 'deferred' : 'pending', attempts: 0, lastError: null, retryAfter: null, readyAt,
        history: [...x.history, { at: now, action: 'retry', by, detail: readyAt > now ? '手动重新排队（静音 / 非工作时段延迟）' : '手动重新排队' }] }
    : x));
  return { status: 200, items: next };
}

/* ============================== 批量处理（按会话） ============================== */

export const BATCH_ACTIONS = ['ack', 'snooze', 'transfer'];

export function batchId() {
  return uid('nb');
}

/**
 * 在给定 id 列表上逐项应用同一动作（确认 / 稍后 / 转交）。
 * 纯函数，逐项隔离：单项失败（缺失 / 状态不可操作 / 参数非法 / 幂等）绝不影响其他项。
 * 返回：
 *  - items：应用成功后的完整通知项列表（顺序重排为 compareItems 并重新分配 seq）；
 *  - results：每项 { id, ok, status, reason?, until?/newId? }，保持入参 id 顺序；
 *  - success / failed 计数；
 *  - spawned：转交产生的新通知项映射 sourceId -> newId（store 用来注册乐观动作）。
 */
export function applyBatchNotifications(items, ids, action, opts = {}) {
  const by = opts.by || '';
  const now = opts.now ?? Date.now();
  const schedules = opts.schedules || null;
  const results = [];
  let current = items;
  const spawned = new Map();
  let success = 0; let failed = 0;

  for (const id of Array.isArray(ids) ? ids : []) {
    const target = current.find((x) => x.id === id);
    if (!target) { results.push({ id, ok: false, status: 404, reason: 'notification-missing' }); failed++; continue; }
    let res;
    if (action === 'ack') {
      res = acknowledgeNotification(current, id, { by, now, note: opts.note || '' });
    } else if (action === 'snooze') {
      res = snoozeNotification(current, id, opts.snoozeMin, { by, now });
    } else if (action === 'transfer') {
      const rule = schedules.get(target.ruleId);
      res = transferNotification(current, id, opts.to, { by, now, reason: opts.reason || '', schedule: rule?.schedule || null });
    } else {
      res = { status: 400, reason: 'unknown-action' };
    }
    if (res.status === 200 && res.idempotent) {
      results.push({ id, ok: true, idempotent: true, status: 200 });
      success++;
      continue;
    }
    if (res.status === 200) {
      current = res.items;
      const r = { id, ok: true, status: 200 };
      if (res.until) r.until = res.until;
      if (res.newId) { r.newId = res.newId; spawned.set(id, res.newId); }
      results.push(r);
      success++;
    } else {
      results.push({ id, ok: false, status: res.status, reason: res.reason || 'failed' });
      failed++;
    }
  }

  // 转交产生新项后重排原顺序（seq 确定性重建）
  if (spawned.size) current = assignSeq([...current].sort(compareItems));
  return { items: current, results, success, failed, spawned };
}

/**
 * 构建一条持久化的批量处理结果（notifyBatches[]，append-only）。
 * 部分版本冲突：成功项照常提交，失败项（含原因）保留，store 同时为其保留本地草稿。
 */
export function makeBatchRecord({ id, sessionId = null, action, ids = [], results = [], by = '', now = Date.now(), payload = {} }) {
  const success = results.filter((r) => r.ok).length;
  return {
    id,
    sessionId,
    action,
    by: String(by || '未署名').slice(0, 40),
    at: now,
    requested: ids.length,
    success,
    failed: results.length - success,
    payload: action === 'snooze'
      ? { snoozeMin: clampInt(payload.snoozeMin, 1, 60 * 24 * 30, 15) }
      : action === 'transfer'
        ? { to: normalizeRecipient(payload.to) || '', reason: String(payload.reason || '').slice(0, 300) }
        : { note: String(payload.note || '').slice(0, 300) },
    results: results.map((r) => ({
      id: r.id, ok: !!r.ok, idempotent: !!r.idempotent,
      status: r.status || (r.ok ? 200 : 0),
      reason: r.reason || null, newId: r.newId || null, until: r.until || null,
    })),
  };
}

export function sanitizeBatches(raw) {
  const seen = new Set();
  const out = [];
  for (const b0 of Array.isArray(raw) ? raw : []) {
    if (!b0 || typeof b0.id !== 'string' || !BATCH_ACTIONS.includes(b0.action)) continue;
    if (seen.has(b0.id)) continue;
    seen.add(b0.id);
    const results = (Array.isArray(b0.results) ? b0.results : []).filter((r) => r && typeof r.id === 'string').slice(0, 5000)
      .map((r) => ({
        id: r.id, ok: !!r.ok, idempotent: !!r.idempotent,
        status: Number.isInteger(r.status) ? r.status : (r.ok ? 200 : 0),
        reason: typeof r.reason === 'string' ? r.reason.slice(0, 120) : null,
        newId: typeof r.newId === 'string' ? r.newId : null,
        until: Number.isFinite(r.until) ? r.until : null,
      }));
    out.push({
      id: b0.id,
      sessionId: typeof b0.sessionId === 'string' ? b0.sessionId : null,
      action: b0.action,
      by: String(b0.by || '未署名').slice(0, 40),
      at: Number.isFinite(b0.at) ? b0.at : 0,
      requested: clampInt(b0.requested, 0, 5000, results.length),
      success: clampInt(b0.success, 0, 5000, results.filter((r) => r.ok).length),
      failed: clampInt(b0.failed, 0, 5000, results.filter((r) => !r.ok).length),
      payload: b0.payload && typeof b0.payload === 'object' ? {
        snoozeMin: Number.isInteger(b0.payload.snoozeMin) ? b0.payload.snoozeMin : null,
        to: typeof b0.payload.to === 'string' ? b0.payload.to.slice(0, 40) : null,
        reason: typeof b0.payload.reason === 'string' ? b0.payload.reason.slice(0, 300) : null,
        note: typeof b0.payload.note === 'string' ? b0.payload.note.slice(0, 300) : null,
      } : {},
      results,
    });
  }
  return out.sort((a, b) => (a.at - b.at) || (a.id < b.id ? -1 : 1));
}

export function mergeBatches(serverList, clientList) {
  const byId = new Map();
  for (const b of [...(Array.isArray(serverList) ? serverList : []), ...(Array.isArray(clientList) ? clientList : [])]) {
    if (b && typeof b.id === 'string') byId.set(b.id, b); // append-only 幂等并集
  }
  return [...byId.values()].sort((a, b) => (a.at - b.at) || (a.id < b.id ? -1 : 1));
}

/* ============================== 本地草稿（批量部分失败时保留，随文档持久化） ============================== */

/** 本地未提交通知项草稿 id：稳定身份，重复失败不产生副本。 */
export function draftId(notifyId, action, payload = {}) {
  const key = `${notifyId}|${action}|${payload.to || ''}|${payload.snoozeMin || ''}|${payload.note || ''}`;
  return `nd_${hash32(key)}`;
}

export function makeDraft({ notifyId, action, payload = {}, by = '', at = Date.now(), reason = '' }) {
  return {
    id: draftId(notifyId, action, payload),
    notifyId, action,
    payload: action === 'snooze'
      ? { snoozeMin: clampInt(payload.snoozeMin, 1, 60 * 24 * 30, 15) }
      : action === 'transfer'
        ? { to: normalizeRecipient(payload.to) || '', reason: String(payload.reason || '').slice(0, 300) }
        : { note: String(payload.note || '').slice(0, 300) },
    by: String(by || '未署名').slice(0, 40),
    at,
    reason: String(reason || '').slice(0, 120),
  };
}

export function sanitizeDrafts(raw) {
  const seen = new Set();
  const out = [];
  for (const d0 of Array.isArray(raw) ? raw : []) {
    if (!d0 || typeof d0.id !== 'string' || typeof d0.notifyId !== 'string' || !BATCH_ACTIONS.includes(d0.action)) continue;
    if (seen.has(d0.id)) continue;
    seen.add(d0.id);
    const d = makeDraft({
      notifyId: d0.notifyId, action: d0.action, payload: d0.payload || {},
      by: d0.by, at: Number.isFinite(d0.at) ? d0.at : 0, reason: d0.reason || '',
    });
    out.push({ ...d, id: d0.id }); // 保留稳定 id（跨窗口合流 / 去重以它为准）
  }
  return out.sort((a, b) => (a.at - b.at) || (a.id < b.id ? -1 : 1));
}

export function mergeDrafts(serverList, clientList) {
  const byId = new Map();
  for (const d of [...(Array.isArray(serverList) ? serverList : []), ...(Array.isArray(clientList) ? clientList : [])]) {
    if (d && typeof d.id === 'string') byId.set(d.id, d);
  }
  return [...byId.values()].sort((a, b) => (a.at - b.at) || (a.id < b.id ? -1 : 1));
}

/* ============================== 待处理收件箱 / 统计 ============================== */

/** 当前接收人的待处理通知（可确认 / 稍后 / 转交）。 */
export function pendingInbox(items, recipient, { now = Date.now() } = {}) {
  const me = normalizeRecipient(recipient);
  return items
    .filter((it) => it.recipient === me && ACTIONABLE.has(it.status))
    .filter((it) => it.status !== 'snoozed' || (it.snoozeUntil ?? Infinity) <= now)
    .sort(compareItems);
}

export function notificationCounters(items, recipient = null) {
  const scope = recipient ? items.filter((it) => it.recipient === normalizeRecipient(recipient)) : items;
  const c = { total: scope.length, scheduled: 0, deferred: 0, pending: 0, delivered: 0, acknowledged: 0, snoozed: 0, transferred: 0, failed: 0, cancelled: 0, actionable: 0 };
  for (const it of scope) {
    if (it.status === 'sent') c.delivered += 1;
    else if (it.status === 'delivered') c.delivered += 1;
    else c[it.status] = (c[it.status] || 0) + 1;
    if (ACTIONABLE.has(it.status) && it.status !== 'snoozed') c.actionable += 1;
  }
  return c;
}

/* ============================== 加载清洗 ============================== */

export function sanitizeNotifyEvents(raw) {
  const seen = new Set();
  const out = [];
  for (const e0 of Array.isArray(raw) ? raw : []) {
    if (!e0 || typeof e0.id !== 'string' || !EVENT_TYPES.includes(e0.type) || typeof e0.sessionId !== 'string') continue;
    if (seen.has(e0.id)) continue;
    seen.add(e0.id);
    out.push({
      id: e0.id,
      sessionId: e0.sessionId,
      nodeKey: typeof e0.nodeKey === 'string' ? e0.nodeKey : null,
      type: e0.type,
      at: Number.isFinite(e0.at) ? e0.at : 0,
      actor: String(e0.actor || '系统').slice(0, 40),
      decision: ['pass', 'reject', 'review'].includes(e0.decision) ? e0.decision : null,
      reason: typeof e0.reason === 'string' ? e0.reason.slice(0, 2000) : '',
      title: String(e0.title || '').slice(0, 120),
      codes: Array.isArray(e0.codes) ? e0.codes.filter((x) => typeof x === 'string').slice(0, 20) : [],
      invalid: !!e0.invalid,
      invalidCode: typeof e0.invalidCode === 'string' ? e0.invalidCode : null,
      signatureId: typeof e0.signatureId === 'string' ? e0.signatureId : null,
      conflictId: typeof e0.conflictId === 'string' ? e0.conflictId : null,
      merged: !!e0.merged,
    });
  }
  return out.sort(compareEvents);
}

export function sanitizeRules(raw, { now = Date.now() } = {}) {
  const seen = new Set();
  const out = [];
  for (const r0 of Array.isArray(raw) ? raw : []) {
    if (!r0 || typeof r0.id !== 'string' || typeof r0.sessionId !== 'string') continue;
    if (seen.has(r0.id)) continue;
    seen.add(r0.id);
    out.push(normalizeRule(r0, { now }));
  }
  return out.sort((a, b) => (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : 1));
}

export function sanitizeNotifications(raw, { now = Date.now() } = {}) {
  const seen = new Set();
  const out = [];
  for (const n0 of Array.isArray(raw) ? raw : []) {
    if (!n0 || typeof n0.id !== 'string' || typeof n0.ruleId !== 'string' || typeof n0.eventId !== 'string') continue;
    if (seen.has(n0.id)) continue;
    seen.add(n0.id);
    const status = ITEM_STATES.includes(n0.status) ? n0.status : 'scheduled';
    out.push({
      id: n0.id,
      anchorKey: typeof n0.anchorKey === 'string' ? n0.anchorKey : `${n0.ruleId}|${n0.eventId}`,
      ruleId: n0.ruleId,
      ruleRev: Number.isInteger(n0.ruleRev) ? n0.ruleRev : 1,
      sessionId: typeof n0.sessionId === 'string' ? n0.sessionId : null,
      eventId: n0.eventId,
      eventType: EVENT_TYPES.includes(n0.eventType) ? n0.eventType : 'decision',
      level: Number.isInteger(n0.level) && n0.level >= 0 ? n0.level : 0,
      recipient: normalizeRecipient(n0.recipient) || '未署名',
      title: String(n0.title || '').slice(0, 120),
      summary: String(n0.summary || '').slice(0, 500),
      eventAt: Number.isFinite(n0.eventAt) ? n0.eventAt : 0,
      createdAt: Number.isFinite(n0.createdAt) ? n0.createdAt : now,
      dueAt: Number.isFinite(n0.dueAt) ? n0.dueAt : 0,
      readyAt: Number.isFinite(n0.readyAt) ? n0.readyAt : (Number.isFinite(n0.dueAt) ? n0.dueAt : 0),
      seq: Number.isFinite(n0.seq) ? n0.seq : 0,
      status,
      attempts: clampInt(n0.attempts, 0, 999, 0),
      lastError: n0.lastError ? String(n0.lastError).slice(0, 500) : null,
      sentAt: Number.isFinite(n0.sentAt) ? n0.sentAt : null,
      deliveredAt: Number.isFinite(n0.deliveredAt) ? n0.deliveredAt : null,
      ackedAt: Number.isFinite(n0.ackedAt) ? n0.ackedAt : null,
      ackedBy: typeof n0.ackedBy === 'string' ? n0.ackedBy : null,
      snoozeUntil: Number.isFinite(n0.snoozeUntil) ? n0.snoozeUntil : null,
      retryAfter: Number.isFinite(n0.retryAfter) ? n0.retryAfter : null,
      transferredTo: typeof n0.transferredTo === 'string' ? n0.transferredTo : null,
      transferredAt: Number.isFinite(n0.transferredAt) ? n0.transferredAt : null,
      transferOf: typeof n0.transferOf === 'string' ? n0.transferOf : null,
      history: sanitizeHistory(n0.history, now),
    });
  }
  // 旧版文档没有 seq / readyAt：按物化顺序确定性重建，重启后队列原顺序逐字节一致
  out.sort(compareItems);
  assignSeq(out);
  return out;
}

function sanitizeHistory(raw, now) {
  const ACTIONS = new Set(['created', 'delivered', 'send-error', 'failed', 'acknowledge', 'snooze', 'snooze-done', 'transfer', 'retry', 'cancelled', 'deferred', 'resume']);
  const out = [];
  for (const h of Array.isArray(raw) ? raw : []) {
    if (!h || !ACTIONS.has(h.action)) continue;
    out.push({
      at: Number.isFinite(h.at) ? h.at : now,
      action: h.action,
      by: String(h.by || '系统').slice(0, 40),
      detail: String(h.detail || '').slice(0, 300),
    });
  }
  return out;
}

export function sanitizeOutbox(raw, { now = Date.now() } = {}) {
  const seen = new Set();
  const out = [];
  for (const o0 of Array.isArray(raw) ? raw : []) {
    if (!o0 || typeof o0.id !== 'string' || typeof o0.notifyId !== 'string') continue;
    if (seen.has(o0.notifyId)) continue;
    seen.add(o0.notifyId);
    out.push({
      id: o0.id,
      notifyId: o0.notifyId,
      enqueuedAt: Number.isFinite(o0.enqueuedAt) ? o0.enqueuedAt : now,
      seq: Number.isFinite(o0.seq) ? o0.seq : 0,
      attempts: clampInt(o0.attempts, 0, 999, 0),
      status: ['queued', 'dead'].includes(o0.status) ? o0.status : 'queued',
      lastError: o0.lastError ? String(o0.lastError).slice(0, 500) : null,
      nextAttemptAt: Number.isFinite(o0.nextAttemptAt) ? o0.nextAttemptAt : null,
    });
  }
  return out.sort(compareOutbox);
}

/* ============================== 跨窗口合流 ============================== */

export function mergeRules(serverList, clientList) {
  const byId = new Map();
  const order = [];
  for (const r of [...(Array.isArray(serverList) ? serverList : []), ...(Array.isArray(clientList) ? clientList : [])]) {
    if (!r || typeof r.id !== 'string') continue;
    const ex = byId.get(r.id);
    if (!ex) { byId.set(r.id, r); order.push(r.id); continue; }
    // rev 更大者整体胜出；删除墓碑按 deleteRev 比较，绝不被旧副本复活
    const clientRev = Math.max(r.rev || 0, r.deleteRev || 0);
    const serverRev = Math.max(ex.rev || 0, ex.deleteRev || 0);
    byId.set(r.id, clientRev > serverRev ? r : ex);
  }
  return order.map((id) => byId.get(id)).sort((a, b) => (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : 1));
}

export function mergeNotifyEvents(serverList, clientList) {
  const byId = new Map();
  for (const e of [...(Array.isArray(serverList) ? serverList : []), ...(Array.isArray(clientList) ? clientList : [])]) {
    if (e && typeof e.id === 'string') byId.set(e.id, e); // append-only 并集
  }
  return [...byId.values()].sort(compareEvents);
}

export function mergeNotifications(serverList, clientList) {
  const byId = new Map();
  for (const n of [...(Array.isArray(serverList) ? serverList : []), ...(Array.isArray(clientList) ? clientList : [])]) {
    if (!n || typeof n.id !== 'string') continue;
    const ex = byId.get(n.id);
    if (!ex) { byId.set(n.id, n); continue; }
    // 走得更远的状态胜出；历史按 (at,action,detail) 并集
    const win = itemRank(n) > itemRank(ex) ? n : ex;
    const hist = new Map();
    for (const h of [...(ex.history || []), ...(n.history || [])]) {
      hist.set(`${h.at}|${h.action}|${h.detail || ''}`, h);
    }
    const merged = { ...ex, ...win, attempts: Math.max(ex.attempts || 0, n.attempts || 0) };
    merged.history = [...hist.values()].sort((a, b) => (a.at - b.at) || (a.action < b.action ? -1 : 1));
    byId.set(n.id, merged);
  }
  return [...byId.values()].sort(compareItems);
}

function itemRank(it) {
  return { scheduled: 0, deferred: 1, cancelled: 1, pending: 2, snoozed: 2, failed: 2, sent: 3, delivered: 4, transferred: 5, acknowledged: 6 }[it.status] ?? 0;
}

export function mergeOutbox(serverList, clientList, tombstones = null) {
  // tombstones：客户端已终结（送达/确认/转交/陈旧清理）的 outbox 条目 id，
  // 即使服务端旧副本仍持有也必须删除（与 server.py _merge_outbox 同构）。
  const dead = new Set(Array.isArray(tombstones) ? tombstones : []);
  const byNotify = new Map();
  for (const o of [...(Array.isArray(serverList) ? serverList : []), ...(Array.isArray(clientList) ? clientList : [])]) {
    if (!o || typeof o.notifyId !== 'string') continue;
    if (dead.has(o.id)) { byNotify.delete(o.notifyId); continue; }
    const ex = byNotify.get(o.notifyId);
    if (!ex) { byNotify.set(o.notifyId, o); continue; }
    byNotify.set(o.notifyId, {
      ...ex, ...o,
      attempts: Math.max(ex.attempts || 0, o.attempts || 0),
      seq: Math.min(Number.isFinite(ex.seq) ? ex.seq : 0, Number.isFinite(o.seq) ? o.seq : Infinity),
      enqueuedAt: Math.min(ex.enqueuedAt || 0, o.enqueuedAt || 0),
      nextAttemptAt: minPresent(ex.nextAttemptAt, o.nextAttemptAt),
    });
  }
  return [...byNotify.values()].sort(compareOutbox);
}

function minPresent(a, b) {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return Math.min(a, b);
}

/* ============================== 服务端乐观并发（与 server.py 同构） ============================== */

/**
 * 评估通知中心的乐观并发冲突。client 携带 baseNotifyRuleRevs / baseNotifyItemRevs：
 *  - 规则被另一窗口前进 / 删除 → notify-rule-advanced；
 *  - 通知项被另一窗口处理（确认 / 稍后 / 转交）→ notify-item-advanced；
 *  - 通知项 / 规则引用了服务端不存在的会话 → notify-session-missing；
 *  - 追加的通知事件引用不存在的会话 → notify-event-orphan。
 * serverDoc / clientDoc 为文档（含 reviewSessions / notify* 字段）。
 */
export function assessServerNotifyConflict(serverDoc, clientDoc) {
  const baseRuleRevs = clientDoc?.baseNotifyRuleRevs;
  const baseItemRevs = clientDoc?.baseNotifyItemRevs;
  if (!baseRuleRevs && !baseItemRevs) return null;
  const serverSessions = new Set((serverDoc?.reviewSessions || []).map((s) => s.id));
  // 有效会话 = 服务端已有会话 ∪ 本次提交自带的新会话（同一次保存里新建会话与其
  // 通知事件 / 规则原子出现，不能误判为孤儿引用，与 server.py 同构）。
  const effectiveSessions = new Set(serverSessions);
  for (const s of clientDoc?.reviewSessions || []) if (s?.id) effectiveSessions.add(s.id);
  const serverRules = new Map((serverDoc?.notifyRules || []).map((r) => [r.id, r]));
  const serverItems = new Map((serverDoc?.notifications || []).map((n) => [n.id, n]));

  // 规则级冲突
  for (const r of clientDoc?.notifyRules || []) {
    if (!r?.id) continue;
    if (!effectiveSessions.has(r.sessionId)) return { reason: 'notify-session-missing', ruleId: r.id, sessionId: r.sessionId };
    const base = (baseRuleRevs || {})[r.id];
    if (!Number.isInteger(base)) continue;
    const srv = serverRules.get(r.id);
    const clientRev = Math.max(r.rev || 0, r.deleteRev || 0);
    if (clientRev <= base) continue;
    const srvRev = srv ? Math.max(srv.rev || 0, srv.deleteRev || 0) : 0;
    if (srvRev !== base) {
      return { reason: 'notify-rule-advanced', ruleId: r.id, serverRev: srvRev, rule: srv || null };
    }
  }

  // 通知项级冲突（用客户端项相对服务端项的状态变化检测；base 是上次同步时的状态）
  for (const n of clientDoc?.notifications || []) {
    if (!n?.id) continue;
    const baseState = (baseItemRevs || {})[n.id];
    if (!baseState) continue;
    const srv = serverItems.get(n.id);
    if (!srv) {
      // 全新项本地没有 base 才对；带了 base 却找不到 → 服务端已清理（不允许伪造）
      if (baseState !== 'absent') return { reason: 'notify-item-missing', notifyId: n.id };
      continue;
    }
    if (srv.status !== baseState.status || (srv.ackedAt || null) !== (baseState.ackedAt || null)) {
      return { reason: 'notify-item-advanced', notifyId: n.id, serverStatus: srv.status, item: srv };
    }
  }

  // 追加事件的孤儿引用（事件 append-only，只校验会话存在，含本次提交自带的新会话）
  const serverEvents = new Set((serverDoc?.notifyEvents || []).map((e) => e.id));
  for (const e of clientDoc?.notifyEvents || []) {
    if (!e?.id || serverEvents.has(e.id)) continue;
    if (!effectiveSessions.has(e.sessionId)) return { reason: 'notify-event-orphan', eventId: e.id, sessionId: e.sessionId };
  }
  return null;
}

/* ============================== 时间线报告 ============================== */

/**
 * 按会话构建完整通知时间线报告：规则与修订（含工作时段 / 静音窗口）、每个事件派生出的
 * 通知项（含延迟原因 / 可发送时刻）、队列 / 重试 / 失败原因、确认记录、最终送达结果、
 * 批量处理结果（成功 / 冲突 / 草稿）。键名稳定、可附校验和导出。
 */
export function buildNotifyReport(sessionId, { rules, events, items, outbox, sessions = [], batches = [], drafts = [], generatedAt = null } = {}) {
  const session = (Array.isArray(sessions) ? sessions : []).find((s) => s.id === sessionId) || null;
  const sr = (Array.isArray(rules) ? rules : []).filter((r) => r.sessionId === sessionId);
  const ev = (Array.isArray(events) ? events : []).filter((e) => e.sessionId === sessionId).sort(compareEvents);
  const obById = new Map((Array.isArray(outbox) ? outbox : []).map((o) => [o.notifyId, o]));
  const itemsByEvent = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    if (it.sessionId !== sessionId) continue;
    const arr = itemsByEvent.get(it.eventId) || [];
    arr.push(it);
    itemsByEvent.set(it.eventId, arr);
  }

  const ruleReports = sr.map((r) => ({
    id: r.id, name: r.name, enabled: r.enabled, deleted: r.deleted, rev: r.rev,
    triggers: { ...r.triggers },
    createdAt: r.createdAt, updatedAt: r.updatedAt, revisedAt: r.revisedAt, createdBy: r.createdBy,
    levels: (r.levels || []).map((l) => ({ level: l.level, delayMin: l.delayMin, recipients: [...l.recipients] })),
    schedule: r.schedule ? {
      workHours: (r.schedule.workHours || []).map((x) => ({ ...x })),
      quietWeekly: (r.schedule.quietWeekly || []).map((x) => ({ ...x })),
      quietWindows: (r.schedule.quietWindows || []).map((x) => ({ ...x })),
    } : { workHours: [], quietWeekly: [], quietWindows: [] },
  }));

  const timeline = ev.map((e) => ({
    eventId: e.id, type: e.type, typeLabel: EVENT_LABEL[e.type] || e.type,
    nodeKey: e.nodeKey, title: e.title, at: e.at, isoTime: e.at ? new Date(e.at).toISOString() : null,
    actor: e.actor, decision: e.decision || null, reason: e.reason || '',
    codes: e.codes || [], invalid: e.invalid || false,
    notifications: (itemsByEvent.get(e.id) || []).slice().sort(compareItems).map((it) => {
      const ob = obById.get(it.id);
      return {
        id: it.id, ruleId: it.ruleId, ruleRev: it.ruleRev, level: it.level,
        recipient: it.recipient, status: it.status, summary: it.summary,
        dueAt: it.dueAt, readyAt: it.readyAt ?? it.dueAt, sentAt: it.sentAt, deliveredAt: it.deliveredAt,
        ackedAt: it.ackedAt, ackedBy: it.ackedBy, snoozeUntil: it.snoozeUntil,
        deferred: it.status === 'deferred' || (it.readyAt ?? it.dueAt) > it.dueAt,
        transferredTo: it.transferredTo || null, transferOf: it.transferOf || null,
        attempts: it.attempts, lastError: it.lastError,
        queued: !!ob, queueAttempts: ob?.attempts ?? 0, nextAttemptAt: ob?.nextAttemptAt ?? null,
        history: it.history || [],
      };
    }),
  }));

  const flatItems = timeline.flatMap((t) => t.notifications);
  const delivery = {
    total: flatItems.length,
    delivered: flatItems.filter((n) => n.status === 'delivered' || n.status === 'sent').length,
    acknowledged: flatItems.filter((n) => n.status === 'acknowledged').length,
    pending: flatItems.filter((n) => ['pending', 'scheduled', 'snoozed'].includes(n.status)).length,
    deferred: flatItems.filter((n) => n.status === 'deferred').length,
    transferred: flatItems.filter((n) => n.status === 'transferred').length,
    cancelled: flatItems.filter((n) => n.status === 'cancelled').length,
    failed: flatItems.filter((n) => n.status === 'failed').length,
    queued: flatItems.filter((n) => n.queued).length,
    failures: flatItems.filter((n) => n.lastError).map((n) => ({
      notificationId: n.id, recipient: n.recipient, eventId: n.eventId,
      attempts: n.attempts, error: n.lastError, queueNextAttemptAt: n.nextAttemptAt,
    })),
  };

  // 批量处理结果（该会话）；失败项同时给出是否仍有本地草稿
  const draftIds = new Set((Array.isArray(drafts) ? drafts : []).map((d) => d.notifyId));
  const batchReports = (Array.isArray(batches) ? batches : [])
    .filter((b) => (b.sessionId || null) === sessionId)
    .map((b) => ({
      id: b.id, action: b.action, by: b.by, at: b.at, isoTime: b.at ? new Date(b.at).toISOString() : null,
      requested: b.requested, success: b.success, failed: b.failed, payload: { ...(b.payload || {}) },
      results: (b.results || []).map((r) => ({ ...r, draftKept: !r.ok && draftIds.has(r.id) })),
    }));

  return {
    format: 'rect-constraints/notify-report',
    formatVersion: 2,
    generatedAt: generatedAt || new Date().toISOString(),
    session: session ? { id: session.id, name: session.name, status: session.status, completedAt: session.completedAt, rev: session.rev } : { id: sessionId },
    rules: ruleReports,
    eventCount: timeline.length,
    timeline,
    batches: batchReports,
    batchCount: batchReports.length,
    delivery,
  };
}
