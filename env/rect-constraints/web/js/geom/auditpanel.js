/*
 * 审计与分支面板：
 * - 分支选择 / 新建（从当前 head）
 * - 操作者署名（随文档与浏览器持久化）
 * - 审计时间线：来源前缀（fork 只读）+ 主链 + 被取代的支线，每条可回放 / 另存为分支；
 *   损坏事件明确标出且不可回放
 * - 分支比较：两个分支当前 head 的矩形 / 约束 / 冲突差异
 * 所有数据操作都走 Store（追加事件 / 并发检查 / 持久化都在那里）。
 */

import { diffHtml } from './diff.js';

const KIND_LABEL = { root: '初始', edit: '编辑', 'fork-root': '分支起点', merge: '合并' };

export class AuditPanel {
  constructor(store, hooks) {
    this.store = store;
    this.hooks = hooks; // { toast }
    this.$actor = document.querySelector('#audit-actor');
    this.$branchSel = document.querySelector('#audit-branch');
    this.$list = document.querySelector('#audit-timeline');
    this.$newBranch = document.querySelector('#btn-new-branch');
    this.$mergeBranch = document.querySelector('#btn-merge-branch');
    this.$warnings = document.querySelector('#audit-warnings');
    this.$cmpA = document.querySelector('#bcmp-a');
    this.$cmpB = document.querySelector('#bcmp-b');
    this.$result = document.querySelector('#branch-compare-result');
    this.$count = document.querySelector('#audit-count');

    this.$actor.value = store.actor || '';
    this.$actor.addEventListener('change', () => {
      store.setActor(this.$actor.value.trim());
      this.hooks.toast(this.$actor.value.trim() ? `已署名：${this.$actor.value.trim()}（此后提交记录该操作者）` : '已清除操作者署名');
    });
    this.$branchSel.addEventListener('change', () => {
      const id = this.$branchSel.value;
      if (this.store.replaying) this.store.exitReplay();
      const res = store.switchBranch(id);
      if (!res.ok) this.render();
    });
    this.$newBranch.onclick = () => this._forkFromHead();
    this.$mergeBranch.onclick = () => this._mergeIntoCurrent();
    this.$cmpA.onchange = () => store.setBranchCompare(this.$cmpA.value || null, this.$cmpB.value || null);
    this.$cmpB.onchange = () => store.setBranchCompare(this.$cmpA.value || null, this.$cmpB.value || null);
  }

  _forkFromHead() {
    // 回放中则基于正在回放的事件另存；否则基于当前分支 head
    const baseEventId = this.store.replayEventId || this.store.branch.headEventId;
    const base = this.store.eventsById.get(baseEventId);
    const defaultName = this.store.replaying ? `回放 #${base?.seq ?? ''}` : `${this.store.branch.name} 的副本`;
    const name = prompt('新分支名称：', defaultName);
    if (name === null) return;
    const res = this.store.forkFromEvent(baseEventId, name);
    if (!res.ok) { this.hooks.toast(res.error, 'warn'); return; }
    this.hooks.toast(`已从${this.store.replaying ? '回放事件' : '当前布局'}另存为新分支「${name}」，原分支未被改写`);
  }

  _mergeIntoCurrent() {
    const targetId = this.store.currentBranchId;
    const others = [...this.store.branches]
      .filter((b) => b.id !== targetId)
      .sort((a, b) => (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : 1));
    if (!others.length) { this.hooks.toast('还没有其他分支可以合并', 'warn'); return; }
    const list = others.map((b, i) => `${i + 1}. ${b.name}`).join('\n');
    const ans = prompt(`把哪个来源分支合并到「${this.store.branch.name}」？\n${list}\n\n输入序号：`, '1');
    if (ans === null) return;
    const idx = Number(ans) - 1;
    const src = others[idx];
    if (!src) { this.hooks.toast('无效的序号', 'warn'); return; }
    const res = this.store.openMergeDraft(targetId, src.id);
    if (!res.ok) { this.hooks.toast(res.error, 'warn'); return; }
    // 切到“合并”页继续解决冲突 / 完成
    const tab = document.querySelector('.tab[data-tab="merge"]');
    if (tab) tab.click();
    this.hooks.toast(`已打开合并草案：${src.name} → ${this.store.branch.name}（共同祖先 #${res.plan.baseSeq}）`);
  }

  render() {
    const s = this.store;
    this.$actor.value = s.actor || '';
    this.$count.textContent = s.events.length;

    // 分支选择器
    const branches = [...s.branches].sort((a, b) => (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : 1));
    this.$branchSel.innerHTML = branches.map((b) => {
      const isMain = b.id === 'main';
      const fork = b.source ? `（来自 ${s.branches.find((x) => x.id === b.source.branchId)?.name || '已删分支'}）` : '';
      return `<option value="${b.id}" ${b.id === s.currentBranchId ? 'selected' : ''}>${escapeHtml(b.name)}${isMain ? '' : fork}</option>`;
    }).join('');

    this._renderWarnings();
    this._renderTimeline();
    this._renderCompare();
  }

  _renderWarnings() {
    const ws = this.store.auditWarnings;
    if (!ws.length) { this.$warnings.innerHTML = ''; this.$warnings.classList.add('hidden'); return; }
    this.$warnings.classList.remove('hidden');
    this.$warnings.innerHTML = `<div class="aw-title">⚠ 审计数据健康检查（${ws.length}）</div>` +
      ws.map((w) => `<div class="aw-item">${escapeHtml(w.text)}</div>`).join('');
  }

  _renderTimeline() {
    const s = this.store;
    const tl = s.timeline();
    if (!tl) { this.$list.innerHTML = ''; return; }
    const headId = s.branch.headEventId;
    const replayId = s.replayEventId;
    const rows = [];

    if (tl.sourcePrefix.length) {
      rows.push('<div class="tl-sep">来源分支（只读，不可在此提交）</div>');
      for (const r of tl.sourcePrefix) rows.push(this._rowHtml(r, { headId, replayId, source: true }));
      if (tl.sourceBroken) rows.push('<div class="tl-broken">来源链有事件缺失或损坏，来源历史不完整（当前布局仍可正常编辑）</div>');
      rows.push('<div class="tl-sep">本分支</div>');
    }

    for (const r of tl.chain) rows.push(this._rowHtml(r, { headId, replayId }));

    if (tl.detached.length) {
      rows.push('<div class="tl-sep">已被新提交取代的支线（仍可回放 / 另存为分支）</div>');
      for (const r of tl.detached) rows.push(this._rowHtml(r, { headId, replayId }));
    }

    this.$list.innerHTML = rows.join('');
    this.$list.querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const id = btn.closest('[data-eid]').dataset.eid;
        if (btn.dataset.act === 'replay') this._replay(id);
        else if (btn.dataset.act === 'fork') this._fork(id);
      };
    });
    this.$list.querySelectorAll('[data-eid]').forEach((el) => {
      if (el.dataset.clickable === '0') return;
      el.onclick = () => this._replay(el.dataset.eid);
    });
  }

  _rowHtml(r, { headId, replayId, source = false }) {
    const ev = r.ev;
    const isHead = ev.id === headId && !source;
    const isReplay = ev.id === replayId;
    const cls = [
      'tl-item',
      r.corrupt ? 'corrupt' : '',
      isHead ? 'head' : '',
      isReplay ? 'replaying' : '',
      source ? 'foreign' : '',
      ev.kind === 'fork-root' ? 'forkroot' : '',
    ].filter(Boolean).join(' ');
    const nRect = ev.model?.rects?.length ?? '—';
    const nCons = ev.model?.constraints?.length ?? '—';
    const nConf = ev.conflicts?.length ?? ev.report?.conflicts?.length ?? 0;
    const hashB = ev.hashBefore ? ev.hashBefore.slice(0, 8) : '—';
    const prov = ev.provenance
      ? `<div class="tl-prov">来源：${escapeHtml(this.store.branches.find((b) => b.id === ev.provenance.branchId)?.name || ev.provenance.branchId)} #${ev.provenance.seq}</div>` : '';
    const mergeInfo = ev.kind === 'merge' && ev.merge
      ? `<div class="tl-prov">三方合并来源：${escapeHtml(this.store.branches.find((b) => b.id === ev.merge.sourceBranchId)?.name || ev.merge.sourceBranchId)} #${ev.merge.sourceHeadSeq ?? '?'}（共同祖先 #${this._baseSeq(ev.merge.baseEventId)}）· 自动 ${ev.merge.auto ?? 0} 项 / 冲突 ${ev.merge.conflicts ?? 0} 项</div>` : '';
    const changeSum = ev.changes && !ev.changes.identical ? this._changeSummary(ev.changes) : '';
    if (r.corrupt) {
      return `<div class="${cls}" data-eid="${ev.id}" data-clickable="0">
        <div class="tl-row1">
          <span class="tl-seq">#${ev.seq || '?'}</span>
          <span class="tl-kind bad">损坏</span>
          <span class="tl-label">${escapeHtml(ev.label || '未命名事件')}</span>
        </div>
        <div class="tl-meta">${fmtTime(ev.t)} · ${escapeHtml(ev.actor || '未知')} · hash ${escapeHtml(String(ev.hash || '—').slice(0, 8))}</div>
        <div class="tl-reason">✗ 无法回放：${escapeHtml(ev.corruptReason || '快照损坏')}（审计记录保留，不影响当前布局）</div>
      </div>`;
    }
    return `<div class="${cls}" data-eid="${ev.id}" title="点击重放到这一刻">
      <div class="tl-row1">
        <span class="tl-seq">#${r.localSeq}${source ? '（来源）' : ''}</span>
        <span class="tl-kind">${KIND_LABEL[ev.kind] || '编辑'}</span>
        <span class="tl-label">${escapeHtml(ev.label || '未命名事件')}</span>
        ${isHead ? '<span class="tl-tag tag-head">当前 head</span>' : ''}
        ${isReplay ? '<span class="tl-tag tag-replay">回放中</span>' : ''}
        ${source ? '<span class="tl-tag tag-src">来源</span>' : ''}
      </div>
      <div class="tl-meta">
        ${fmtTime(ev.t)} · 操作者 <b>${escapeHtml(ev.actor || '未署名')}</b> ·
        矩形 ${nRect} · 约束 ${nCons} · 冲突 ${nConf}
      </div>
      <div class="tl-hash">指纹 ${hashB} → <b>${ev.hash.slice(0, 8)}</b>${changeSum ? ' · ' + changeSum : ''}</div>
      ${prov}${mergeInfo}
      <div class="tl-actions">
        <button class="mini" data-act="replay">▶ 重放到此</button>
        <button class="mini" data-act="fork" title="把这一刻的完整布局另存为新的编辑分支（原事件与原分支不改写）">⎇ 另存为分支</button>
      </div>
    </div>`;
  }

  _baseSeq(baseEventId) {
    const ev = this.store.eventsById.get(baseEventId);
    return ev?.seq ?? '?';
  }

  _changeSummary(d) {    const parts = [];
    const r = d.rects.added.length + d.rects.removed.length + d.rects.moved.length + d.rects.resized.length;
    const c = d.constraints.added.length + d.constraints.removed.length + d.constraints.changed.length;
    if (r) parts.push(`矩形 ${r}`);
    if (c) parts.push(`约束 ${c}`);
    parts.push(`冲突 ${d.conflicts.before}→${d.conflicts.after}`);
    return escapeHtml(parts.join(' · '));
  }

  _replay(id) {
    const res = this.store.replay(id);
    if (!res.ok) { this.hooks.toast(res.error, 'error'); return; }
    const ev = this.store.eventsById.get(id);
    this.hooks.toast(`正在回放 #${ev.seq}「${ev.label}」（只读，不改变任何历史）`);
    this.render();
  }

  _fork(id) {
    const ev = this.store.eventsById.get(id);
    if (!ev || ev.corrupt) { this.hooks.toast('该事件损坏，无法另存为分支', 'error'); return; }
    const name = prompt(`把 #${ev.seq}「${ev.label}」另存为新分支，名称：`, `回放 #${ev.seq}`);
    if (name === null) return;
    const res = this.store.forkFromEvent(id, name);
    if (!res.ok) { this.hooks.toast(res.error, 'warn'); return; }
    this.hooks.toast(`已另存为新分支「${name}」，可在此基础上继续编辑，原分支与原事件未被改写`);
  }

  /* ---------- 分支比较 ---------- */

  _renderCompare() {
    const { branches, branchCompare } = this.store;
    const opts = (sel) => `<option value="">（选择分支）</option>` +
      [...branches]
        .sort((a, b) => (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : 1))
        .map((b) => `<option value="${b.id}" ${b.id === sel ? 'selected' : ''}>${escapeHtml(b.name)}</option>`)
        .join('');
    this.$cmpA.innerHTML = opts(branchCompare.a);
    this.$cmpB.innerHTML = opts(branchCompare.b);
    const a = branches.find((b) => b.id === branchCompare.a);
    const b = branches.find((b) => b.id === branchCompare.b);
    if (!a || !b) {
      this.$result.innerHTML = `<div class="empty-note">选择两个分支后，这里显示它们当前 head 的<br>矩形 / 约束 / 冲突差异。比较选择随文档保存。</div>`;
      return;
    }
    const d = this.store.compareBranches(a.id, b.id);
    this.$result.innerHTML = diffHtml(d);
  }
}

function fmtTime(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return '时间未知';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
