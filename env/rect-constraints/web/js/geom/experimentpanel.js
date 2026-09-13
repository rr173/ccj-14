/*
 * 布局方案实验面板：
 * - 从当前编辑分支（head / 回放事件）建立实验：编辑器内逐变体定义
 *   矩形位置/尺寸覆盖、约束启停与优先级覆盖（留空 = 沿用基准）；
 * - 实验状态行：排队 / 运行 / 完成 / 失败 / 取消，支持暂停、继续、取消（变体之间响应）；
 * - 每个完成变体保存完整模型/求解结果/冲突链/指纹，可展开“与基准的差异”
 *   （矩形 / 约束 / 冲突，复用 diffHtml），并可另存为新的编辑分支（保留实验来源）；
 * - 损坏变体明确标红“无法回放”，其余变体继续查看 / 另存；
 * - 相同配置重复提交幂等（返回已存在实验），完成结果绝不被后续运行覆盖。
 */

import { diffHtml } from './diff.js';
import { variantCounters } from './experiments.js';

const RUN_LABEL = { queued: '排队中', running: '运行中', paused: '已暂停', done: '已完成', cancelled: '已取消' };
const V_LABEL = { queued: '排队', running: '运行中', done: '完成', failed: '失败', cancelled: '已取消' };

export class ExperimentPanel {
  constructor(store, hooks) {
    this.store = store;
    this.hooks = hooks; // { toast }
    this.$count = document.querySelector('#exp-count');
    this.$list = document.querySelector('#experiment-list');
    this.$warnings = document.querySelector('#exp-warnings');
    this.$btnNew = document.querySelector('#btn-new-experiment');
    this.$dlg = document.querySelector('#exp-dlg');
    this.$dlgBody = document.querySelector('#exp-dlg-body');
    this.$dlgError = document.querySelector('#exp-dlg-error');
    this.expanded = new Set();   // 展开差异的变体 key: expId/variantId
    this.editor = null;

    this.$btnNew.onclick = () => this.openEditor();
    document.querySelector('#exp-dlg-close').onclick = () => this.closeEditor();
    document.querySelector('#exp-dlg-cancel').onclick = () => this.closeEditor();
    document.querySelector('#exp-dlg-ok').onclick = () => this.submit();

    store.addEventListener('experiments', () => this.render());
  }

  openEditor() {
    const s = this.store;
    const srcId = s.replayEventId || s.branch.headEventId;
    const event = s.eventsById.get(srcId);
    if (!event || event.corrupt) { this.hooks.toast('当前分支事件不可用，无法建立实验', 'error'); return; }
    if (s.saveConflict) { this.hooks.toast('版本冲突未解决，请先重新加载', 'error'); return; }
    const srcBranch = s.branches.find((b) => b.id === (s.replayEventId ? event.branch : s.currentBranchId));
    this.editor = {
      name: '',
      specs: [this._blankSpec()],
      source: {
        eventId: event.id,
        branchName: srcBranch?.name || event.branch,
        seq: event.seq,
        hash: event.hash,
      },
    };
    this.$dlgError.textContent = '';
    this.$dlg.classList.remove('hidden');
    this._renderEditor();
  }

  closeEditor() { this.$dlg.classList.add('hidden'); this.editor = null; }

  _blankSpec() {
    return { name: '', rects: [{ id: '', x: '', y: '', w: '', h: '' }], constraints: [{ id: '', enabled: '', priority: '' }] };
  }

  /* ---------------- 变体编辑器 ---------------- */

  _renderEditor() {
    const e = this.editor;
    const model = this._sourceModel();
    const rectOpts = (sel) => `<option value="">（不修改矩形）</option>` +
      model.rects.map((r) => `<option value="${r.id}" ${r.id === sel ? 'selected' : ''}>${escapeHtml(r.name || r.id.slice(-5))}</option>`).join('');
    const consOpts = (sel) => `<option value="">（不修改约束）</option>` +
      model.constraints.map((c) => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${escapeHtml((c.id))} · ${escapeHtml(this._consBrief(c))}</option>`).join('');

    const rows = e.specs.map((sp, i) => `
      <div class="xe-spec" data-i="${i}">
        <div class="xe-spec-head">
          <b>变体 ${i + 1}</b>
          <input class="xe-name" type="text" placeholder="变体名称（可留空）" maxlength="30" value="${escapeHtml(sp.name)}" />
          <button class="mini danger" data-act="del-spec" ${e.specs.length <= 1 ? 'disabled' : ''}>删除变体</button>
        </div>
        ${sp.rects.map((rr, j) => `
          <div class="xe-line">
            <span class="xe-line-tag">矩形</span>
            <select data-k="rect" data-j="${j}">${rectOpts(rr.id)}</select>
            <input class="xe-num" type="number" placeholder="X" data-k="rx" data-j="${j}" value="${rr.x}" />
            <input class="xe-num" type="number" placeholder="Y" data-k="ry" data-j="${j}" value="${rr.y}" />
            <input class="xe-num" type="number" placeholder="宽" data-k="rw" data-j="${j}" value="${rr.w}" />
            <input class="xe-num" type="number" placeholder="高" data-k="rh" data-j="${j}" value="${rr.h}" />
            <button class="mini" data-act="del-rect" data-j="${j}" ${sp.rects.length <= 1 ? 'disabled' : ''}>×</button>
          </div>`).join('')}
        <button class="mini xe-add" data-act="add-rect">＋ 矩形位置/尺寸覆盖</button>
        ${sp.constraints.map((cc, j) => `
          <div class="xe-line">
            <span class="xe-line-tag">约束</span>
            <select data-k="cons" data-j="${j}">${consOpts(cc.id)}</select>
            <select data-k="cen" data-j="${j}">
              <option value="">启停不变</option>
              <option value="true" ${cc.enabled === 'true' ? 'selected' : ''}>启用</option>
              <option value="false" ${cc.enabled === 'false' ? 'selected' : ''}>停用</option>
            </select>
            <input class="xe-num" style="width:84px" type="number" min="1" max="999" placeholder="优先级" data-k="cp" data-j="${j}" value="${cc.priority}" />
            <button class="mini" data-act="del-cons" data-j="${j}" ${sp.constraints.length <= 1 ? 'disabled' : ''}>×</button>
          </div>`).join('')}
        <button class="mini xe-add" data-act="add-cons">＋ 约束启停/优先级覆盖</button>
      </div>`).join('');

    this.$dlgBody.innerHTML = `
      <div class="xe-base">
        来源：分支 <b>${escapeHtml(e.source.branchName)}</b> #${e.source.seq} · 基准指纹
        <code>${e.source.hash.slice(0, 8)}</code> · 基准矩形 ${model.rects.length} · 约束 ${model.constraints.length}
      </div>
      <div class="xe-name-row">
        <label>实验名称</label>
        <input id="xe-exp-name" type="text" placeholder="如：标签间距三方案" maxlength="40" value="${escapeHtml(e.name)}" />
      </div>
      <div class="xe-specs">${rows}</div>
      <button class="mini" id="xe-add-spec">＋ 添加一组变体</button>`;

    document.querySelector('#xe-exp-name').oninput = (ev) => { e.name = ev.target.value; };
    this.$dlgBody.querySelectorAll('.xe-spec').forEach((sec) => {
      const i = Number(sec.dataset.i);
      sec.querySelector('.xe-name').oninput = (ev) => { e.specs[i].name = ev.target.value; };
      sec.querySelectorAll('[data-k]').forEach((inp) => {
        const handler = (ev) => {
          const sp = e.specs[i];
          const j = Number(ev.target.dataset.j);
          const k = ev.target.dataset.k;
          const val = ev.target.value;
          if (k === 'rect') sp.rects[j].id = val;
          else if (k === 'cons') sp.constraints[j].id = val;
          else if (k === 'cen') sp.constraints[j].enabled = val;
          else if (k === 'cp') sp.constraints[j].priority = val;
          else sp.rects[j][{ rx: 'x', ry: 'y', rw: 'w', rh: 'h' }[k]] = val;
        };
        inp.addEventListener(inp.tagName === 'SELECT' ? 'change' : 'input', handler);
      });
      sec.querySelectorAll('[data-act]').forEach((btn) => {
        btn.onclick = (ev) => {
          ev.preventDefault();
          const sp = e.specs[i];
          const act = btn.dataset.act;
          if (act === 'del-spec') { e.specs.splice(i, 1); this._renderEditor(); }
          else if (act === 'add-rect') { sp.rects.push({ id: '', x: '', y: '', w: '', h: '' }); this._renderEditor(); }
          else if (act === 'add-cons') { sp.constraints.push({ id: '', enabled: '', priority: '' }); this._renderEditor(); }
          else if (act === 'del-rect') { sp.rects.splice(Number(btn.dataset.j), 1); this._renderEditor(); }
          else if (act === 'del-cons') { sp.constraints.splice(Number(btn.dataset.j), 1); this._renderEditor(); }
        };
      });
    });
    document.querySelector('#xe-add-spec').onclick = () => { e.specs.push(this._blankSpec()); this._renderEditor(); };
  }

  _sourceModel() {
    const ev = this.store.eventsById.get(this.editor.source.eventId);
    return ev.model;
  }

  _consBrief(c) {
    const n = (id) => this._sourceModel().rects.find((r) => r.id === id)?.name || id;
    const map = {
      snap: `贴齐 ${n(c.rect)} → ${n(c.other)}`,
      minGap: `间距 ${n(c.rect)} ↔ ${n(c.other)}`,
      contain: `包含 ${n(c.rect)}`,
      lock: `锁定 ${n(c.rect)}`,
    };
    return map[c.kind] || c.kind;
  }

  /** 编辑器草稿 → prepareSpecs 接受的规格（去掉空行、空字段）。 */
  _collectSpecs() {
    return this.editor.specs.map((sp) => {
      const rects = sp.rects
        .filter((r) => r.id)
        .map((r) => {
          const o = { id: r.id };
          for (const [k, f] of [['x', 'x'], ['y', 'y'], ['w', 'w'], ['h', 'h']]) {
            if (r[f] !== '' && r[f] !== null && r[f] !== undefined) o[k] = Number(r[f]);
          }
          return o;
        });
      const constraints = sp.constraints
        .filter((c) => c.id)
        .map((c) => {
          const o = { id: c.id };
          if (c.enabled === 'true') o.enabled = true;
          else if (c.enabled === 'false') o.enabled = false;
          if (c.priority !== '' && c.priority !== null && c.priority !== undefined) o.priority = Number(c.priority);
          return o;
        });
      const out = { name: sp.name.trim() };
      if (rects.length) out.rects = rects;
      if (constraints.length) out.constraints = constraints;
      return out;
    });
  }

  submit() {
    const e = this.editor;
    if (!e) return;
    const res = this.store.createExperiment(this._collectSpecs(), {
      name: e.name,
      sourceEventId: e.source.eventId,
    });
    if (!res.ok) {
      this.$dlgError.textContent = res.error;
      return;
    }
    this.closeEditor();
    if (res.idempotent) {
      this.hooks.toast('相同配置的实验已存在（幂等）：直接返回原实验，已完成结果未重跑', 'warn');
    } else {
      this.hooks.toast(`实验「${res.experiment.name}」已建立并开始批量求解 ${res.experiment.variants.length} 个变体`);
    }
    this.render();
  }

  /* ---------------- 实验列表 ---------------- */

  render() {
    const s = this.store;
    this.$count.textContent = s.experiments.length;
    this.$count.classList.toggle('zero', s.experiments.length === 0);
    this._renderWarnings();
    const list = this.$list;
    list.innerHTML = '';
    if (!s.experiments.length) {
      list.innerHTML = `<div class="empty-note">还没有实验。<br>从当前编辑分支建立实验，批量求解多组<br>矩形位置/尺寸与约束启停/优先级变体。</div>`;
      return;
    }
    for (const exp of [...s.experiments].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1))) {
      list.appendChild(this._expCard(exp));
    }
  }

  _renderWarnings() {
    const ws = this.store.experimentWarnings || [];
    if (!ws.length) { this.$warnings.innerHTML = ''; this.$warnings.classList.add('hidden'); return; }
    this.$warnings.classList.remove('hidden');
    this.$warnings.innerHTML = `<div class="aw-title">⚠ 实验数据健康检查（${ws.length}）</div>` +
      ws.slice(-6).map((w) => `<div class="aw-item">${escapeHtml(w.text)}</div>`).join('');
  }

  _expCard(exp) {
    const s = this.store;
    const c = variantCounters(exp.variants);
    const card = document.createElement('div');
    card.className = 'exp-card st-' + exp.runState;
    const srcBranch = s.branches.find((b) => b.id === exp.source?.branchId);
    const active = ['queued', 'running', 'paused'].includes(exp.runState) && c.queued + c.running > 0;
    card.innerHTML = `
      <div class="exp-row1">
        <span class="exp-status">${RUN_LABEL[exp.runState] || exp.runState}</span>
        <span class="exp-name" title="${escapeHtml(exp.name)}">${escapeHtml(exp.name)}</span>
      </div>
      <div class="exp-meta">
        ${fmtTime(exp.createdAt)} · ${escapeHtml(exp.actor || '未署名')} ·
        来源 ${escapeHtml(srcBranch?.name || exp.source?.branchId || '?')} #${exp.source?.seq ?? '?'} ·
        配置 <code>${exp.configHash.slice(0, 8)}</code>
      </div>
      <div class="exp-counts">
        <span class="vc vc-queued">排队 ${c.queued}</span>
        <span class="vc vc-running">运行 ${c.running}</span>
        <span class="vc vc-done">完成 ${c.done}</span>
        <span class="vc vc-failed">失败 ${c.failed}</span>
        <span class="vc vc-cancelled">取消 ${c.cancelled}</span>
        ${c.corrupt ? `<span class="vc vc-corrupt">损坏 ${c.corrupt}</span>` : ''}
      </div>
      ${exp.baseCorrupt ? '<div class="exp-basebad">基准快照指纹损坏：变体结果仍可查看 / 另存分支，但“与基准比较”不可用。</div>' : ''}
      <div class="exp-actions">
        <button class="mini" data-act="pause" ${exp.runState === 'running' && c.queued > 0 ? '' : 'disabled'}>⏸ 暂停</button>
        <button class="mini" data-act="resume" ${exp.runState === 'paused' && c.queued > 0 ? '' : 'disabled'}">▶ 继续</button>
        <button class="mini danger" data-act="cancel" ${active ? '' : 'disabled'}>取消剩余</button>
      </div>
      <div class="exp-variants"></div>`;
    const host = card.querySelector('.exp-variants');
    exp.variants.forEach((v, idx) => host.appendChild(this._variantRow(exp, v, idx)));
    card.querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = () => {
        const act = btn.dataset.act;
        let res;
        if (act === 'pause') res = s.pauseExperiment(exp.id);
        else if (act === 'resume') res = s.resumeExperiment(exp.id);
        else if (act === 'cancel') {
          if (!confirm(`取消实验「${exp.name}」中尚未完成的变体？\n已完成 / 已失败的结果保留且不会被重跑覆盖。`)) return;
          res = s.cancelExperiment(exp.id);
        }
        if (res && !res.ok) this.hooks.toast(res.error, 'warn');
      };
    });
    return card;
  }

  _variantRow(exp, v, idx) {
    const key = exp.id + '/' + v.id;
    const row = document.createElement('div');
    row.className = 'xv-row st-' + v.status + (v.corrupt ? ' corrupt' : '');
    const canDiff = v.status === 'done' && !v.corrupt && !exp.baseCorrupt;
    const canFork = v.status === 'done' && !v.corrupt;
    const changeSummary = this._changeSummary(v);
    row.innerHTML = `
      <div class="xv-head">
        <span class="xv-status">${v.corrupt ? '损坏' : V_LABEL[v.status] || v.status}</span>
        <span class="xv-name">${idx + 1}. ${escapeHtml(v.name)}</span>
        <span class="xv-changes">${escapeHtml(changeSummary)}</span>
        ${v.status === 'done' && !v.corrupt ? `<code class="xv-hash" title="完整指纹">${v.result.hash.slice(0, 8)}</code>` : ''}
      </div>
      ${v.status === 'failed' ? `<div class="xv-err">✗ ${escapeHtml(v.error || '求解失败')}（不影响其他变体）</div>` : ''}
      ${v.corrupt ? `<div class="xv-err">✗ 无法回放：${escapeHtml(v.corruptReason || '结果损坏')}（记录保留，不影响其他变体）</div>` : ''}
      <div class="xv-actions">
        <button class="mini" data-act="diff" ${canDiff ? '' : 'disabled'}
          title="查看该变体与基准的矩形 / 约束 / 冲突差异">与基准比较</button>
        <button class="mini" data-act="fork" ${canFork ? '' : 'disabled'}
          title="把该变体结果另存为新的编辑分支（保留实验来源关系）">⎇ 另存为新分支</button>
      </div>
      <div class="xv-diff" ${this.expanded.has(key) ? '' : 'style="display:none"'}></div>`;
    const $diff = row.querySelector('.xv-diff');
    if (this.expanded.has(key) && canDiff) $diff.innerHTML = diffHtml(this.store.diffVariant(exp.id, v.id));
    row.querySelector('[data-act=diff]').onclick = () => {
      if (this.expanded.has(key)) { this.expanded.delete(key); $diff.style.display = 'none'; }
      else {
        this.expanded.add(key);
        $diff.innerHTML = diffHtml(this.store.diffVariant(exp.id, v.id));
        $diff.style.display = '';
      }
    };
    row.querySelector('[data-act=fork]').onclick = () => {
      const def = `${exp.name} · ${v.name}`;
      const name = prompt('把该变体结果另存为新的编辑分支，名称：', `实验：${v.name}`.slice(0, 40));
      if (name === null) return;
      const res = this.store.forkExperimentVariant(exp.id, v.id, name || def);
      if (!res.ok) { this.hooks.toast(res.error, 'error'); return; }
      this.hooks.toast(`已另存为新分支「${name}」（实验来源已保留，实验结果未被改写）`);
    };
    return row;
  }

  _changeSummary(v) {
    const parts = [];
    const rs = v.changes?.rects?.length || 0;
    const cs = v.changes?.constraints?.length || 0;
    if (rs) parts.push(`矩形×${rs}`);
    if (cs) parts.push(`约束×${cs}`);
    if (!parts.length) parts.push('基准对照（无参数修改）');
    return parts.join(' · ');
  }
}

function fmtTime(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return '时间未知';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
