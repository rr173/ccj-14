/*
 * 布局版本：只读快照 + 版本间差异比较（纯函数，无 DOM 依赖）。
 *
 * 版本对象 = { id, name, createdAt, published, model, report, hash }
 * - model：规范化后的画布 + 矩形 + 约束（保存时的确定不动点位置）
 * - report：保存时的求解结果（每矩形位置 / 每约束成败 / 冲突链 / 指纹）
 *
 * 版本一旦创建即只读：恢复 = 把快照内容提交为“新的当前编辑版本”，
 * 原版本对象永远不被改写；比较是两个版本对象的纯函数，结果确定。
 */

import { constraintLabel } from './solver.js';

/** 从历史条目 {model, report, hash} 生成只读版本快照（深拷贝，之后互不影响）。 */
export function snapshotVersion(id, name, entry, createdAt = Date.now()) {
  return {
    id,
    name,
    createdAt,
    published: false,
    model: structuredClone(entry.model),
    report: structuredClone(entry.report),
    hash: entry.hash,
  };
}

const rectMapOf = (v) => new Map((v.model?.rects || []).map((r) => [r.id, r]));

/** 求解结果里的确定位置；旧数据缺 report 时回退到模型坐标。 */
const posOf = (v, id) =>
  v.report?.rects?.[id] || (v.model?.rects || []).find((r) => r.id === id) || null;

const byId = (x, y) => {
  const a = x.id ?? x.cid, b = y.id ?? y.cid;
  return a < b ? -1 : a > b ? 1 : 0;
};

/**
 * 比较两个版本（a = 基准，b = 对比），输出确定性的差异报告：
 * - rects：矩形 新增/删除/移动/尺寸变化（位置取求解结果）
 * - constraints：约束 新增/删除/同 id 内容修改
 * - conflicts：未满足数量变化 + 新增未满足 / 已解决 的约束清单
 */
export function compareVersions(a, b) {
  const rectsA = rectMapOf(a);
  const rectsB = rectMapOf(b);

  const added = [], removed = [], moved = [], resized = [];
  for (const [id, rB] of rectsB) {
    const rA = rectsA.get(id);
    if (!rA) { added.push({ id, name: rB.name || id }); continue; }
    const pA = posOf(a, id), pB = posOf(b, id);
    if (!pA || !pB) continue;
    const name = rB.name || rA.name || id;
    if (pA.x !== pB.x || pA.y !== pB.y) {
      moved.push({ id, name, from: { x: pA.x, y: pA.y }, to: { x: pB.x, y: pB.y } });
    }
    if (pA.w !== pB.w || pA.h !== pB.h) {
      resized.push({ id, name, from: { w: pA.w, h: pA.h }, to: { w: pB.w, h: pB.h } });
    }
  }
  for (const [id, rA] of rectsA) {
    if (!rectsB.has(id)) removed.push({ id, name: rA.name || id });
  }

  const consA = new Map((a.model?.constraints || []).map((c) => [c.id, c]));
  const consB = new Map((b.model?.constraints || []).map((c) => [c.id, c]));
  const cAdded = [], cRemoved = [], cChanged = [];
  for (const [id, cB] of consB) {
    if (!consA.has(id)) cAdded.push({ id, kind: cB.kind, label: constraintLabel(cB, rectsB) });
  }
  for (const [id, cA] of consA) {
    const cB = consB.get(id);
    if (!cB) { cRemoved.push({ id, kind: cA.kind, label: constraintLabel(cA, rectsA) }); continue; }
    const fields = diffFields(cA, cB);
    if (fields.length) cChanged.push({ id, kind: cB.kind, label: constraintLabel(cB, rectsB), fields });
  }

  const unmetA = new Map((a.report?.conflicts || []).map((c) => [c.cid, c]));
  const unmetB = new Map((b.report?.conflicts || []).map((c) => [c.cid, c]));
  const newUnmet = [...unmetB].filter(([cid]) => !unmetA.has(cid))
    .map(([cid, c]) => ({ cid, label: c.label }));
  const resolved = [...unmetA].filter(([cid]) => !unmetB.has(cid))
    .map(([cid, c]) => ({ cid, label: c.label }));

  // 全部按 id 排序：同样的两个版本永远得到逐字节相同的比较结果
  [added, removed, moved, resized, cAdded, cRemoved, cChanged, newUnmet, resolved]
    .forEach((xs) => xs.sort(byId));

  const identical = ![added, removed, moved, resized, cAdded, cRemoved, cChanged, newUnmet, resolved]
    .some((xs) => xs.length);

  return {
    rects: { added, removed, moved, resized },
    constraints: { added: cAdded, removed: cRemoved, changed: cChanged },
    conflicts: { before: unmetA.size, after: unmetB.size, newUnmet, resolved },
    hashBefore: a.hash || a.report?.hash || '',
    hashAfter: b.hash || b.report?.hash || '',
    identical,
  };
}

/** 同 id 约束的字段级差异（优先级/启停/参数等），按键名排序保证确定。 */
function diffFields(a, b) {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const out = [];
  for (const k of keys) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push({ field: k, from: a[k], to: b[k] });
  }
  return out;
}
