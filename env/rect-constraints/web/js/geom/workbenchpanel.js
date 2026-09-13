/*
 * 实验审计工作台面板：
 * - 按 编辑分支 / 实验 / 变体 / 健康级别 / 文本 筛选统一事件时间线（审计提交 + 实验变体求解）；
 * - 每个节点可展开：求解前/后的完整模型、约束变更（compareVersions 差异）、冲突链、指纹；
 *   “求解前 ⇄ 求解后”切换时画布同步重放对应快照并显示相邻状态差异；
 * - 顺序回放 / 暂停 / 继续 / 上一步 / 下一步 / 跳到指定事件 / 从指定事件（或变体结果）创建新编辑分支；
 * - 明确标出不可回放节点（事件缺失、顺序重复、指纹不匹配、分支已推进、变体失败/损坏），
 *   不可回放节点只阻止画布重放与另存分支，其余节点照常查看；
 * - 筛选条件、回放位置、前后面、分支来源（provenance）、结果顺序全部随文档持久化；
 * - 导出当前筛选结果（完整前后模型 + 冲突链 + 指纹 + 校验和），供离线核对。
 */

import { diffHtml } from './diff.js';
import { filterNodes, neighborNode, nextReplayable, buildExport, stableStringify, exportChecksum } from './auditbench.js';

const KIND_LABEL = { root: '初始', edit: '编辑', 'fork-root': '分支起点' };
const SEV_LABEL = { all: '全部节点', issues: '有标注', bad: '仅不可回放', unreplayable: '仅无快照' };
const SPEED_OPTIONS = [300, 500, 800, 1200, 2000, 3000];

export class WorkbenchPanel {
  constructor(store, hooks) {
    this.store = store;
    this.hooks = hooks; // { toast }
    this.$body = document.querySelector('[data-body="workbench"]');
    this.$count = document.querySelector('#wb-count');
    this._timer = null;
    this._buildDom();
    this._bind();

    store.addEventListener('workbench', () => this.render());
    store.addEventListener('experiments', () => this.render());
    store.addEventListener('replay', () => this._syncCursorFromStore());
    store.addEventListener('replayexit', () => this._onReplayExit());
    store.addEventListener('branch', () => this.render());
  }

  /* ---------------- DOM ---------------- */

  _buildDom() {
    this.$body.innerHTML = `
      <div class="wb-filters">
        <label class="wb-field">编辑分支
          <select id="wb-branch"></select>
        </label>
        <label class="wb-field">实验
          <select id="wb-experiment"></select>
        </label>
        <label class="wb-field">变体
          <select id="wb-variant"></select>
        </label>
        <label class="wb-field">健康
          <select id="wb-severity">
            <option value="all">${SEV_LABEL.all}</option>
            <option value="issues">${SEV_LABEL.issues}</option>
            <option value="bad">${SEV_LABEL.bad}</option>
            <option value="unreplayable">${SEV_LABEL.unreplayable}</option>
          </select>
        </label>
        <input id="wb-search" class="wb-search" type="search" placeholder="搜索标题 / 操作者 / 指纹 / 冲突原因…" maxlength="80" />
      </div>

      <div class="wb-player">
        <button id="wb-first" class="mini" title="跳到第一个可回放节点">⏮</button>
        <button id="wb-prev" class="mini" title="上一个可回放节点">◀</button>
        <button id="wb-play" class="mini primary" title="按顺序回放">▶ 回放</button>
        <button id="wb-next" class="mini" title="下一个可回放节点">▶</button>
        <button id="wb-last" class="mini" title="跳到最后一个可回放节点">⏭</button>
        <label class="wb-speed">速度
          <select id="wb-speed">
            ${SPEED_OPTIONS.map((ms) => `<option value="${ms}">${(ms / 1000).toFixed(1)}s</option>`).join('')}
          </select>
        </label>
        <span id="wb-pos" class="wb-pos" title="当前回放位置">0 / 0</span>
        <span class="spacer"></span>
        <button id="wb-export" class="mini" title="导出当前筛选结果（完整前后模型/冲突链/指纹，供后续核对）">⬇ 导出筛选结果</button>
      </div>

      <div id="wb-cursor" class="wb-cursor"></div>
      <div id="wb-list" class="list wb-list"></div>`;

    this.$branch = this.$body.querySelector('#wb-branch');
    this.$exp = this.$body.querySelector('#wb-experiment');
    this.$variant = this.$body.querySelector('#wb-variant');
    this.$sev = this.$body.querySelector('#wb-severity');
    this.$search = this.$body.querySelector('#wb-search');
    this.$play = this.$body.querySelector('#wb-play');
    this.$pos = this.$body.querySelector('#wb-pos');
    this.$speed = this.$body.querySelector('#wb-speed');
    this.$cursor = this.$body.querySelector('#wb-cursor');
    this.$list = this.$body.querySelector('#wb-list');
  }

  _bind() {
    const s = this.store;
    this.$branch.onchange = () => this._setFilter({ branchId: this.$branch.value || null, experimentId: null, variantId: null });
    this.$exp.onchange = () => this._setFilter({ experimentId: this.$exp.value || null, variantId: null });
    this.$variant.onchange = () => this._setFilter({ variantId: this.$variant.value || null });
    this.$sev.onchange = () => this._setFilter({ severity: this.$sev.value });
    let searchTimer = null;
    this.$search.oninput = () => {
      clearTimeout(searchTimer);
      const v = this.$search.value;
      searchTimer = setTimeout(() => this._setFilter({ text: v }), 180);
    };
    this.$body.querySelector('#wb-first').onclick = () => this._jump(-2);
    this.$body.querySelector('#wb-prev').onclick = () => this._jump(-1);
    this.$body.querySelector('#wb-next').onclick = () => this._jump(1);
    this.$body.querySelector('#wb-last').onclick = () => this._jump(2);
    this.$play.onclick = () => this._togglePlay();
    this.$speed.onchange = () => s.setWorkbench({ speedMs: Number(this.$speed.value) });
    this.$body.querySelector('#wb-export').onclick = () => this._export();
  }

  /* ---------------- 状态便捷访问 ---------------- */

  get wb() { return this.store.auditWorkbench; }

  _filtered() {
    const w = this.store.workbench();
    return { w, list: filterNodes(w.nodes, this.wb.filter) };
  }

  _setFilter(patch) {
    this._stopPlay();
    this.store.setWorkbench({ filter: patch, playing: false });
  }

  /* ---------------- 渲染 ---------------- */

  render() {
    const s = this.store;
    const f = this.wb.filter;
    const { w, list } = this._filtered();
    this.$count.textContent = w.summary.total;

    // 筛选下拉（保留当前选择；搜索框值不同步以免输入焦点被打断）
    const branches = [...s.branches].sort((a, b) => (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : 1));
    this.$branch.innerHTML = `<option value="">全部编辑分支（${branches.length}）</option>` +
      branches.map((b) => `<option value="${b.id}" ${b.id === f.branchId ? 'selected' : ''}>${escapeHtml(b.name)}</option>`).join('');

    const exps = [...s.experiments].sort((a, b) => (b.createdAt - a.createdAt) || (a.id < b.id ? -1 : 1));
    this.$exp.innerHTML = `<option value="">全部实验（${exps.length}）</option>` +
      exps.map((x) => `<option value="${x.id}" ${x.id === f.experimentId ? 'selected' : ''}>${escapeHtml(x.name)}</option>`).join('');

    const exp = f.experimentId ? s.experimentById(f.experimentId) : null;
    this.$variant.innerHTML = `<option value="">全部变体</option>` +
      (exp ? exp.variants.map((v) => `<option value="${v.id}" ${v.id === f.variantId ? 'selected' : ''}>${escapeHtml(v.name)}</option>`).join('') : '');
    this.$variant.disabled = !exp;
    this.$sev.value = f.severity;
    if (document.activeElement !== this.$search) this.$search.value = f.text || '';
    this.$speed.value = String(this.wb.speedMs);

    // 播放条位置（按筛选后顺序；不可回放节点计入总数但不可停留）
    const pos = this.wb.cursorKey ? list.findIndex((n) => n.key === this.wb.cursorKey) + 1 : 0;
    this.$pos.textContent = `${pos} / ${list.length}`;
    this.$play.textContent = this.wb.playing ? '⏸ 暂停' : '▶ 回放';
    this.$play.classList.toggle('primary', !this.wb.playing);

    this._renderCursor(w, list);

    // 节点列表
    if (!list.length) {
      this.$list.innerHTML = `<div class="empty-note">当前筛选没有节点。<br>清空分支 / 实验 / 健康筛选后可看到全部审计提交与实验求解。</div>`;
      return;
    }
    this.$list.innerHTML = list.map((n) => this._rowHtml(n, w)).join('');
    this.$list.querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const n = w.byKey.get(btn.closest('[data-key]').dataset.key);
        this._act(btn.dataset.act, n);
      };
    });
    this.$list.querySelectorAll('[data-key]').forEach((el) => {
      el.onclick = (e) => {
        if (e.target.closest('[data-act]')) return;
        const n = w.byKey.get(el.dataset.key);
        // 保留当前正在查看的“求解前/后”面；该面不可用时回到求解后
        const side = this.wb.side === 'before' && n.baseEntry ? 'before' : 'after';
        this._gotoNode(n, side, { toastBlocked: true });
      };
    });
  }

  _renderCursor(w, list) {
    const key = this.wb.cursorKey;
    let n = key ? w.byKey.get(key) : null;
    // 节点仍存在但被当前筛选排除（如刚切换了分支/实验筛选）：只保留光标，不展示卡片
    if (n && !list.some((x) => x.key === n.key)) n = null;
    if (!n) {
      this.$cursor.innerHTML = `<div class="wb-cursor-empty">选择任意节点（或按 ▶ 回放）把画布重放到求解那一刻；展开节点可查看完整模型、约束变更、冲突链与指纹。</div>`;
      return;
    }
    const side = this.wb.side === 'before' ? 'before' : 'after';
    const shown = side === 'before' ? (n.baseEntry || null) : (n.entry || null);
    const prev = neighborNode(list, n.key, -1);
    const next = neighborNode(list, n.key, 1);
    const canBefore = !!n.baseEntry && n.replayable;

    this.$cursor.innerHTML = `
      <div class="wbc-head">
        <span class="wb-kind ${n.kind === 'experiment-variant' ? 'k-var' : 'k-ev'}">${n.kind === 'experiment-variant' ? '实验求解' : KIND_LABEL[n.eventKind] || '编辑'}</span>
        <b class="wbc-title">${escapeHtml(n.title)}</b>
        <span class="wbc-where">${escapeHtml(n.branch?.name || '—')}${n.experiment ? ` · ${escapeHtml(n.experiment.name)}` : ''} · ${n.seqLabel}</span>
      </div>
      <div class="wbc-sides">
        <button class="mini ${side === 'before' ? 'primary' : ''}" data-cact="side-before" ${canBefore ? '' : 'disabled'}
          title="求解前：编辑事件取父事件、fork 起点取来源、实验变体取实验基准">查看求解前</button>
        <button class="mini ${side === 'after' ? 'primary' : ''}" data-cact="side-after" ${n.replayable ? '' : 'disabled'}>查看求解后</button>
        <button class="mini" data-cact="prev" ${prev ? '' : 'disabled'} title="上一个相邻状态（筛选结果内）">↑ 上一状态</button>
        <button class="mini" data-cact="next" ${next ? '' : 'disabled'} title="下一个相邻状态（筛选结果内）">下一状态 ↓</button>
        <span class="spacer"></span>
        <button class="mini" data-cact="fork" ${n.fork ? '' : 'disabled'}
          title="从该事件 / 变体结果创建新的编辑分支（带 provenance 来源关系，原数据不改写）">⎇ 从此创建编辑分支</button>
      </div>
      ${this._badgesHtml(n)}
      <div class="wbc-hashes">
        <span>求解前指纹 <code>${n.hashBefore ? n.hashBefore.slice(0, 8) : '—'}</code></span>
        <span>→ 求解后指纹 <code>${n.hashAfter ? n.hashAfter.slice(0, 8) : '—'}</code></span>
        ${shown ? `<span class="wbc-now">画布当前：${side === 'before' ? '求解前' : '求解后'} <code>${shown.hash.slice(0, 8)}</code></span>` : ''}
      </div>
      <div class="wbc-diff"><div class="dg-title">约束 / 矩形 / 冲突变更（求解前 → 求解后）</div>${n.changes ? diffHtml(n.changes) : '<div class="diff-none">无可用差异（初始事件 / 基准损坏 / 来源缺失）</div>'}</div>
      <details class="wbc-details" ${this.wb.detailOpen ? 'open' : ''}>
        <summary>完整模型 · 冲突链 · 指纹（${side === 'before' ? '求解前' : '求解后'}）</summary>
        ${shown ? this._fullModelHtml(shown, n) : '<div class="diff-none">该面快照不可回放。</div>'}
      </details>`;

    this.$cursor.querySelectorAll('[data-cact]').forEach((btn) => {
      btn.onclick = () => {
        const act = btn.dataset.cact;
        if (act === 'side-before') this._gotoNode(n, 'before');
        else if (act === 'side-after') this._gotoNode(n, 'after');
        else if (act === 'prev') prev && this._gotoNode(prev, 'after');
        else if (act === 'next') next && this._gotoNode(next, 'after');
        else if (act === 'fork') this._fork(n);
      };
    });
    const det = this.$cursor.querySelector('details.wbc-details');
    det.addEventListener('toggle', () => {
      if (det.open !== this.wb.detailOpen) this.store.setWorkbench({ detailOpen: det.open });
    });
  }

  _fullModelHtml(entry, n) {
    const { model, report } = entry;
    const rectRows = model.rects.map((r) => {
      const p = report.rects[r.id] || r;
      return `<tr><td>${escapeHtml(r.name || r.id.slice(-5))}</td>
        <td>${p.x}</td><td>${p.y}</td><td>${p.w}</td><td>${p.h}</td></tr>`;
    }).join('');
    const nameOf = new Map(model.rects.map((r) => [r.id, r.name || r.id.slice(-5)]));
    const consRows = model.constraints.map((c) => {
      const st = report.constraints[c.id];
      return `<tr>
        <td><span class="status-dot ${st?.disabled ? 'dot-off' : st?.satisfied ? 'dot-ok' : 'dot-bad'}"></span></td>
        <td>${escapeHtml(c.kind)}</td><td>${escapeHtml(c.priority)}</td>
        <td>${c.enabled === false ? '停用' : '启用'}</td>
        <td>${escapeHtml(nameOf.get(c.rect) || c.rect)}${c.other ? ' → ' + escapeHtml(nameOf.get(c.other) || c.other) : ''}</td></tr>`;
    }).join('');
    const conflicts = (n.conflicts?.length ? n.conflicts : report.conflicts || []);
    return `
      <div class="wbc-model">
        <div class="wbc-sub">矩形（${model.rects.length}）· 画布 ${model.canvas.w}×${model.canvas.h}</div>
        <table class="wbc-table"><thead><tr><th>名称</th><th>x</th><th>y</th><th>w</th><th>h</th></tr></thead><tbody>${rectRows}</tbody></table>
        <div class="wbc-sub">约束（${model.constraints.length}）</div>
        <table class="wbc-table"><thead><tr><th></th><th>类型</th><th>优先级</th><th>启停</th><th>矩形</th></tr></thead><tbody>${consRows}</tbody></table>
        <div class="wbc-sub">冲突链（${conflicts.length}）</div>
        ${conflicts.length ? conflicts.map((c) => `
          <div class="wbc-conf">
            <div class="wbc-conf-h">✗ ${escapeHtml(c.label)} <span class="wbc-measure">偏差 ${Math.abs(c.measure).toFixed(2)} · 优先级 ${c.priority}</span></div>
            <ol>${(c.chain || []).map((x) => `<li>${escapeHtml(x)}</li>`).join('') || '<li>画布硬边界 / 拖动定位</li>'}</ol>
          </div>`).join('') : '<div class="diff-none">无未满足约束。</div>'}
        <div class="wbc-sub">完整指纹</div>
        <code class="wbc-fullhash">${entry.hash}</code>
      </div>`;
  }

  _badgesHtml(n) {
    if (!n.badges.length) return '';
    return `<div class="wbc-badges">${n.badges.map((b) =>
      `<span class="wb-badge b-${b.level}">${b.level === 'bad' ? '✗ ' : b.level === 'warn' ? '⚠ ' : 'ℹ '}${escapeHtml(b.text)}</span>`).join('')}</div>`;
  }

  _rowHtml(n) {
    const cls = [
      'wb-node',
      n.severity === 'bad' ? 'bad' : n.severity === 'warn' ? 'warn' : 'ok',
      n.replayable ? '' : 'noreplay',
      n.key === this.wb.cursorKey ? 'current' : '',
    ].filter(Boolean).join(' ');
    const changeSum = n.changes && !n.changes.identical ? this._changeSum(n.changes) : '';
    const where = [
      n.branch ? escapeHtml(n.branch.name) : '无分支',
      n.experiment ? `实验「${escapeHtml(n.experiment.name)}」` : '',
    ].filter(Boolean).join(' · ');
    return `<div class="${cls}" data-key="${n.key}" ${n.replayable ? 'title="点击重放到此节点"' : ''}>
      <div class="wbn-row1">
        <span class="wb-seq">${n.seqLabel}</span>
        <span class="wb-kind ${n.kind === 'experiment-variant' ? 'k-var' : 'k-ev'}">${n.kind === 'experiment-variant' ? '实验' : KIND_LABEL[n.eventKind] || '编辑'}</span>
        <span class="wbn-title">${escapeHtml(n.title)}</span>
        ${n.replayable ? '' : '<span class="wb-tag t-bad">不可回放</span>'}
        ${n.key === this.wb.cursorKey ? '<span class="wb-tag t-cur">回放位置</span>' : ''}
      </div>
      <div class="wbn-meta">${fmtTime(n.t)} · ${escapeHtml(n.actor)} · ${where}</div>
      <div class="wbn-hash">${n.hashBefore ? n.hashBefore.slice(0, 8) : '—'} → <b>${n.hashAfter ? n.hashAfter.slice(0, 8) : '—'}</b>${changeSum ? ' · ' + changeSum : ''} · 冲突 ${n.conflicts.length}</div>
      ${n.badges.length ? `<div class="wbn-badges">${n.badges.slice(0, 2).map((b) =>
        `<span class="wb-badge b-${b.level}">${escapeHtml(b.text)}</span>`).join('')}</div>` : ''}
      <div class="wbn-actions">
        <button class="mini" data-act="goto" ${n.replayable ? '' : 'disabled'}>▶ 重放</button>
        <button class="mini" data-act="before" ${n.baseEntry && n.replayable ? '' : 'disabled'} title="重放求解前快照">求解前</button>
        <button class="mini" data-act="fork" ${n.fork ? '' : 'disabled'} title="从该节点创建新的编辑分支">⎇ 另存编辑分支</button>
      </div>
    </div>`;
  }

  _changeSum(d) {
    const r = d.rects.added.length + d.rects.removed.length + d.rects.moved.length + d.rects.resized.length;
    const c = d.constraints.added.length + d.constraints.removed.length + d.constraints.changed.length;
    return escapeHtml([r ? `矩形 ${r}` : '', c ? `约束 ${c}` : '', `冲突 ${d.conflicts.before}→${d.conflicts.after}`].filter(Boolean).join(' · '));
  }

  /* ---------------- 操作 ---------------- */

  _act(act, n) {
    if (act === 'goto') this._gotoNode(n, 'after', { toastBlocked: true });
    else if (act === 'before') this._gotoNode(n, 'before', { toastBlocked: true });
    else if (act === 'fork') this._fork(n);
  }

  _gotoNode(n, side, { toastBlocked = false } = {}) {
    if (!n) return;
    if (!n.replayable) {
      if (toastBlocked) this.hooks.toast(`节点「${n.title}」不可回放：${n.badges.find((b) => b.level === 'bad')?.text || '无结果快照'}（其他节点仍可查看）`, 'warn');
      // 仍记录光标位置：详情可展开查看元数据/标注，但不进入画布只读回放
      this.store.setWorkbench({ cursorKey: n.key });
      return;
    }
    const res = this.store.showWorkbenchNode(n, side);
    if (!res.ok) { this.hooks.toast(res.error, 'warn'); return; }
    this._stopPlay();
  }

  _fork(n) {
    if (!n?.fork) { this.hooks.toast('该节点不可回放，无法创建编辑分支', 'error'); return; }
    const defName = n.kind === 'experiment-variant'
      ? `实验：${n.variant.name}`.slice(0, 40)
      : `回放 #${n.seq ?? ''} 分支`;
    const name = prompt('从此节点创建新的编辑分支，名称：', defName);
    if (name === null) return;
    const res = n.fork.type === 'event'
      ? this.store.forkFromEvent(n.fork.eventId, name)
      : this.store.forkExperimentVariant(n.fork.experimentId, n.fork.variantId, name);
    if (!res.ok) { this.hooks.toast(res.error, 'error'); return; }
    // 分支来源随新分支 provenance 持久化；工作台光标移到新分支起点
    const rootKey = `event:${res.event.id}`;
    this.store.setWorkbench({ cursorKey: rootKey, side: 'after', playing: false, filter: { branchId: res.branch.id } });
    this.hooks.toast(`已创建编辑分支「${name}」，分支来源已记录；原审计事件 / 实验结果未被改写`);
  }

  /* ---------------- 顺序回放 ---------------- */

  _togglePlay() {
    const { list } = this._filtered();
    if (!list.length) { this.hooks.toast('当前筛选没有可回放节点', 'warn'); return; }
    if (this.wb.playing) { this._stopPlay(); return; }
    // 从当前位置继续；当前位置不可回放 / 在末尾则跳到第一个可回放节点
    const cur = this.wb.cursorKey ? list.find((n) => n.key === this.wb.cursorKey) : null;
    let first = cur && cur.replayable ? cur : nextReplayable(list, null, 1);
    if (cur && cur.replayable) {
      const nx = nextReplayable(list, cur.key, 1);
      if (!nx) first = nextReplayable(list, null, 1); // 已到末尾：从头开始
    }
    if (!first) { this.hooks.toast('筛选结果中没有可回放节点（不可回放节点只做标注，不会自动停留）', 'warn'); return; }
    this.store.setWorkbench({ playing: true });
    const res = this.store.showWorkbenchNode(first, 'after');
    if (!res.ok) { this._stopPlay(); this.hooks.toast(res.error, 'error'); return; }
    this._schedule();
  }

  _schedule() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._tick(), this.wb.speedMs);
  }

  _tick() {
    if (!this.wb.playing) return;
    const { list } = this._filtered();
    const cur = this.wb.cursorKey ? list.find((n) => n.key === this.wb.cursorKey) : null;
    const nx = cur ? nextReplayable(list, cur.key, 1) : nextReplayable(list, null, 1);
    if (!nx) { this._stopPlay(); this.hooks.toast('已回放到筛选结果末尾（已暂停）'); return; }
    // 自动推进不产生额外落盘（光标持久化随播放暂停 / 切节点时的 setWorkbench 完成）
    const res = this.store.showWorkbenchNode(nx, 'after');
    if (!res.ok) { this._stopPlay(); this.hooks.toast(res.error, 'error'); return; }
    this._schedule();
  }

  _stopPlay() {
    clearTimeout(this._timer);
    this._timer = null;
    if (this.wb.playing) this.store.setWorkbench({ playing: false });
  }

  _jump(dir) {
    this._stopPlay();
    const { list } = this._filtered();
    const replayable = list.filter((n) => n.replayable);
    if (!replayable.length) { this.hooks.toast('筛选结果中没有可回放节点', 'warn'); return; }
    const cur = this.wb.cursorKey ? list.find((n) => n.key === this.wb.cursorKey) : null;
    let target = null;
    if (dir === -2) target = replayable[0];
    else if (dir === 2) target = replayable[replayable.length - 1];
    else if (dir === -1) target = cur ? nextReplayable(list, cur.key, -1) : replayable[0];
    else target = cur ? nextReplayable(list, cur.key, 1) : replayable[0];
    if (!target) { this.hooks.toast(dir < 0 ? '已经是第一个可回放节点' : '已经是最后一个可回放节点', 'warn'); return; }
    this._gotoNode(target, 'after');
  }

  _syncCursorFromStore() {
    // 从审计页等其他入口进入回放时，让工作台光标跟随（快照回放没有事件 key 时不改光标）
    const info = this.store.replayInfo;
    if (info?.mode === 'event') {
      const key = `event:${info.eventId}`;
      if (this.wb.cursorKey !== key) this.store.setWorkbench({ cursorKey: key, side: 'after' });
    }
    this.render();
  }

  _onReplayExit() { this.render(); }

  /* ---------------- 导出 ---------------- */

  _export() {
    const s = this.store;
    const { list } = this._filtered();
    if (!list.length) { this.hooks.toast('当前筛选没有节点可导出', 'warn'); return; }
    const resolved = {
      branchId: this.wb.filter.branchId,
      branchName: s.branches.find((b) => b.id === this.wb.filter.branchId)?.name || null,
      experimentId: this.wb.filter.experimentId,
      variantId: this.wb.filter.variantId,
      severity: this.wb.filter.severity,
      text: this.wb.filter.text,
    };
    const doc = buildExport(list, this.wb.filter, { resolvedFilter: resolved });
    const text = stableStringify(doc);
    doc.contentChecksum = exportChecksum(text);
    const finalText = stableStringify(doc);
    const blob = new Blob([finalText], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    a.href = url;
    a.download = `audit-workbench-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    this.hooks.toast(`已导出 ${list.length} 个节点（含完整前后模型 / 冲突链 / 指纹 / 校验和 ${doc.contentChecksum}），顺序与界面一致`);
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
