/*
 * 影响分析与安全变更工作台面板：
 * - 从当前画布选中的矩形 / 约束发起分析：沿约束关系展开直接 / 间接受影响的矩形、约束与分支结果；
 * - 把 删除矩形 / 移动或改尺寸矩形 / 删除约束 / 修改约束参数 作为一组候选变更先模拟，
 *   明确显示位置变化、冲突链、循环依赖与越界风险；
 * - 候选变更绑定分析时的文档版本；应用前分支已前进 -> 版本冲突，候选保留；
 *   确认后一次性写入审计事件；重复提交幂等；应用失败不留部分修改；
 * - 查看分析快照、逐项放弃候选、放弃整组、导出影响报告；快照 / 候选 / 冲突 / 事件 / 报告随文档持久化。
 */

import { escapeHtml, diffHtml } from './diff.js';

const KIND_LABEL = {
  snap: '贴齐', minGap: '最小间距', contain: '画布包含', lock: '锁定尺寸',
};
const REL_LABEL = { seed: '种子', direct: '直接', indirect: '间接' };
const CHANGE_LABEL = {
  'delete-rect': '删除矩形',
  'move-rect': '移动/改尺寸',
  'delete-constraint': '删除约束',
  'modify-constraint': '修改约束参数',
};

export class ImpactPanel {
  constructor(store, hooks) {
    this.store = store;
    this.hooks = hooks; // { toast, getSelectedRectIds, getSelectedConstraintId }
    this.$body = document.querySelector('[data-body="impact"]');
    this.$count = document.querySelector('#impact-count');
    this.expandedBranches = new Set();
    this._buildSkeleton();
    this.$seedRect = this.$body.querySelector('#ia-seed-rect');
    this.$seedCons = this.$body.querySelector('#ia-seed-cons');
    this.$name = this.$body.querySelector('#ia-name');
    this.$start = this.$body.querySelector('#ia-start');
    this.$work = this.$body.querySelector('#ia-active');
    this.$snaps = this.$body.querySelector('#ia-snapshots');

    this.$start.onclick = () => this.startAnalysis();
    store.addEventListener('impact', () => this.render());
    store.addEventListener('change', () => this.render());
    store.addEventListener('branch', () => this.render());
    store.addEventListener('load', () => this.render());
  }

  _toast(text, level = '') { this.hooks.toast(text, level); }

  _buildSkeleton() {
    this.$body.innerHTML = `
      <div class="ia-start">
        <div class="note" style="margin:0 0 10px">
          选中一个<b>矩形</b>或<b>约束</b>后开始分析：系统沿约束依赖（跟随 ⇄ 锚点）展开直接与间接受影响的
          矩形、约束与每条传播分支的结果。可再把<b>删除 / 移动 / 修改参数</b>组成候选变更先做模拟，
          位置变化、冲突链、循环依赖与越界风险一次性给出。候选绑定分析时的文档版本，分支前进后应用会返回
          版本冲突且候选保留；确认应用只写一条审计事件，重复提交不产生重复事件。
        </div>
        <div class="ia-pick">
          <label>种子矩形<select id="ia-seed-rect"></select></label>
          <label>或种子约束<select id="ia-seed-cons"></select></label>
        </div>
        <div class="ia-pick">
          <label class="grow">快照名称（可留空）<input id="ia-name" type="text" maxlength="60" placeholder="如：下移卡片A 的影响评估" /></label>
          <button id="ia-start" class="primary">🔬 分析影响面并创建快照</button>
        </div>
        <div id="ia-quick" class="ia-quick"></div>
      </div>
      <div id="ia-active"></div>
      <h4 class="ver-h">分析快照（随文档持久化）</h4>
      <div id="ia-snapshots" class="list"></div>`;
  }

  /* ---------------- 发起分析 ---------------- */

  startAnalysis() {
    const s = this.store;
    if (s.replaying) { this._toast('回放模式为只读，请先退出回放', 'warn'); return; }
    let seed = null;
    const selRects = (this.hooks.getSelectedRectIds?.() || []);
    if (selRects.length) seed = { kind: 'rect', id: selRects[0] };
    else if (this.$seedCons.value) seed = { kind: 'constraint', id: this.$seedCons.value };
    else if (this.$seedRect.value) seed = { kind: 'rect', id: this.$seedRect.value };
    if (!seed) { this._toast('请先在画布上选择一个矩形，或在下拉里选择一个约束', 'warn'); return; }
    const res = s.createImpactAnalysis(seed, { name: this.$name.value.trim() });
    if (!res.ok) { this._toast(res.error, 'error'); return; }
    this.$name.value = '';
    this._toast(res.reused ? '已存在同内容的分析快照，已为你打开' : '影响分析快照已创建（绑定当前文档版本与分支 head）');
    this.render();
  }

  /* ---------------- 渲染 ---------------- */

  render() {
    const s = this.store;
    if (!this.$body.isConnected) return;
    // 种子下拉
    const rects = [...(s.model?.rects || [])].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id, 'zh'));
    const cons = [...(s.model?.constraints || [])].sort((a, b) => (a.id < b.id ? -1 : 1));
    const rectName = new Map((s.model?.rects || []).map((r) => [r.id, r.name || r.id]));
    const selRects = this.hooks.getSelectedRectIds?.() || [];
    const curRect = this.$seedRect.value || selRects[0] || '';
    this.$seedRect.innerHTML = '<option value="">— 选择矩形 —</option>' +
      rects.map((r) => `<option value="${r.id}" ${r.id === curRect ? 'selected' : ''}>${escapeHtml(r.name || r.id)}</option>`).join('');
    const curCons = this.$seedCons.value || '';
    this.$seedCons.innerHTML = '<option value="">— 选择约束 —</option>' +
      cons.map((c) => `<option value="${c.id}" ${c.id === curCons ? 'selected' : ''}>${escapeHtml((KIND_LABEL[c.kind] || c.kind) + ' ' + consLabel(c, rectName))}</option>`).join('');

    // 快捷候选：对当前选中矩形直接构造一组常用候选
    this._renderQuick(selRects[0]);

    const n = s.impactSnapshots.length;
    const openN = s.impactSnapshots.filter((x) => x.status === 'open').length;
    this.$count.textContent = n;
    this.$count.classList.toggle('zero', n === 0);
    this.$count.title = `${openN} 个进行中 / ${n} 个分析快照`;

    this._renderActive();
    this._renderSnapshotList();
  }

  _renderQuick(rectId) {
    const host = this.$body.querySelector('#ia-quick');
    const s = this.store;
    if (!rectId) { host.innerHTML = '<span class="ia-hint">提示：先在画布选中一个矩形，再点上面的按钮；也可以在快照里逐项添加候选变更。</span>'; return; }
    const r = s.model.rects.find((x) => x.id === rectId);
    if (!r) { host.innerHTML = ''; return; }
    host.innerHTML = `
      <span class="ia-hint">对选中矩形「${escapeHtml(r.name || r.id)}」快速创建候选：</span>
      <button class="mini" data-q="del">删除矩形（级联约束）</button>
      <button class="mini" data-q="left">左移 40</button>
      <button class="mini" data-q="down">下移 40</button>
      <button class="mini" data-q="up">上移 40</button>`;
    host.querySelectorAll('button[data-q]').forEach((b) => {
      b.onclick = () => {
        let changes = null;
        if (b.dataset.q === 'del') changes = [{ kind: 'delete-rect', rectId }];
        else {
          const dx = b.dataset.q === 'left' ? -40 : 0;
          const dy = b.dataset.q === 'down' ? 40 : b.dataset.q === 'up' ? -40 : 0;
          changes = [{ kind: 'move-rect', rectId, x: Math.round(r.x + dx), y: Math.round(r.y + dy) }];
        }
        const res = s.createImpactAnalysis({ kind: 'rect', id: rectId }, { changes });
        if (!res.ok) { this._toast(res.error, 'error'); return; }
        this._toast(`已创建带 ${changes.length} 项候选变更的分析快照`);
        this.render();
      };
    });
  }

  _renderActive() {
    const snap = this.store.activeImpact;
    if (!snap) { this.$work.innerHTML = ''; return; }
    if (snap.status === 'applied') return this._renderApplied(snap);
    if (snap.status === 'abandoned') return this._renderClosed(snap, '已放弃');
    this._renderOpen(snap);
  }

  _renderOpen(snap) {
    const s = this.store;
    const advanced = s.impactBranchAdvanced(snap);
    const conflict = snap.conflict || (advanced ? {
      reason: 'impact-branch-advanced',
      headEventId: s.branches.find((b) => b.id === snap.branchId)?.headEventId,
    } : null);
    const sim = snap.changes.length ? snap.simulation : null;
    const impact = snap.impact;

    this.$work.innerHTML = `
      <div class="ia-card">
        <div class="ia-head">
          <b>🔬 ${escapeHtml(snap.name)}</b>
          <span class="ia-seed">种子：${escapeHtml(seedText(snap))}</span>
          <span class="spacer"></span>
          <button class="mini" data-act="close">关闭</button>
          <button class="mini" data-act="abandon">放弃分析</button>
        </div>
        <div class="ia-base">
          绑定版本：分支「${escapeHtml(snap.branchName || snap.branchId)}」#${this._baseSeq(snap)}
          · 基线指纹 <code>${(snap.baseHash || '').slice(0, 8)}</code> · 文档 rev ${snap.docRev}
          ${snap.branchId !== s.currentBranchId ? '<span class="ia-warn">（快照在另一分支上）</span>' : ''}
        </div>
        ${conflict ? this._conflictBanner(snap, conflict) : ''}
        <div class="ia-sum">
          <span>受影响矩形 <b>${impact.counts.rects}</b>（直接 ${impact.counts.rectsDirect} / 间接 ${impact.counts.rectsIndirect}）</span>
          <span>受影响约束 <b>${impact.counts.constraints}</b>（直接 ${impact.counts.constraintsDirect}）</span>
          <span>传播分支 <b>${impact.counts.branches}</b></span>
          ${sim ? `<span class="${sim.ok ? 'ia-ok' : 'ia-bad'}">候选 ${sim.changes.length} 项${sim.ok ? ' · 模拟通过' : ` · ${sim.errors.length} 个阻断`}</span>` : ''}
          <span class="spacer"></span>
          <button class="mini" data-act="report">⬇ 导出影响报告</button>
          <button class="primary" data-act="apply" ${conflict || (sim && !sim.ok) ? 'disabled' : ''}>✓ 应用候选变更（一次审计事件）</button>
        </div>
        <div id="ia-blockers"></div>
        <div id="ia-candidates"></div>
        <div id="ia-addc"></div>
        <details class="ia-details" open><summary>位置变化（模拟求解后）</summary><div id="ia-moves"></div></details>
        <details class="ia-details"><summary>受影响矩形与约束（${impact.counts.rects + impact.counts.constraints}）</summary><div id="ia-affected"></div></details>
        <details class="ia-details"><summary>传播分支与分支结果（${impact.counts.branches}）</summary><div id="ia-branches"></div></details>
        <details class="ia-details" ${sim ? 'open' : ''}><summary>差异报告（基线 → 模拟结果）</summary><div id="ia-diff"></div></details>
      </div>`;

    this._renderBlockers(this.$work.querySelector('#ia-blockers'), sim);
    this._renderCandidates(this.$work.querySelector('#ia-candidates'), snap, sim);
    this._renderAddCandidate(this.$work.querySelector('#ia-addc'), snap);
    this._renderMoves(this.$work.querySelector('#ia-moves'), snap, sim);
    this._renderAffected(this.$work.querySelector('#ia-affected'), impact, sim);
    this._renderBranches(this.$work.querySelector('#ia-branches'), snap, impact);
    this._renderDiff(this.$work.querySelector('#ia-diff'), snap, sim);

    this.$work.querySelector('[data-act=close]').onclick = () => { s.selectImpact(null); this.render(); };
    this.$work.querySelector('[data-act=abandon]').onclick = () => {
      if (!confirm('放弃这张分析快照？候选变更与模拟结果将标记为放弃（审计事件不受影响）。')) return;
      s.abandonImpact(snap.id);
      this._toast('分析快照已放弃');
    };
    this.$work.querySelector('[data-act=report]').onclick = () => this.exportReport(snap.id);
    this.$work.querySelector('[data-act=apply]').onclick = () => this.apply(snap.id);
  }

  _conflictBanner(snap, conflict) {
    const seq = conflict.headSeq ?? this._headSeq(snap.branchId, conflict.headEventId);
    return `<div class="ia-conflict-banner">
      ⚠ <b>版本冲突</b>：分析绑定的分支已前进${seq ? `到 #${seq}` : ''}（候选仍绑定分析时版本）。
      候选变更<b>原样保留</b>、未做任何修改；请基于最新版本重新分析，或切换到该分支查看。
      ${conflict.at ? `<span class="ia-hint">冲突于 ${new Date(conflict.at).toLocaleString()} 记录</span>` : ''}
    </div>`;
  }

  _renderBlockers(host, sim) {
    if (!sim || sim.ok) { host.innerHTML = ''; return; }
    host.innerHTML = sim.errors.map((e) => {
      if (e.code === 'cycle') {
        const cyc = e.detail || sim.cycle;
        return `<div class="ia-block ia-cycle">🔁 <b>循环依赖</b>：${escapeHtml(e.message)}
          ${cyc ? `<div class="ia-chain">${cyc.nodeIds.map(escapeHtml).join(' → ')}</div>` : ''}</div>`;
      }
      if (e.code === 'out-of-bounds') {
        return `<div class="ia-block ia-oob">⛔ <b>越界风险</b>：${escapeHtml(e.message)}</div>`;
      }
      return `<div class="ia-block ia-err">✗ ${escapeHtml(e.message)}</div>`;
    }).join('');
  }

  _renderCandidates(host, snap, sim) {
    const s = this.store;
    const rectName = new Map(snap.baseModel.rects.map((r) => [r.id, r.name || r.id]));
    if (!snap.changes.length) {
      host.innerHTML = '<div class="ia-empty">还没有候选变更 —— 仅查看影响面，或在下面添加候选后先模拟。</div>';
      return;
    }
    host.innerHTML = `<div class="ia-clist-title">候选变更（${snap.changes.length}；绑定分析时版本，可逐项放弃）</div>` +
      snap.changes.map((ch, i) => {
        const removed = sim?.removedConstraintIds || [];
        const deleted = sim?.deletedRects || [];
        let detail = '';
        if (ch.kind === 'delete-rect') detail = `矩形「${rectName.get(ch.rectId) || ch.rectId}」${deleted.includes(ch.rectId) ? '（模拟中已删除）' : ''}`;
        else if (ch.kind === 'move-rect') {
          detail = `矩形「${rectName.get(ch.rectId) || ch.rectId}」→ ` +
            ['x', 'y', 'w', 'h'].filter((f) => f in ch).map((f) => `${f.toUpperCase()}=${ch[f]}`).join('，');
        } else if (ch.kind === 'delete-constraint') {
          detail = `约束 ${ch.constraintId}${removed.includes(ch.constraintId) ? '（模拟中已删除）' : ''}`;
        } else {
          detail = `约束 ${ch.constraintId}：` + Object.entries(ch.params || {}).map(([k, v]) => `${k}=${v}`).join('，')
            + (ch.enabled !== undefined ? `；启用=${ch.enabled ? '是' : '否'}` : '');
        }
        return `<div class="ia-citem">
          <span class="ia-ckind">${CHANGE_LABEL[ch.kind] || ch.kind}</span>
          <span class="ia-cdesc">${escapeHtml(detail)}</span>
          <span class="spacer"></span>
          <button class="mini danger" data-i="${i}">放弃此项</button>
        </div>`;
      }).join('');
    host.querySelectorAll('button[data-i]').forEach((b) => {
      b.onclick = () => {
        const ch = snap.changes[Number(b.dataset.i)];
        const res = s.discardImpactChange(snap.id, ch.id);
        if (!res.ok) { this._toast(res.error, 'error'); return; }
        this._toast(`已放弃候选「${CHANGE_LABEL[ch.kind]}」，已重新模拟`);
        this.render();
      };
    });
  }

  _renderAddCandidate(host, snap) {
    const s = this.store;
    const rectName = new Map(snap.baseModel.rects.map((r) => [r.id, r.name || r.id]));
    const rectOpts = snap.baseModel.rects.map((r) => `<option value="${r.id}">${escapeHtml(r.name || r.id)}</option>`).join('');
    const cons = snap.baseModel.constraints;
    const consOpts = cons.map((c) => `<option value="${c.id}">${escapeHtml(c.id)} · ${escapeHtml(consLabel(c, rectName))}</option>`).join('');
    host.innerHTML = `
      <details class="ia-details"><summary>＋ 添加候选变更（删除 / 移动 / 改参数，添加后立即重新模拟）</summary>
        <div class="ia-add">
          <select id="ia-add-kind">
            <option value="move-rect">移动 / 改尺寸矩形</option>
            <option value="delete-rect">删除矩形（级联其约束）</option>
            <option value="modify-constraint">修改约束参数</option>
            <option value="delete-constraint">删除约束</option>
          </select>
          <select id="ia-add-rect">${rectOpts}</select>
          <select id="ia-add-cons" class="hidden">${consOpts}</select>
          <span id="ia-rect-fields" class="ia-fields">
            <input type="number" id="ia-f-x" placeholder="X（留空不变）" title="新 X" />
            <input type="number" id="ia-f-y" placeholder="Y（留空不变）" title="新 Y" />
            <input type="number" id="ia-f-w" placeholder="宽（留空不变）" min="1" />
            <input type="number" id="ia-f-h" placeholder="高（留空不变）" min="1" />
          </span>
          <span id="ia-cons-fields" class="ia-fields hidden">
            <input type="number" id="ia-f-prio" placeholder="优先级 1-999" min="1" max="999" />
            <input type="number" id="ia-f-gap" placeholder="间距/偏移（留空不变）" step="1" />
            <input type="number" id="ia-f-margin" placeholder="画布边距（留空不变）" min="0" step="1" />
            <input type="number" id="ia-f-lw" placeholder="锁定宽（留空不变）" min="1" />
            <input type="number" id="ia-f-lh" placeholder="锁定高（留空不变）" min="1" />
            <select id="ia-f-en"><option value="">启用（不变）</option><option value="true">启用</option><option value="false">停用</option></select>
          </span>
          <button class="mini primary" id="ia-add-ok">添加并模拟</button>
        </div>
      </details>`;
    const kindSel = host.querySelector('#ia-add-kind');
    const rectSel = host.querySelector('#ia-add-rect');
    const consSel = host.querySelector('#ia-add-cons');
    const rectFields = host.querySelector('#ia-rect-fields');
    const consFields = host.querySelector('#ia-cons-fields');
    const syncConsFields = () => {
      const c = snap.baseModel.constraints.find((x) => x.id === consSel.value);
      const showGap = c && (c.kind === 'snap' || c.kind === 'minGap');
      const showMargin = c?.kind === 'contain';
      const showLock = c?.kind === 'lock';
      consFields.querySelector('#ia-f-gap').classList.toggle('hidden', !showGap);
      consFields.querySelector('#ia-f-margin').classList.toggle('hidden', !showMargin);
      consFields.querySelector('#ia-f-lw').classList.toggle('hidden', !showLock);
      consFields.querySelector('#ia-f-lh').classList.toggle('hidden', !showLock);
    };
    kindSel.onchange = () => {
      const isRect = kindSel.value.includes('rect');
      rectSel.classList.toggle('hidden', !isRect);
      consSel.classList.toggle('hidden', isRect);
      rectFields.classList.toggle('hidden', !(isRect && kindSel.value === 'move-rect'));
      consFields.classList.toggle('hidden', kindSel.value !== 'modify-constraint');
      if (kindSel.value === 'modify-constraint') syncConsFields();
    };
    consSel.onchange = syncConsFields;
    host.querySelector('#ia-add-ok').onclick = () => {
      const kind = kindSel.value;
      let ch = null;
      if (kind === 'delete-rect') ch = { kind, rectId: rectSel.value };
      else if (kind === 'move-rect') {
        ch = { kind, rectId: rectSel.value };
        for (const [f, id] of [['x', 'ia-f-x'], ['y', 'ia-f-y'], ['w', 'ia-f-w'], ['h', 'ia-f-h']]) {
          const el = host.querySelector('#' + id);
          if (el.value !== '') ch[f] = Number(el.value);
        }
      } else if (kind === 'delete-constraint') {
        ch = { kind, constraintId: consSel.value };
      } else {
        const params = {};
        const prio = host.querySelector('#ia-f-prio');
        if (prio.value !== '') params.priority = Math.min(999, Math.max(1, Math.round(Number(prio.value))));
        const c = snap.baseModel.constraints.find((x) => x.id === consSel.value);
        const numField = (id) => host.querySelector('#' + id).value;
        const gap = numField('ia-f-gap');
        if (gap !== '' && c && (c.kind === 'snap' || c.kind === 'minGap')) params.gap = Number(gap);
        const margin = numField('ia-f-margin');
        if (margin !== '' && c?.kind === 'contain') params.margin = Math.max(0, Number(margin));
        const lw = numField('ia-f-lw');
        const lh = numField('ia-f-lh');
        if (c?.kind === 'lock') {
          if (lw !== '') params.w = Math.max(1, Number(lw));
          if (lh !== '') params.h = Math.max(1, Number(lh));
        }
        const en = host.querySelector('#ia-f-en').value;
        ch = { kind, constraintId: consSel.value, params, ...(en ? { enabled: en === 'true' } : {}) };
      }
      const res = s.updateImpactCandidates(snap.id, [...snap.changes, ch]);
      if (!res.ok) { this._toast(res.error, 'error'); return; }
      this._toast(`候选已添加（共 ${res.snapshot.changes.length} 项），已重新模拟`);
      this.render();
    };
  }

  _renderMoves(host, snap, sim) {
    if (!sim) { host.innerHTML = '<div class="ia-empty">添加候选变更后，这里给出模拟求解后的位置变化。</div>'; return; }
    const d = sim.diff;
    if (!d) { host.innerHTML = '<div class="ia-empty">无法计算差异。</div>'; return; }
    const rows = [];
    for (const m of d.rects.moved) rows.push(`<div class="diff-item mod">↔ 「${escapeHtml(m.name)}」(${Math.round(m.from.x)},${Math.round(m.from.y)}) → (${Math.round(m.to.x)},${Math.round(m.to.y)}) Δ(${Math.round(m.to.x - m.from.x)},${Math.round(m.to.y - m.from.y)})</div>`);
    for (const rz of d.rects.resized) rows.push(`<div class="diff-item mod">⤢ 「${escapeHtml(rz.name)}」${Math.round(rz.from.w)}×${Math.round(rz.from.h)} → ${Math.round(rz.to.w)}×${Math.round(rz.to.h)}</div>`);
    for (const rm of d.rects.removed) rows.push(`<div class="diff-item del">－ 删除「${escapeHtml(rm.name)}」（其约束随级联一并移除 ${sim.removedConstraintIds.length} 条）</div>`);
    host.innerHTML = rows.join('') || '<div class="diff-none">矩形位置 / 尺寸无变化（约束传播未移动任何矩形）。</div>';
    // 越界矩形单独高亮
    if (sim.boundsAfter.length) {
      host.innerHTML += sim.boundsAfter.map((b) =>
        `<div class="diff-item del">⛔ 越界：「${escapeHtml(b.name || b.id)}」求解后超出画布 (${Math.round(b.rect.x)},${Math.round(b.rect.y)} ${Math.round(b.rect.w)}×${Math.round(b.rect.h)})</div>`).join('');
    }
  }

  _renderAffected(host, impact, sim) {
    const simConflictIds = new Set((sim?.report?.conflicts || []).map((c) => c.cid));
    const rectRows = impact.rects.map((r) => {
      const tag = r.relation === 'seed' ? '<span class="ia-tag seed">种子</span>'
        : r.relation === 'direct' ? '<span class="ia-tag direct">直接</span>'
        : '<span class="ia-tag indirect">间接</span>';
      const state = r.deleted ? '<span class="ia-state del">模拟后删除</span>'
        : r.outOfBounds ? '<span class="ia-state oob">越界</span>'
        : r.moved ? '<span class="ia-state moved">位置变化</span>' : '';
      return `<tr><td>${tag}</td><td>${escapeHtml(r.name)}</td><td>${r.distance ?? ''}</td><td>${state}</td>
        <td class="ia-pos">${r.from ? `(${Math.round(r.from.x)},${Math.round(r.from.y)})` : ''}${r.to && r.moved ? ` → (${Math.round(r.to.x)},${Math.round(r.to.y)})` : ''}</td></tr>`;
    }).join('');
    const consRows = impact.constraints.map((c) => {
      const tag = c.relation === 'direct' ? '<span class="ia-tag direct">直接</span>' : '<span class="ia-tag indirect">间接</span>';
      let state = '';
      if (c.removed) state = '<span class="ia-state del">模拟中删除</span>';
      else if (c.conflict || simConflictIds.has(c.id)) state = '<span class="ia-state oob">模拟后未满足</span>';
      else if (c.before && c.after && (c.before.satisfied !== c.after.satisfied)) {
        state = c.after.satisfied ? '<span class="ia-state ok">变为满足</span>' : '<span class="ia-state oob">变为未满足</span>';
      }
      return `<tr><td>${tag}</td><td>${escapeHtml(c.label)}</td><td>${c.enabled ? '启用' : '停用'}</td><td>${state}</td>
        <td>${c.before ? `偏差 ${Math.abs(c.before.measure).toFixed(1)}` : ''}${c.after ? ` → ${Math.abs(c.after.measure).toFixed(1)}` : ''}</td></tr>`;
    }).join('');
    host.innerHTML = `
      <table class="ia-table"><thead><tr><th></th><th>矩形</th><th>距离</th><th>模拟结果</th><th>位置</th></tr></thead><tbody>${rectRows}</tbody></table>
      <table class="ia-table"><thead><tr><th></th><th>约束</th><th>状态</th><th>模拟结果</th><th>偏差</th></tr></thead><tbody>${consRows}</tbody></table>`;
  }

  _renderBranches(host, snap, impact) {
    if (!impact.branches.length) { host.innerHTML = '<div class="ia-empty">没有可展开的传播分支（种子矩形没有出向 / 入向约束边）。</div>'; return; }
    host.innerHTML = impact.branches.map((b, bi) => {
      const cls = b.anyOutOfBounds ? 'ia-branch bad' : b.anyConflict ? 'ia-branch warn' : b.anyMoved ? 'ia-branch moved' : 'ia-branch idle';
      const chain = b.nodes.map((n) => {
        const arrow = n.via ? ` <span class="ia-via" title="沿约束 ${n.via.cid}（${n.via.axis} 轴）">—${n.via.axis}→</span> ` : '';
        const state = n.deleted ? '<span class="ia-state del">删</span>'
          : n.outOfBounds ? '<span class="ia-state oob">越界</span>'
          : n.conflictCids.length ? `<span class="ia-state oob" title="${escapeHtml(n.conflictCids.join(','))}">冲突×${n.conflictCids.length}</span>`
          : n.moved ? '<span class="ia-state moved">移动</span>' : '';
        return `${arrow}<span class="ia-node ${n.root ? 'root' : ''} ${n.leaf ? 'leaf' : ''}">${escapeHtml(n.name)}${n.root ? '（根）' : ''}${n.leaf ? '（末端）' : ''} ${state}</span>`;
      }).join('');
      const termState = b.terminal.deleted ? '删除' : b.terminal.outOfBounds ? '越界' : b.terminal.conflictCids.length ? `冲突（${b.terminal.conflictCids.length}）` : b.terminal.moved ? '位置变化' : '无变化';
      return `<div class="${cls}">
        <div class="ia-branch-h">分支 ${bi + 1} · 长度 ${b.length} · 末端「${escapeHtml(b.terminal.name)}」：<b>${termState}</b></div>
        <div class="ia-chain">${chain}</div>
      </div>`;
    }).join('');
  }

  _renderDiff(host, snap, sim) {
    if (!sim || !sim.diff) { host.innerHTML = '<div class="ia-empty">添加候选后显示基线 → 模拟结果的完整差异。</div>'; return; }
    host.innerHTML = diffHtml(sim.diff);
    // 冲突链明细
    const conflicts = sim.report.conflicts || [];
    if (conflicts.length) {
      host.innerHTML += '<div class="ia-clist-title">模拟后的未满足约束与冲突链</div>' + conflicts.map((c) => `
        <div class="ia-conflict">
          <div><b>✗ ${escapeHtml(c.label)}</b>（偏差 ${Math.abs(c.measure).toFixed(2)}）</div>
          <ol class="ia-chain-list">${c.chain.map((x) => `<li>${escapeHtml(x)}</li>`).join('') || '<li>画布硬边界 / 锁定，无进一步让步对象</li>'}</ol>
        </div>`).join('');
    }
  }

  /* ---------------- applied / abandoned ---------------- */

  _renderApplied(snap) {
    const s = this.store;
    const ev = s.eventsById.get(snap.appliedEventId);
    const head = s.branches.find((b) => b.id === snap.branchId);
    const onBranch = head && this._chainHas(head.headEventId, snap.appliedEventId);
    this.$work.innerHTML = `
      <div class="ia-card ia-done">
        <div class="ia-head">
          <b>✓ ${escapeHtml(snap.name)}</b>
          <span class="ia-seed">种子：${escapeHtml(seedText(snap))}</span>
          <span class="spacer"></span>
          <button class="mini" data-act="report">⬇ 导出影响报告</button>
          <button class="mini" data-act="close">关闭</button>
        </div>
        <div class="ia-base">
          已应用于 ${snap.appliedAt ? new Date(snap.appliedAt).toLocaleString() : ''}
          · 分支「${escapeHtml(snap.branchName || snap.branchId)}」#${ev?.seq ?? '?'}
          · 事件 <code>${snap.appliedEventId}</code> · 结果指纹 <code>${(snap.resultHash || '').slice(0, 8)}</code>
          ${onBranch ? '' : '<span class="ia-warn">（该事件不在分支当前 head 链上：可能已被 undo / 在支线上，可在审计页回放）</span>'}
        </div>
        <div id="ia-done-body"></div>
      </div>`;
    this.$work.querySelector('[data-act=close]').onclick = () => { s.selectImpact(null); this.render(); };
    this.$work.querySelector('[data-act=report]').onclick = () => this.exportReport(snap.id);
    const body = this.$work.querySelector('#ia-done-body');
    if (snap.report?.simulation?.diff) {
      body.innerHTML = `<details class="ia-details" open><summary>应用的候选与前后差异</summary><div>${diffHtml(snap.report.simulation.diff)}</div></details>`;
    }
  }

  _renderClosed(snap, word) {
    this.$work.innerHTML = `
      <div class="ia-card">
        <div class="ia-head"><b>${escapeHtml(snap.name)}</b><span class="spacer"></span>
        <button class="mini" data-act="close">关闭</button></div>
        <div class="ia-base">该分析快照已${word}（候选与模拟保留在文档中，仅作记录）。</div>
      </div>`;
    this.$work.querySelector('[data-act=close]').onclick = () => { this.store.selectImpact(null); this.render(); };
  }

  /* ---------------- 快照列表 ---------------- */

  _renderSnapshotList() {
    const s = this.store;
    const snaps = [...s.impactSnapshots].sort((a, b) => (b.createdAt - a.createdAt) || (a.id < b.id ? -1 : 1));
    if (!snaps.length) {
      this.$snaps.innerHTML = '<div class="empty-note">还没有影响分析快照。<br>选中矩形 / 约束后创建分析，再添加候选变更模拟。</div>';
      return;
    }
    this.$snaps.innerHTML = '';
    for (const snap of snaps) {
      const div = document.createElement('div');
      div.className = 'ia-snap' + (snap.id === s.activeImpactId ? ' active' : '') + ` st-${snap.status}`;
      const ev = s.eventsById.get(snap.appliedEventId);
      const statusTag = {
        open: '<span class="ia-st open">进行中</span>',
        applied: `<span class="ia-st applied">已应用 #${ev?.seq ?? '?'}</span>`,
        abandoned: '<span class="ia-st abandoned">已放弃</span>',
      }[snap.status];
      const conflict = snap.conflict ? '<span class="ia-st conflict">版本冲突</span>' : '';
      const nCand = snap.changes.length;
      const nBlock = snap.simulation?.errors?.length || 0;
      div.innerHTML = `
        <div class="ia-snap-h">
          <a href="#" data-act="open">🔬 ${escapeHtml(snap.name)}</a>
          ${statusTag}${conflict}
          <span class="spacer"></span>
          <span class="ia-hint">${escapeHtml(snap.branchName || snap.branchId)} · 候选 ${nCand}${nBlock ? ` · <b style="color:var(--danger)">阻断 ${nBlock}</b>` : ''}</span>
          <button class="mini" data-act="report">报告</button>
          ${snap.status === 'open' ? `<button class="mini" data-act="apply" ${snap.conflict ? 'disabled' : ''}>应用</button>
            <button class="mini danger" data-act="abandon">放弃</button>` : ''}
        </div>`;
      div.querySelector('[data-act=open]').onclick = (e) => { e.preventDefault(); s.selectImpact(snap.id); this.render(); };
      div.querySelector('[data-act=report]').onclick = () => this.exportReport(snap.id);
      const applyBtn = div.querySelector('[data-act=apply]');
      if (applyBtn) applyBtn.onclick = () => this.apply(snap.id);
      const abBtn = div.querySelector('[data-act=abandon]');
      if (abBtn) abBtn.onclick = () => { if (confirm('放弃这张分析快照？')) { s.abandonImpact(snap.id); this._toast('已放弃'); } };
      this.$snaps.appendChild(div);
    }
  }

  /* ---------------- 应用 / 导出 ---------------- */

  async apply(id) {
    const s = this.store;
    const snap = s.impactById(id);
    if (!snap) return;
    if (!snap.changes.length) { this._toast('没有候选变更可应用（这是一张纯影响面分析）', 'warn'); return; }
    if (snap.simulation && !snap.simulation.ok) {
      this._toast('模拟存在阻断项（循环依赖 / 越界 / 结构错误），不能应用', 'error');
      return;
    }
    this._toast('正在核对分析时的文档版本并应用…');
    const res = await s.applyImpact(id);
    if (res.idempotent) { this._toast('同一组候选已经应用过：返回既有审计事件，不产生重复事件'); this.render(); return; }
    if (!res.ok) {
      if (res.status === 409) {
        this._toast('版本冲突：分支已前进，候选原样保留（未做任何修改）', 'error');
      } else {
        this._toast(res.error || '应用失败', 'error');
      }
      this.render();
      return;
    }
    this._toast(`✓ 已作为一条审计事件应用（#${res.event.seq}），快照与报告已保存`);
    this.render();
  }

  exportReport(id) {
    const report = this.store.impactReport(id);
    if (!report) { this._toast('报告生成失败', 'error'); return; }
    downloadJson(`impact-report-${id}.json`, report);
    this._toast(`已导出影响报告（校验和 ${report.checksum}）`);
  }

  /* ---------------- 小工具 ---------------- */

  _baseSeq(snap) {
    const ev = this.store.eventsById.get(snap.headEventId);
    return ev?.seq ?? '?';
  }
  _headSeq(branchId, eventId) {
    const ev = this.store.eventsById.get(eventId);
    if (ev?.seq) return ev.seq;
    const b = this.store.branches.find((x) => x.id === branchId);
    return this.store.eventsById.get(b?.headEventId)?.seq ?? null;
  }
  _chainHas(headId, targetId) {
    let cur = this.store.eventsById.get(headId);
    let guard = 0;
    while (cur && guard++ < 100000) {
      if (cur.id === targetId) return true;
      cur = cur.parentId ? this.store.eventsById.get(cur.parentId) : null;
    }
    return false;
  }
}

function consLabel(c, rectName) {
  const nm = (id) => rectName.get(id) || id;
  if (c.kind === 'snap') return `${nm(c.rect)} ↔ ${nm(c.other)}`;
  if (c.kind === 'minGap') return `${nm(c.rect)} ${c.side} ${nm(c.other)}`;
  if (c.kind === 'contain') return nm(c.rect);
  return nm(c.rect);
}

function seedText(snap) {
  if (snap.seed?.kind === 'rect') {
    const r = snap.baseModel?.rects?.find((x) => x.id === snap.seed.id);
    return `矩形「${r?.name || snap.seed.id}」`;
  }
  if (snap.seed?.kind === 'constraint') return `约束 ${snap.seed.id}`;
  return '?';
}

function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
