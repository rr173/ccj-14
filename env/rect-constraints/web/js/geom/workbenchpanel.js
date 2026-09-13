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
import {
  DECISION_LABEL, DRIFT_TEXT, normalizeReviewPolicy, signatureState,
  activeSignatures, isAllowedSigner,
} from './reviews.js';

const KIND_LABEL = { root: '初始', edit: '编辑', 'fork-root': '分支起点' };
const SEV_LABEL = { all: '全部节点', issues: '有标注', bad: '仅不可回放', unreplayable: '仅无快照' };
const SPEED_OPTIONS = [300, 500, 800, 1200, 2000, 3000];

const DEC_BTN = [
  { d: 'pass', label: '✓ 通过', cls: 'ok' },
  { d: 'reject', label: '✗ 驳回', cls: 'bad' },
  { d: 'review', label: '？待复核', cls: 'warn' },
];

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
    store.addEventListener('reviews', () => this._renderReviews());
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
        <button id="wb-new-review" class="mini" title="从当前筛选结果创建可恢复的审阅会话（快照：筛选条件 + 节点顺序 + 每节点指纹）">📝 从筛选创建审阅会话</button>
        <button id="wb-export" class="mini" title="导出当前筛选结果（完整前后模型/冲突链/指纹，供后续核对）">⬇ 导出筛选结果</button>
      </div>

      <div id="wb-cursor" class="wb-cursor"></div>
      <div id="rv-create-modal" class="modal hidden">
        <div class="modal-card rv-create-card">
          <div class="modal-head">创建审阅会话 <span class="spacer"></span><button id="rv-create-x" class="mini">✕</button></div>
          <div id="rv-create-body" class="rv-create-body">
            <label class="rv-form-row">会话名称
              <input id="rv-create-name" maxlength="60" />
            </label>
            <label class="rv-form-check"><input id="rv-create-multi" type="checkbox" /> 启用多人签署（决定后必须单独签名确认）</label>
            <div id="rv-create-policy">
              <label class="rv-form-row">允许的审阅人（逗号 / 顿号 / 换行分隔）
                <textarea id="rv-create-signers" rows="3" placeholder="张三、李四、王五"></textarea>
              </label>
              <div class="rv-form-grid">
                <label class="rv-form-row">每节点需要签名数
                  <input id="rv-create-required" type="number" min="1" value="2" />
                </label>
                <label class="rv-form-row">会话完成条件
                  <select id="rv-create-rule">
                    <option value="all-decided">所有节点确认即可（允许驳回）</option>
                    <option value="no-reject">所有节点确认且最终无驳回</option>
                  </select>
                </label>
              </div>
              <div class="rv-form-note" id="rv-create-hint"></div>
            </div>
          </div>
          <div class="modal-foot">
            <span class="spacer"></span>
            <button id="rv-create-cancel" class="mini">取消</button>
            <button id="rv-create-ok" class="mini primary">创建快照</button>
          </div>
        </div>
      </div>
      <div id="wb-reviews" class="wb-reviews"></div>
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
    this.$reviews = this.$body.querySelector('#wb-reviews');
    this.$createModal = this.$body.querySelector('#rv-create-modal');
    this.$createName = this.$body.querySelector('#rv-create-name');
    this.$createMulti = this.$body.querySelector('#rv-create-multi');
    this.$createSigners = this.$body.querySelector('#rv-create-signers');
    this.$createRequired = this.$body.querySelector('#rv-create-required');
    this.$createRule = this.$body.querySelector('#rv-create-rule');
    this.$createHint = this.$body.querySelector('#rv-create-hint');
    this.$list = this.$body.querySelector('#wb-list');
    this._bindCreateModal();
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
    this.$body.querySelector('#wb-new-review').onclick = () => this._openCreateReview();
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
    this._renderReviews(w, list);

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
    const reviewMark = this._reviewMarkHtml(n.key);
    return `<div class="${cls}" data-key="${n.key}" ${n.replayable ? 'title="点击重放到此节点"' : ''}>
      <div class="wbn-row1">
        <span class="wb-seq">${n.seqLabel}</span>
        <span class="wb-kind ${n.kind === 'experiment-variant' ? 'k-var' : 'k-ev'}">${n.kind === 'experiment-variant' ? '实验' : KIND_LABEL[n.eventKind] || '编辑'}</span>
        <span class="wbn-title">${escapeHtml(n.title)}</span>
        ${reviewMark}
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

  /* ---------------- 可恢复审阅会话 ---------------- */

  _activeReviewView() {
    const id = this.store.activeReviewId;
    if (!id) return null;
    return this.store.reviewView(id);
  }

  _bindCreateModal() {
    const close = () => this.$createModal.classList.add('hidden');
    this.$body.querySelector('#rv-create-x').onclick = close;
    this.$body.querySelector('#rv-create-cancel').onclick = close;
    this.$body.querySelector('#rv-create-ok').onclick = () => this._submitCreateReview();
    this.$createMulti.onchange = () => this._syncCreatePolicyUi();
    this.$createSigners.oninput = () => this._syncCreatePolicyUi();
    this.$createRequired.oninput = () => this._syncCreatePolicyUi();
  }

  _parseSignerText() {
    const seen = new Set();
    const out = [];
    for (const raw of this.$createSigners.value.split(/[\n,，、;；]/)) {
      const name = raw.trim().slice(0, 40);
      if (name && !seen.has(name)) { seen.add(name); out.push(name); }
    }
    return out;
  }

  _syncCreatePolicyUi() {
    const multi = this.$createMulti.checked;
    this.$createModal.querySelector('#rv-create-policy').classList.toggle('hidden', !multi);
    if (!multi) return;
    const signers = this._parseSignerText();
    const n = Math.max(1, Number(this.$createRequired.value) || 1);
    this.$createRequired.max = String(Math.max(1, signers.length || 1));
    if (Number(this.$createRequired.value) > signers.length && signers.length) this.$createRequired.value = signers.length;
    this.$createHint.textContent = signers.length
      ? `允许 ${signers.length} 人；节点需 ${Math.min(n, signers.length)} 个有效签名才确认。未署名且不在名单中不能签。`
      : '请至少填写一名允许的审阅人；也可以把当前操作者填入名单。';
  }

  _openCreateReview() {
    const { list } = this._filtered();
    if (!list.length) { this.hooks.toast('当前筛选没有节点，无法创建审阅会话', 'warn'); return; }
    const me = (this.store.actor || '').trim();
    this.$createName.value = `审阅 ${new Date().toLocaleString()}`;
    this.$createMulti.checked = false;
    this.$createSigners.value = [me, '审阅人2'].filter(Boolean).join('、');
    this.$createRequired.value = '2';
    this.$createRule.value = 'all-decided';
    this._syncCreatePolicyUi();
    this.$createModal.classList.remove('hidden');
    this.$createName.focus();
  }

  _submitCreateReview() {
    const name = this.$createName.value.trim();
    if (!name) { this.hooks.toast('请填写会话名称', 'warn'); return; }
    let policy = null;
    if (this.$createMulti.checked) {
      const signers = this._parseSignerText();
      if (!signers.length) { this.hooks.toast('多人签署必须设置允许的审阅人名单', 'warn'); return; }
      const required = Math.max(1, Math.min(signers.length, Number(this.$createRequired.value) || signers.length));
      policy = { mode: 'signoff', signers, required, completeRule: this.$createRule.value };
    }
    const res = this.store.createReview(name, { policy });
    if (!res.ok) { this.hooks.toast(res.error || '创建失败', 'error'); return; }
    this.$createModal.classList.add('hidden');
    const { list } = this._filtered();
    this.hooks.toast(`已创建审阅会话「${res.session.name}」：已保存规则、节点顺序与 ${list.length} 个节点指纹，可随时恢复`);
  }

  /** @deprecated 保留供测试/控制台调用：创建默认单人会话。 */
  _createReview() {
    const { list } = this._filtered();
    if (!list.length) { this.hooks.toast('当前筛选没有节点，无法创建审阅会话', 'warn'); return; }
    const def = `审阅 ${new Date().toLocaleString()}`;
    const name = prompt(`从当前筛选结果（${list.length} 个节点）创建审阅会话，名称：`, def);
    if (name === null) return;
    const res = this.store.createReview(name);
    if (!res.ok) { this.hooks.toast(res.error || '创建失败', 'error'); return; }
    this.hooks.toast(`已创建审阅会话「${res.session.name}」：已保存筛选条件、节点顺序与 ${list.length} 个节点指纹，可随时恢复`);
  }

  /** 时间线行上的决定标记（当前会话覆盖的节点才显示）。 */
  _reviewMarkHtml(key) {
    const view = this._activeReviewView();
    if (!view) return '';
    const sn = view.session.nodes.find((x) => x.key === key);
    if (!sn) return '';
    const policy = normalizeReviewPolicy(view.session.policy);
    const st = signatureState(sn, policy);
    const eff = sn.autoReview ? 'review' : st.decision;
    const tag = {
      pass: '<span class="rv-mark m-pass" title="审阅通过">✓ 通过</span>',
      reject: '<span class="rv-mark m-reject" title="审阅驳回">✗ 驳回</span>',
      review: sn.autoReview
        ? '<span class="rv-mark m-review" title="系统转待复核：' + escapeHtml(sn.autoReview.reason) + '">⚠ 待复核</span>'
        : '<span class="rv-mark m-review" title="待复核">？待复核</span>',
      pending: '<span class="rv-mark m-pending" title="未处理">○ 未处理</span>',
    }[eff] || '';
    return tag;
  }

  _renderReviewsSection() {
    const s = this.store;
    const sessions = [...s.reviewSessions].sort((a, b) => (b.createdAt - a.createdAt) || (a.id < b.id ? -1 : 1));
    if (!sessions.length) return '';
    const activeId = s.activeReviewId;
    const items = sessions.map((sess) => {
      const v = s.reviewView(sess.id);
      const p = v.progress;
      const drift = v.session.nodes.filter((n) => n.autoReview).length;
      const openC = v.session.conflicts.filter((c) => !c.resolved).length;
      const isActive = sess.id === activeId;
      const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
      return `<div class="rv-chip ${isActive ? 'active' : ''} ${sess.status === 'completed' ? 'completed' : ''}" data-rv-select="${sess.id}">
        <span class="rv-chip-name">${escapeHtml(sess.name)}</span>
        <span class="rv-chip-meta">${p.done}/${p.total} · ✓${p.pass} ✗${p.reject} ？${p.review + p.pending}</span>
        <span class="rv-bar"><span class="rv-bar-fill" style="width:${pct}%"></span></span>
        ${sess.status === 'completed' ? '<span class="rv-state">已完成</span>' : ''}
        ${drift ? `<span class="rv-state warn" title="有节点损坏/缺失/指纹变化/分支推进，已转待复核">漂移 ${drift}</span>` : ''}
        ${openC ? `<span class="rv-state bad">冲突 ${openC}</span>` : ''}
      </div>`;
    }).join('');
    return `<div class="rv-all">
      <div class="rv-all-h">审阅会话（${sessions.length}）<span class="rv-all-tip">点击会话恢复；快照、进度、决定顺序与冲突记录随文档持久化</span></div>
      <div class="rv-chips">${items}</div>
    </div>`;
  }

  _renderReviews() {
    const s = this.store;
    const sessions = s.reviewSessions;
    if (!sessions.length) { this.$reviews.innerHTML = ''; return; }
    const activeId = s.activeReviewId;
    const view = activeId ? s.reviewView(activeId) : null;
    const conflict = s.reviewConflict && s.reviewConflict.sessionId === activeId ? s.reviewConflict : null;
    const proposals = activeId ? s.reviewProposals(activeId) : [];
    this.$reviews.innerHTML = `
      ${this._renderReviewsSection()}
      ${view ? this._renderActiveReview(view, conflict, proposals) : ''}`;

    // 会话切换
    this.$reviews.querySelectorAll('[data-rv-select]').forEach((el) => {
      el.onclick = () => {
        const id = el.dataset.rvSelect;
        s.selectReview(s.activeReviewId === id ? null : id);
      };
    });
    if (!view) return;
    const sid = view.session.id;
    this.$reviews.querySelectorAll('[data-rv-act]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        this._reviewAction(btn.dataset.rvAct, btn, sid);
      };
    });
    this.$reviews.querySelectorAll('[data-rv-node] [data-dec]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const node = btn.closest('[data-rv-node]');
        const key = node.dataset.rvNode;
        const sess = view.session;
        if (normalizeReviewPolicy(sess.policy).mode === 'signoff') {
          node.dataset.draftDecision = btn.dataset.dec;
          node.querySelectorAll('[data-dec]').forEach((x) => x.classList.toggle('sel', x === btn));
          node.querySelector('.rv-sign')?.focus();
        } else {
          this._decide(sid, key, btn.dataset.dec, { force: btn.dataset.force === '1' });
        }
      };
    });
    this.$reviews.querySelectorAll('[data-sign]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const node = btn.closest('[data-rv-node]');
        this._signNode(sid, node.dataset.rvNode, btn.dataset.sign);
      };
    });
    this.$reviews.querySelectorAll('[data-rv-node] .rv-reason').forEach((inp) => {
      const node = inp.closest('[data-rv-node]');
      inp.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.stopPropagation();
        const eff = node.querySelector('.rv-dec.sel');
        if (!eff) { this.hooks.toast('请先选择 通过 / 驳回 / 待复核', 'warn'); return; }
        if (normalizeReviewPolicy(s.reviewSessionById(sid)?.policy).mode === 'signoff') {
          this._signNode(sid, node.dataset.rvNode, 'sign');
        } else {
          this._decide(sid, node.dataset.rvNode, eff.dataset.dec);
        }
      });
    });
  }

  _renderActiveReview(view, conflict, proposals) {
    const sess = view.session;
    const p = view.progress;
    const onlyFiltered = this._sessionMatchesCurrentFilter(view);
    return `
    <div class="rv-box ${sess.status === 'completed' ? 'completed' : ''}">
      <div class="rv-head">
        <b>📝 ${escapeHtml(sess.name)}</b>
        <span class="rv-head-meta">${escapeHtml(sess.createdBy)} · 创建 ${fmtTime(sess.createdAt)} · 快照节点 ${sess.baseline.total} · rev ${sess.rev}</span>
        <span class="spacer"></span>
        ${sess.status === 'completed'
          ? '<button class="mini" data-rv-act="reopen">重开会话</button>'
          : `<button class="mini primary" data-rv-act="complete" ${p.complete ? '' : 'disabled'} title="全部节点（含系统转待复核）处理完后可完成">标记完成</button>`}
        <button class="mini" data-rv-act="rebase" title="按当前筛选结果重建基线：保留全部决定与变更历史，新节点成为未处理项">⟳ 刷新基线</button>
        <button class="mini" data-rv-act="report" title="导出完整审阅报告（快照/进度/每节点决定理由/变更记录/冲突）">⬇ 导出报告</button>
        <button class="mini" data-rv-act="close" title="关闭会话（数据保留，可随时恢复）">✕</button>
      </div>
      ${this._reviewFilterBanner(view, onlyFiltered)}
      ${this._reviewPolicyBanner(view)}
      ${this._reviewBaselineBanner(view)}
      ${this._reviewConflictBanner(view, conflict)}
      <div class="rv-progress">
        <span class="rv-pg-text">进度 <b>${p.done}/${p.total}</b>（${p.percent}%）· ✓ 通过 ${p.pass} · ✗ 驳回 ${p.reject} · ？待复核 ${p.review} · ○ 未处理 ${p.pending}</span>
        <div class="rv-bar big"><span class="rv-bar-fill ${p.complete ? 'full' : ''}" style="width:${p.total ? (p.done / p.total * 100) : 0}%"></span></div>
      </div>
      ${this._renderProposals(view, proposals)}
      <div class="rv-nodes">
        ${sess.nodes.map((sn) => this._reviewNodeHtml(view, sn, proposals)).join('')}
      </div>
      <details class="rv-history">
        <summary>决定变更记录（${this._changeLog(view).length}）与冲突记录（${sess.conflicts.length}，未决 ${sess.conflicts.filter((c) => !c.resolved).length}）</summary>
        ${this._renderHistory(view)}
      </details>
    </div>`;
  }

  _sessionMatchesCurrentFilter(view) {
    const a = view.session.filter || {};
    const b = this.wb.filter || {};
    return a.branchId === (b.branchId || null)
      && a.experimentId === (b.experimentId || null)
      && a.variantId === (b.variantId || null)
      && a.severity === (b.severity || 'all')
      && (a.text || '') === (b.text || '');
  }

  _reviewFilterBanner(view, matches) {
    if (matches) return '';
    const f = view.session.filter;
    const parts = [];
    const bid = this.store.branches.find((b) => b.id === f.branchId)?.name;
    if (f.branchId) parts.push(`分支「${bid || f.branchId}」`);
    if (f.experimentId) {
      const exp = this.store.experimentById(f.experimentId);
      parts.push(`实验「${exp?.name || f.experimentId}」`);
    }
    if (f.variantId) parts.push(`变体 ${f.variantId}`);
    if (f.severity && f.severity !== 'all') parts.push(`健康=${SEV_LABEL[f.severity] || f.severity}`);
    if (f.text) parts.push(`文本“${f.text}”`);
    return `<div class="rv-banner info">ℹ 本会话基于创建时筛选：${escapeHtml(parts.join(' · ') || '全部节点')}。上方时间线当前筛选已不同；审阅顺序始终以会话快照为准。
      <button class="mini" data-rv-act="apply-filter">恢复该筛选</button></div>`;
  }

  _reviewPolicyBanner(view) {
    const policy = normalizeReviewPolicy(view.session.policy);
    if (policy.mode !== 'signoff') return '';
    const rule = policy.completeRule === 'no-reject' ? '所有节点确认且最终无驳回' : '所有节点确认即可（允许驳回）';
    const me = (this.store.actor || '').trim();
    const allowed = me && policy.signers.includes(me);
    return `<div class="rv-banner info">🔐 多人签署：允许 <b>${policy.signers.map(escapeHtml).join('、')}</b>；
      每个节点需要 <b>${policy.required}</b> 个有效签名，完成条件：${escapeHtml(rule)}。
      重复签名幂等；漂移、推进或冲突后旧签名保留但立即失效。
      <span class="${allowed ? 'rv-ok' : 'rv-bad'}">当前署名：${escapeHtml(me || '未署名')}${allowed ? '（可签）' : '（不在名单）'}</span></div>`;
  }

  _reviewBaselineBanner(view) {
    if (!view.baselineChanged) return '';
    const newCount = view.newNodes.length;
    return `<div class="rv-banner warn">⚠ 筛选基线已变化：当前筛选结果与创建快照不一致${newCount ? `（含 ${newCount} 个新节点）` : ''}。
      节点损坏/缺失/指纹变化/分支推进的原决定已保留并转待复核；可「刷新基线」把新节点纳入会话（决定与变更历史不丢）。</div>`;
  }

  _reviewConflictBanner(view, conflict) {
    if (!conflict) return '';
    const map = {
      'review-advanced': `另一个窗口已在本会话提交决定（服务端 rev ${conflict.serverRev ?? '?'}）：本页提交被拒绝，本地决定保留在下方“待合并决定”，可逐项采用本地值或放弃。`,
      'review-fingerprint-changed': '提交节点的指纹已变化（快照被推进/篡改）：提交被拒绝（409），本地决定保留，可逐项合并到最新快照。',
      'review-node-missing': '提交节点已缺失：提交被拒绝（409），本地决定保留。',
      'review-branch-advanced': '提交节点所在分支已推进（支线事件）：提交被拒绝（409），本地决定保留，可逐项合并。',
    };
    return `<div class="rv-banner bad">⛔ 409 审阅冲突：${escapeHtml(map[conflict.reason] || conflict.reason)}
      ${conflict.nodeKey ? `节点 <code>${escapeHtml(conflict.nodeKey.slice(0, 40))}</code>` : ''}</div>`;
  }

  _renderProposals(view, proposals) {
    if (!proposals.length) return '';
    const byKey = new Map(view.session.nodes.map((n) => [n.key, n]));
    return `<div class="rv-proposals">
      <div class="rv-prop-h">待合并的本地决定（${proposals.length}，409 后保留，未写入会话）</div>
      ${proposals.map((p, i) => {
        const sn = byKey.get(p.nodeKey);
        const who = p.type === 'signature' ? escapeHtml(p.by || '未署名') : '';
        const kind = p.type === 'signature' ? '本地签名' : '本地决定';
        return `<div class="rv-prop" data-prop-idx="${i}">
          <span class="rv-prop-node">${escapeHtml(sn?.title || p.nodeKey)}</span>
          ${who ? `<span class="rv-prop-who">${who}</span>` : ''}
          <span class="rv-mark m-${p.decision === 'pass' ? 'pass' : p.decision === 'reject' ? 'reject' : 'review'}">${kind}：${DECISION_LABEL[p.decision]}</span>
          <span class="rv-prop-reason">${escapeHtml(p.reason || '（无理由）')}</span>
          <span class="spacer"></span>
          <button class="mini primary" data-rv-act="merge-prop" data-idx="${i}" title="以本地决定合并到最新快照（关闭该节点冲突）">采用本地</button>
          <button class="mini" data-rv-act="discard-prop" data-idx="${i}" title="放弃本地决定，使用服务端最新值">放弃</button>
        </div>`;
      }).join('')}
    </div>`;
  }

  _reviewNodeHtml(view, sn) {
    const policy = normalizeReviewPolicy(view.session.policy);
    const st = signatureState(sn, policy);
    const eff = sn.autoReview ? 'review' : st.decision;
    const live = view.byKey.get(sn.key);
    const driftCodes = view.driftByKey.get(sn.key) || [];
    const orderNum = String((sn.order ?? 0) + 1).padStart(3, '0');
    const badges = driftCodes.map((c) =>
      `<span class="wb-badge b-${c === 'node-missing' || c === 'corrupt' ? 'bad' : 'warn'}">${escapeHtml(DRIFT_TEXT[c] || c)}</span>`).join('');
    const historyNote = sn.history.length
      ? `<span class="rv-changed" title="决定被修改过 ${sn.history.length} 次">改 ${sn.history.length}</span>` : '';
    const currentFp = live ? (live.hashAfter || live.hashBefore || '—') : null;
    return `<div class="rv-node ${eff} ${sn.absent ? 'absent' : ''}" data-rv-node="${escapeHtml(sn.key)}">
      <div class="rvn-row1">
        <span class="rvn-order">${orderNum}</span>
        <span class="wb-kind ${sn.kind === 'experiment-variant' ? 'k-var' : 'k-ev'}">${sn.kind === 'experiment-variant' ? '实验' : KIND_LABEL[live?.eventKind] || '编辑'}</span>
        <span class="rvn-title">${escapeHtml(sn.title)}</span>
        ${sn.seqLabel ? `<span class="rvn-seq">${escapeHtml(sn.seqLabel)}</span>` : ''}
        ${historyNote}
        <span class="spacer"></span>
        <span class="rvn-fp" title="快照指纹 / 当前指纹">
          <code>${(sn.fingerprint || '—').slice(0, 8)}</code>${currentFp && currentFp !== sn.fingerprint ? ` → <code class="fp-drift">${currentFp.slice(0, 8)}</code>` : ''}
        </span>
      </div>
      ${badges ? `<div class="rvn-badges">${badges}</div>` : ''}
      <div class="rvn-decide">
        ${this._reviewDecisionControls(view, sn, st, eff)}
      </div>
      ${policy.mode === 'signoff' ? this._signatureListHtml(view, sn, st) : ''}
    </div>`;
  }

  _reviewDecisionControls(view, sn, st, eff) {
    const policy = normalizeReviewPolicy(view.session.policy);
    const disabled = sn.absent ? 'disabled' : '';
    const reasonVal = sn.autoReview ? '' : (st.reason || sn.reason || '');
    if (policy.mode !== 'signoff') {
      return `${DEC_BTN.map((b) =>
        `<button class="mini rv-dec ${b.cls} ${eff === b.d ? 'sel' : ''}" data-dec="${b.d}">${b.label}</button>`).join('')}
      <input class="rv-reason" type="text" maxlength="2000" placeholder="${
        sn.decision === 'pending' ? '审阅理由（驳回 / 待复核必填）' : '审阅理由（修改后回车或点决定按钮保存）'
      }" value="${escapeHtml(sn.reason || '')}" ${disabled} />
      <span class="rvn-who">${sn.decidedBy ? `${escapeHtml(sn.decidedBy)} · ${fmtTime(sn.decidedAt)}` : ''}</span>`;
    }
    const me = (this.store.actor || '').trim();
    const mine = st.active.find((s) => s.by === me);
    return `${DEC_BTN.map((b) =>
      `<button class="mini rv-dec ${b.cls} ${mine?.decision === b.d ? 'sel' : ''}" data-dec="${b.d}" ${disabled}>${b.label}</button>`).join('')}
      <input class="rv-reason" type="text" maxlength="2000" placeholder="本次签名理由（驳回 / 待复核必填）" value="${escapeHtml(mine?.reason || '')}" ${disabled} />
      <button class="mini primary rv-sign" data-sign="sign" ${me && !sn.absent ? '' : 'disabled'}
        title="${me ? '用当前署名单独签名确认所选决定' : '请先在审计页填写操作者署名'}">✍ 签名确认</button>
      <span class="rvn-who">${st.confirmed ? `已确认 ${st.active.length}/${policy.required}` : `待签名 ${st.active.length}/${policy.required}`}</span>`;
  }

  _signatureListHtml(view, sn, st) {
    const policy = normalizeReviewPolicy(view.session.policy);
    const activeIds = new Set(st.active.map((s) => s.id));
    const rows = (sn.signatures || []).slice().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)).map((sg) => {
      const valid = !sg.invalid;
      return `<li class="${valid ? 'sig-ok' : 'sig-bad'}" title="${valid ? '有效签名' : escapeHtml(sg.invalid?.reason || '签名已失效')}">
        <b>${escapeHtml(sg.by)}</b> · ${DECISION_LABEL[sg.decision]} · ${fmtTime(sg.at)}
        ${sg.reason ? ` · ${escapeHtml(sg.reason)}` : ''}
        ${valid ? '<span class="rv-ok">有效</span>' : `<span class="rv-bad">已失效：${escapeHtml(sg.invalid?.code || 'invalid')}</span>`}
      </li>`;
    }).join('');
    const unsigned = policy.signers.filter((name) => !st.active.some((s) => s.by === name));
    return `<div class="rv-signatures">
      <div class="rv-sig-h">签名明细：已签 ${st.active.length}/${policy.required}；未签 ${unsigned.map(escapeHtml).join('、') || '无'}</div>
      <ul class="rv-sig-list">${rows || '<li class="rv-none">还没有签名。</li>'}</ul>
    </div>`;
  }

  _signNode(sid, key, action) {
    const view = this.store.reviewView(sid);
    const sn = view?.session.nodes.find((n) => n.key === key);
    if (!sn) return;
    const policy = normalizeReviewPolicy(view.session.policy);
    const me = (this.store.actor || '').trim();
    if (!me) { this.hooks.toast('请先在审计页填写操作者署名，再签名确认', 'warn'); return; }
    if (!isAllowedSigner(policy, me)) {
      this.hooks.toast(`当前署名「${me}」不在本节点允许名单：${policy.signers.join('、')}`, 'error');
      return;
    }
    const nodeEl = this.$reviews.querySelector(`[data-rv-node="${CSS.escape(key)}"]`);
    const decision = nodeEl?.dataset.draftDecision
      || activeSignatures(sn).find((s) => s.by === me)?.decision
      || nodeEl?.querySelector('[data-dec].sel')?.dataset.dec;
    if (!decision) { this.hooks.toast('请先选择 通过 / 驳回 / 待复核，再签名确认', 'warn'); return; }
    const input = nodeEl?.querySelector('.rv-reason');
    const reason = input ? input.value : '';
    if ((decision === 'reject' || decision === 'review') && !String(reason || '').trim()) {
      this.hooks.toast('驳回 / 待复核签名必须填写理由', 'warn');
      input?.focus();
      return;
    }
    const res = this.store.submitReviewSignature(sid, key, decision, reason);
    if (res.ok) {
      this.hooks.toast(res.idempotent ? '签名已存在：幂等返回，未重复写入' : `已由 ${me} 单独签名确认`);
      return;
    }
    if (res.status === 403) {
      this.hooks.toast(`签名被拒绝：不在允许名单（${(res.allowed || []).join('、')}）`, 'error');
      return;
    }
    if (res.status === 409) {
      const text = {
        'review-advanced': '另一窗口已推进本会话（409）：本地签名已保留，可在待合并区逐项合入',
        'baseline-changed': '筛选基线已变化（409）：本地签名已保留，请刷新基线或逐项合并',
        'node-missing': '节点已缺失（409）：本地签名已保留，可刷新基线后处理',
        corrupt: '节点已损坏（409）：本地签名已保留，需重新核对后再签',
        'fingerprint-changed': '节点指纹已变化（409）：本地签名已保留，请重新签署最新快照',
        'branch-advanced': '分支已推进（409）：本地签名已保留，请重新签署',
      }[res.reason] || `409 冲突：${res.reason}`;
      this.hooks.toast(text, 'error');
      return;
    }
    this.hooks.toast(res.error || '签名失败', 'error');
  }

  _decide(sid, key, decision, { force = false } = {}) {
    const view = this.store.reviewView(sid);
    const sn = view?.session.nodes.find((n) => n.key === key);
    if (!sn) return;
    const input = this.$reviews.querySelector(`[data-rv-node="${CSS.escape(key)}"] .rv-reason`);
    const reason = input ? input.value : sn.reason;
    if ((decision === 'reject' || decision === 'review') && !String(reason || '').trim()) {
      this.hooks.toast('驳回 / 待复核必须填写理由', 'warn');
      input?.focus();
      return;
    }
    const res = this.store.submitReviewDecision(sid, key, decision, reason);
    if (res.ok) {
      this.hooks.toast(`已记录：${DECISION_LABEL[decision]}（决定变更历史已追加，会话快照已保存）`);
      return;
    }
    if (res.status === 409) {
      const text = {
        'review-advanced': '该会话已在另一窗口前进（409）：本地决定已保留，可在下方逐项合并',
        'baseline-changed': '筛选基线已变化（409）：请先“刷新基线”，或在待合并区逐项合并',
        'node-missing': '节点已缺失（409）：原决定保留并已转待复核；请刷新基线后处理',
        corrupt: '节点已损坏（409）：原决定保留并已转待复核，可在待合并区以最新快照逐项合并',
        'fingerprint-changed': '节点指纹已变化（409）：原决定保留并已转待复核，可逐项合并到最新快照',
        'branch-advanced': '分支已推进（409）：原决定保留并已转待复核，可逐项合并',
      }[res.reason] || `409 冲突：${res.reason}`;
      this.hooks.toast(text, 'error');
      return;
    }
    this.hooks.toast(res.error || '提交失败', 'error');
  }

  _reviewAction(act, btn, sid) {
    const s = this.store;
    if (act === 'close') { s.selectReview(null); return; }
    if (act === 'complete') {
      const res = s.completeReview(sid);
      if (!res.ok) { this.hooks.toast(res.error, 'warn'); return; }
      this.hooks.toast('审阅会话已标记完成（可随时重开）');
      return;
    }
    if (act === 'reopen') { s.reopenReview(sid); this.hooks.toast('会话已重开'); return; }
    if (act === 'rebase') {
      const res = s.rebaseReview(sid);
      if (!res.ok) { this.hooks.toast(res.error, 'error'); return; }
      this.hooks.toast(`已按最新筛选重建基线：决定与变更记录全部保留，新增 ${res.added} 个未处理节点`);
      return;
    }
    if (act === 'report') { this._exportReviewReport(sid); return; }
    if (act === 'apply-filter') {
      const sess = s.reviewSessionById(sid);
      if (sess) {
        s.setWorkbench({ filter: { ...sess.filter }, playing: false });
        this.hooks.toast('已恢复会话创建时的筛选条件');
      }
      return;
    }
    if (act === 'merge-prop' || act === 'discard-prop') {
      const idx = Number(btn.dataset.idx);
      const proposals = s.reviewProposals(sid);
      const p = proposals[idx];
      if (!p) return;
      if (act === 'discard-prop') {
        s.discardReviewProposal(sid, p.nodeKey, { signatureId: p.sig?.id || null });
        this.hooks.toast('已放弃该本地决定（采用服务端最新值）');
      } else {
        const res = s.mergeReviewItem(sid, p.nodeKey, p.decision, p.reason, { proposal: p, by: p.by });
        if (!res.ok) { this.hooks.toast(res.error || '合并失败', 'error'); return; }
        this.hooks.toast(`已把本地「${DECISION_LABEL[p.decision]}」合并到最新快照（冲突记录已关闭）`);
      }
    }
  }

  _changeLog(view) {
    const out = [];
    for (const sn of view.session.nodes) {
      for (const h of sn.history) out.push({ key: sn.key, title: sn.title, ...h });
    }
    return out.sort((a, b) => (a.at - b.at) || (a.key < b.key ? -1 : 1));
  }

  _renderHistory(view) {
    const sess = view.session;
    const log = this._changeLog(view);
    const logHtml = log.length ? log.map((h) => `
      <li>${fmtTime(h.at)} · ${escapeHtml(h.by)} · ${escapeHtml(h.title)}：
        ${DECISION_LABEL[h.from] || '未处理'} → <b>${DECISION_LABEL[h.to]}</b>${h.merged ? '（逐项合并）' : ''}
        ${h.reason ? ` · 理由：${escapeHtml(h.reason)}` : ''}</li>`).join('')
      : '<li class="rv-none">还没有决定变更。</li>';
    const confHtml = sess.conflicts.length ? sess.conflicts.map((c) => `
      <li class="${c.resolved ? 'resolved' : ''}">${fmtTime(c.at)} ·
        ${c.nodeKey ? `<code>${escapeHtml(c.nodeKey.slice(0, 36))}</code> · ` : ''}
        ${escapeHtml(c.text)}
        ${c.resolved ? ` <b class="rv-ok">已解决（${escapeHtml(c.resolution || '')} · ${fmtTime(c.resolvedAt)}）</b>` : '<b class="rv-bad">未决</b>'}</li>`).join('')
      : '<li class="rv-none">没有冲突记录。</li>';
    return `<div class="rv-hist-col"><div class="rv-sub-h">决定变更</div><ol class="rv-log">${logHtml}</ol></div>
      <div class="rv-hist-col"><div class="rv-sub-h">冲突记录</div><ol class="rv-log">${confHtml}</ol></div>`;
  }

  _exportReviewReport(sid) {
    const report = this.store.reviewReport(sid);
    if (!report) { this.hooks.toast('会话不存在', 'error'); return; }
    const text0 = stableStringify(report);
    const doc = { ...report, contentChecksum: exportChecksum(text0) };
    const text = stableStringify(doc);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    a.href = url;
    a.download = `review-report-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    this.hooks.toast(`已导出完整审阅报告（${report.progress.total} 节点 / 变更 ${report.changeLog.length} / 冲突 ${report.conflicts.length} / 校验和 ${doc.contentChecksum}）`);
  }

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
