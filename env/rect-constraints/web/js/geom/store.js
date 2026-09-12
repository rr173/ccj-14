/*
 * Store：文档状态 + 撤销/重做 + 持久化
 *
 * 关键约定：
 * - 历史里每条 entry = { model, report, hash }。report（每个约束成败、冲突链、
 *   位置指纹）一并入栈，undo/redo 恢复“同一组位置、约束和冲突结果”，而不是事后重算
 *   可能漂移的结果。
 * - 只有 model 是真相来源；report 是它的纯函数缓存（solver 确定性保证两者永远一致），
 *   同时缓存让刷新后的冲突高亮与提交时逐字节相同。
 * - 拖动中只更新视图不入栈；pointerup 提交一次历史。
 * - 任何修改前先过 validate + findCycle，环一律拒绝（由 UI 定位高亮）。
 */

import { solve, findCycle, fingerprint } from './solver.js';
import { validate, normalize, seedModel } from './model.js';

const LIMIT = 100;
const LS_KEY = 'rect-constraints-doc-v1';

export class Store extends EventTarget {
  constructor({ base = '' } = {}) {
    super();
    this.base = base; // 浏览器内为 ''（同源相对路径）
    this.entries = [];
    this.idx = -1;
    this.dragPreview = null; // 拖动中的临时解（不入历史）
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
    if (!this.entries.length) this.resetToSeed({ persist: false });
    this._recomputeCurrent(); // 防御性重算：旧数据/损坏数据也收敛到确定结果
    await this.persist();
    this._emit('load');
  }

  resetToSeed({ persist = true } = {}) {
    const model = seedModel();
    this.entries = [this._entry(model)];
    this.idx = 0;
    if (persist) this.persist();
  }

  async _fetchDoc() {
    const res = await fetch(this.base + '/api/doc');
    if (!res.ok) throw new Error(`GET /api/doc ${res.status}`);
    const data = await res.json();
    return data && data.entries ? data : null;
  }

  _saveTimer = null;
  _saveChain = Promise.resolve();
  _saveVersion = 0;
  persist() {
    const payload = { entries: this.entries, idx: this.idx };
    try { localStorage.setItem(LS_KEY, JSON.stringify(payload)); } catch {}
    // 每次变更生成新版本号；120ms 合并连续修改，最终以最新版本 PUT。
    // 串行链保证请求顺序：旧快照绝不可能覆盖新快照（避免竞态静默回滚）。
    ++this._saveVersion;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._sendLatest(), 120);
  }
  _sendLatest() {
    const v = this._saveVersion;
    const snapshot = JSON.stringify({ entries: this.entries, idx: this.idx });
    this._saveChain = this._saveChain.then(async () => {
      if (v !== this._saveVersion) return; // 已被更新的版本取代
      try {
        const res = await fetch(this.base + '/api/doc', {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: snapshot,
        });
        if (!res.ok) console.warn('保存失败', res.status);
      } catch (e) { console.warn('保存失败（已写入 localStorage）:', e.message); }
    });
    return this._saveChain;
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
    this.persist();
    this._emit('change', { label, conflicts: report.conflicts });
    return { ok: true, errors: [], cycle: null, report };
  }

  undo() {
    if (!this.canUndo) return;
    this.idx--;
    this.dragPreview = null;
    this.persist();
    this._emit('change', { label: 'undo' });
  }
  redo() {
    if (!this.canRedo) return;
    this.idx++;
    this.dragPreview = null;
    this.persist();
    this._emit('change', { label: 'redo' });
  }
  get canUndo() { return this.idx > 0; }
  get canRedo() { return this.idx < this.entries.length - 1; }

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
