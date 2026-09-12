/*
 * Store：文档状态 + 撤销/重做 + 布局版本 + 持久化
 *
 * 关键约定：
 * - 历史里每条 entry = { model, report, hash }。report（每个约束成败、冲突链、
 *   位置指纹）一并入栈，undo/redo 恢复“同一组位置、约束和冲突结果”，而不是事后重算
 *   可能漂移的结果。
 * - 只有 model 是真相来源；report 是它的纯函数缓存（solver 确定性保证两者永远一致），
 *   同时缓存让刷新后的冲突高亮与提交时逐字节相同。
 * - 拖动中只更新视图不入栈；pointerup 提交一次历史。
 * - 任何修改前先过 validate + findCycle，环一律拒绝（由 UI 定位高亮）。
 *
 * 布局版本：
 * - versions[] 是带名称的只读快照（矩形 + 约束 + 求解结果 + 冲突报告），
 *   恢复版本 = 把快照提交为新的当前编辑版本（新历史条目），原版本不被改写。
 * - currentVersionId 指向最近保存/恢复到的版本；当前版本与已发布版本不能删除。
 * - compare = {a, b} 记录比较选择，随文档持久化，刷新后比较结果一致。
 *
 * 乐观并发：
 * - 服务端文档带单调递增 rev；保存时携带 baseRev，不一致 -> 409。
 * - 本页有未保存修改时收到 409：置 saveConflict，停止一切写入（绝不覆盖
 *   其他页面已保存的内容），由 UI 提示“版本冲突，请重新加载”。
 * - 本页没有未保存修改时收到 409：静默重新加载，跟随服务器最新内容。
 */

import { solve, findCycle, fingerprint } from './solver.js';
import { validate, normalize, seedModel, uid } from './model.js';
import { snapshotVersion, compareVersions } from './versions.js';

const LIMIT = 100;
const LS_KEY = 'rect-constraints-doc-v1';

export class Store extends EventTarget {
  constructor({ base = '' } = {}) {
    super();
    this.base = base; // 浏览器内为 ''（同源相对路径）
    this.entries = [];
    this.idx = -1;
    this.dragPreview = null; // 拖动中的临时解（不入历史）

    this.rev = 0;                 // 服务端文档版本号（乐观并发）
    this.versions = [];           // 布局版本（只读快照）
    this.currentVersionId = null; // 最近保存/恢复到的版本
    this.compare = { a: null, b: null }; // 版本比较选择（持久化）
    this.saveConflict = false;    // 409 后锁定：不再写任何存储
    this._dirty = false;          // 自上次加载以来是否有未保存的本地修改
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
      try { doc = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch { doc = null; }
    }
    if (!doc || !doc.entries || !doc.entries.length) {
      doc = { entries: [], idx: -1 };
    }
    this.entries = doc.entries;
    this.idx = Math.min(doc.idx ?? this.entries.length - 1, this.entries.length - 1);
    this.rev = Number.isFinite(doc.rev) ? doc.rev : 0;
    this.versions = sanitizeVersions(doc.versions);
    this.currentVersionId = this.versions.some((v) => v.id === doc.currentVersionId)
      ? doc.currentVersionId : null;
    const cmp = doc.compare || {};
    this.compare = {
      a: this.versions.some((v) => v.id === cmp.a) ? cmp.a : null,
      b: this.versions.some((v) => v.id === cmp.b) ? cmp.b : null,
    };
    this.saveConflict = false;

    let seeded = false;
    if (!this.entries.length) { this.resetToSeed({ persist: false }); seeded = true; }
    const beforeHash = this.current?.hash;
    this._recomputeCurrent(); // 防御性重算：旧数据/损坏数据也收敛到确定结果
    this._dirty = false;
    // 只有内容真的变化（或首次播种）才回写，避免多页面同时打开时无谓的版本号竞争
    if (seeded || this.current.hash !== beforeHash) await this.persist();
    this._emit('load');
  }

  resetToSeed({ persist = true } = {}) {
    const model = seedModel();
    this.entries = [this._entry(model)];
    this.idx = 0;
    this._dirty = true;
    if (persist) this.persist();
  }

  async _fetchDoc() {
    const res = await fetch(this.base + '/api/doc');
    if (!res.ok) throw new Error(`GET /api/doc ${res.status}`);
    const data = await res.json();
    return data && data.entries ? data : null;
  }

  _payload() {
    return {
      entries: this.entries,
      idx: this.idx,
      versions: this.versions,
      currentVersionId: this.currentVersionId,
      compare: this.compare,
    };
  }

  _saveTimer = null;
  _saveChain = Promise.resolve();
  _saveVersion = 0;
  persist() {
    if (this.saveConflict) return; // 冲突未解决：不再写任何存储，防止覆盖他人内容
    const payload = this._payload();
    try {
      // localStorage 是同源多页面共享的：写入前检查，别人存过更新的 rev 就不覆盖
      const prev = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      if (prev && Number.isFinite(prev.rev) && prev.rev > this.rev) {
        this._onSaveConflict(prev.rev);
        return;
      }
      localStorage.setItem(LS_KEY, JSON.stringify({ ...payload, rev: this.rev }));
    } catch {}
    this._emit('persist');
    // 每次变更生成新版本号；120ms 合并连续修改，最终以最新版本 PUT。
    // 串行链保证请求顺序：旧快照绝不可能覆盖新快照（避免竞态静默回滚）。
    ++this._saveVersion;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._sendLatest(), 120);
  }
  _sendLatest() {
    if (this.saveConflict) return this._saveChain;
    const v = this._saveVersion;
    const snapshot = JSON.stringify({ ...this._payload(), baseRev: this.rev });
    this._saveChain = this._saveChain.then(async () => {
      if (v !== this._saveVersion || this.saveConflict) return; // 已被更新的版本取代
      try {
        const res = await fetch(this.base + '/api/doc', {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: snapshot,
        });
        if (res.status === 409) {
          // 旧页面提交：服务端版本号已前进，拒绝覆盖
          const data = await res.json().catch(() => ({}));
          this._onSaveConflict(Number.isFinite(data?.rev) ? data.rev : null);
          return;
        }
        if (!res.ok) { console.warn('保存失败', res.status); this._emit('saveerror', { status: res.status }); return; }
        const data = await res.json().catch(() => ({}));
        if (Number.isFinite(data?.rev)) this.rev = data.rev;
        this._emit('saved', { rev: this.rev });
      } catch (e) {
        console.warn('保存失败（已写入 localStorage）:', e.message);
        this._emit('saveerror', {});
      }
    });
    return this._saveChain;
  }

  _onSaveConflict(serverRev) {
    if (this.saveConflict) return;
    if (!this._dirty) {
      // 本地没有未保存的修改：静默跟随服务器最新内容，不打断用户
      this.load().catch(() => {});
      return;
    }
    this.saveConflict = true;
    clearTimeout(this._saveTimer);
    this._emit('saveconflict', { rev: serverRev });
    // 用服务器权威内容刷新本地缓存，避免 localStorage 残留未保存的本地修改
    this._fetchDoc().then((doc) => {
      if (doc) try { localStorage.setItem(LS_KEY, JSON.stringify(doc)); } catch {}
    }).catch(() => {});
  }

  /** 测试/卸载时立即落盘并等待服务端确认 */
  async flushed() {
    clearTimeout(this._saveTimer);
    await this._sendLatest();
  }

  /* ---------- 条目 ---------- */

  _entry(model) {
    const m = normalize(model);
    const report = solve(m, null);
    return { model: m, report, hash: report.hash };
  }

  _recomputeCurrent() {
    // 用规范化后的 model 重新求解，并把求解后的确定位置回写到模型（idempotent fixpoint）
    const e = this.entries[this.idx];
    if (!e) return;
    const m = normalize(e.model);
    const rep = solve(m, null);
    for (const r of m.rects) {
      const p = rep.rects[r.id];
      if (p) { r.x = p.x; r.y = p.y; r.w = p.w; r.h = p.h; }
    }
    e.model = m;
    e.report = rep;
    e.hash = rep.hash;
  }

  get current() { return this.entries[this.idx]; }
  get model() { return this.current.model; }
  get report() { return this.dragPreview || this.current.report; }

  /* ---------- 修改 ---------- */

  /**
   * 提交一次修改。mutator(modelDraft) 直接改草稿。
   * 返回 {ok, errors, cycle}；环 / 结构错误一律拒绝，不产生历史。
   */
  commit(mutator, { label = '' } = {}) {
    const draft = structuredClone(this.current.model);
    mutator(draft);

    const { errors } = validate(draft);
    if (errors.length) { this._emit('reject', { errors, cycle: null, label }); return { ok: false, errors, cycle: null }; }

    const cycle = findCycle(draft.constraints);
    if (cycle) {
      this._emit('reject', { errors: [], cycle, label });
      return { ok: false, errors: [], cycle };
    }

    const norm = normalize(draft);
    const report = solve(norm, null);
    // 求解后把确定位置固化进模型（刷新后从同一不动点继续）
    for (const r of norm.rects) {
      const p = report.rects[r.id];
      if (p) { r.x = p.x; r.y = p.y; r.w = p.w; r.h = p.h; }
    }

    this.entries = this.entries.slice(0, this.idx + 1);
    this.entries.push({ model: norm, report, hash: report.hash, label, t: Date.now() });
    if (this.entries.length > LIMIT) this.entries.shift();
    this.idx = this.entries.length - 1;
    this._dirty = true;
    this.persist();
    this._emit('change', { label, conflicts: report.conflicts });
    return { ok: true, errors: [], cycle: null, report };
  }

  undo() {
    if (!this.canUndo) return;
    this.idx--;
    this.dragPreview = null;
    this._dirty = true;
    this.persist();
    this._emit('change', { label: 'undo' });
  }
  redo() {
    if (!this.canRedo) return;
    this.idx++;
    this.dragPreview = null;
    this._dirty = true;
    this.persist();
    this._emit('change', { label: 'redo' });
  }
  get canUndo() { return this.idx > 0; }
  get canRedo() { return this.idx < this.entries.length - 1; }

  /* ---------- 布局版本（只读快照） ---------- */

  get currentVersion() { return this.versions.find((v) => v.id === this.currentVersionId) || null; }

  /** 把当前矩形/约束/求解结果/冲突报告保存成带名称的只读版本。 */
  saveVersion(name) {
    name = String(name ?? '').trim();
    if (!name) return { ok: false, error: '版本名称不能为空' };
    if (this.versions.some((v) => v.name === name)) return { ok: false, error: `已存在同名版本「${name}」` };
    const v = snapshotVersion(uid('v'), name, this.current);
    this.versions.push(v);
    this.currentVersionId = v.id;
    this._dirty = true;
    this.persist();
    this._emit('versions', { type: 'save', id: v.id });
    return { ok: true, version: v };
  }

  /** 恢复版本：快照内容提交为新的当前编辑版本（可撤销），原版本保持只读。 */
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

  /** 删除版本。当前版本与已发布版本受保护，拒绝删除。 */
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

  /** 标记/取消发布。已发布版本不能删除。 */
  setPublished(id, flag) {
    const v = this.versions.find((x) => x.id === id);
    if (!v) return { ok: false, error: '版本不存在' };
    v.published = !!flag;
    this._dirty = true;
    this.persist();
    this._emit('versions', { type: 'publish', id });
    return { ok: true };
  }

  /** 记录比较选择（随文档持久化，刷新后比较结果保持一致）。 */
  setCompare(a, b) {
    this.compare = { a: a || null, b: b || null };
    this._dirty = true;
    this.persist();
    this._emit('versions', { type: 'compare' });
  }

  /** 按 id 比较两个版本；任一不存在返回 null。 */
  compareById(aId, bId) {
    const a = this.versions.find((v) => v.id === aId);
    const b = this.versions.find((v) => v.id === bId);
    if (!a || !b) return null;
    return compareVersions(a, b);
  }

  /* ---------- 拖动（临时解 + 提交） ---------- */

  /** 拖动实时预览；pinned {id:{x,y}}, group [ids]。返回 report。 */
  previewDrag(pinned, group) {
    const rep = solve(this.current.model, { pinned, group });
    this.dragPreview = rep;
    this._emit('drag');
    return rep;
  }
  endDrag() {
    // 用最后一帧的确定结果作为落位，再走一次无拖动求解取不动点并提交历史
    const rep = this.dragPreview;
    this.dragPreview = null;
    if (!rep) return;
    this.commit((m) => {
      for (const r of m.rects) {
        const p = rep.rects[r.id];
        if (p) { r.x = p.x; r.y = p.y; r.w = p.w; r.h = p.h; }
      }
    }, { label: '拖动' });
  }
  cancelDrag() { this.dragPreview = null; this._emit('drag'); }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
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
