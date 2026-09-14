/*
 * 发布门禁面板（审计台页内）：
 * - 从当前打开的审阅会话创建发布候选：冻结证据快照（筛选条件 / 节点顺序 / 每节点最新决定与
 *   签署状态 / 实验来源 / 通知处理摘要），不可变；
 * - 明确展示缺失、过期、待复核、损坏节点与通知队列未处理项；门禁全过才可批准；
 * - 审批期间源会话 / 实验分支 / 通知状态变化 → 候选过期并阻止批准，需“重新生成快照”
 *   （旧候选保留为 superseded，完整审计链不丢）；
 * - 多窗口并发审批同一候选 → 409 release-advanced，本地审批意见保留，可重试或放弃；
 * - 已批准候选可撤销（原因必填），撤销记录与审批链保留；
 * - 候选 / 证据 / 门禁 / 审批意见 / 撤销记录 / 报告导出全部随文档持久化。
 */

import { stableStringify, exportChecksum } from './auditbench.js';
import { GATE_TEXT, STALE_TEXT } from './releases.js';

const STATE_LABEL = {
  pending: '待批准', approved: '已批准', revoked: '已撤销', superseded: '已被新快照取代',
};
const STATE_CLS = { pending: 'st-pending', approved: 'st-approved', revoked: 'st-revoked', superseded: 'st-superseded' };

export class ReleasePanel {
  constructor(store, hooks) {
    this.store = store;
    this.hooks = hooks; // { toast }
    this.$body = document.querySelector('#wb-releases');
    this._bindStore();
    this.render();
  }

  _bindStore() {
    const s = this.store;
    s.addEventListener('releases', () => this.render());
    s.addEventListener('reviews', () => this.render());
    s.addEventListener('notify', () => this.render());
    s.addEventListener('saved', () => this.render());
    s.addEventListener('load', () => this.render());
    s.addEventListener('branch', () => this.render());
    s.addEventListener('experiments', () => this.render());
  }

  render() {
    if (!this.$body) return;
    const s = this.store;
    const releases = [...s.releases].sort((a, b) =>
      (b.createdAt - a.createdAt) || (b.candidateNo - a.candidateNo) || (a.id < b.id ? -1 : 1));
    if (!releases.length) {
      this.$body.innerHTML = '';
      return;
    }
    const activeId = s.activeReleaseId;
    this.$body.innerHTML = `
      <div class="rl-all">
        <div class="rl-all-h">🚪 发布门禁与证据快照（${releases.length}）
          <span class="rl-all-tip">从审阅会话冻结证据快照；签署门槛、待复核、损坏/缺失节点与通知队列全部通过才能批准发布</span>
        </div>
        <div class="rl-chips">
          ${releases.map((r) => this._chipHtml(r, r.id === activeId)).join('')}
        </div>
      </div>`;
    const active = releases.find((r) => r.id === activeId);
    if (active) this.$body.insertAdjacentHTML('beforeend', this._detailHtml(active));
    this._bindDom();
  }

  _chipHtml(r, isActive) {
    const view = this.store.releaseViewFor(r.id);
    const stale = view?.stale && r.state === 'pending';
    return `<div class="rl-chip ${isActive ? 'active' : ''} ${STATE_CLS[r.state]}" data-rl-select="${r.id}">
      <span class="rl-chip-name">${escapeHtml(r.name)} <span class="rl-no">#${r.candidateNo}</span></span>
      <span class="rl-chip-state">${STATE_LABEL[r.state] || r.state}</span>
      ${stale ? '<span class="rl-tag t-stale" title="证据快照已过期，需重新生成">已过期</span>' : ''}
      ${r.state === 'pending' && view?.gate?.ok && !stale ? '<span class="rl-tag t-ready">可批准</span>' : ''}
    </div>`;
  }

  _detailHtml(r) {
    const s = this.store;
    const view = s.releaseViewFor(r.id);
    const gate = view?.gate || r.gate;
    const ev = r.evidence;
    const proposals = s.releaseProposals(r.id);
    const conflict = s.releaseConflict?.releaseId === r.id ? s.releaseConflict : null;
    return `
    <div class="rl-box ${STATE_CLS[r.state]}">
      <div class="rl-head">
        <b>🚪 ${escapeHtml(r.name)} <span class="rl-no">#${r.candidateNo}</span></b>
        <span class="rl-head-meta">${escapeHtml(r.createdBy)} · 冻结 ${fmtTime(ev.frozenAt)} · 来源会话「${escapeHtml(r.sessionName)}」 rev ${ev.session.sessionRev} · 候选 rev ${r.rev}</span>
        <span class="spacer"></span>
        <span class="rl-state-badge ${STATE_CLS[r.state]}">${STATE_LABEL[r.state] || r.state}</span>
        ${r.state === 'pending' ? `<button class="mini primary" data-rl-act="approve" ${gate.ok && !view.stale ? '' : 'disabled'}
          title="${gate.ok ? '' : '门禁未通过：'}${gate.blockers.map((c) => GATE_TEXT[c] || c).join('；')}">✓ 批准发布</button>` : ''}
        ${r.state === 'approved' ? '<button class="mini danger" data-rl-act="revoke">↶ 撤销发布</button>' : ''}
        ${r.state === 'pending' ? '<button class="mini" data-rl-act="regenerate" title="源会话/实验分支/通知已变化时重新冻结证据快照（旧候选保留）">⟳ 重新生成快照</button>' : ''}
        <button class="mini" data-rl-act="report" title="导出完整发布报告（证据快照/门禁/审批/撤销/审计链 + 校验和）">⬇ 导出报告</button>
        <button class="mini" data-rl-act="close" title="关闭（数据保留）">✕</button>
      </div>

      ${this._staleBanner(view, conflict)}
      ${this._proposalsHtml(r, proposals)}

      <div class="rl-evidence">
        <div class="rl-ev-title">不可变证据快照 <code class="rl-hash" title="证据总哈希">${ev.evidenceHash}</code></div>
        <div class="rl-ev-grid">
          <div><b>筛选条件</b>：${escapeHtml(filterText(ev.filter))}</div>
          <div><b>节点顺序</b>：${ev.order.length} 个节点（orderHash <code>${(ev.session.baseline.orderHash || '').slice(0, 8)}</code>）</div>
          <div><b>会话进度</b>：确认 ${ev.session.progress.confirmed}/${ev.session.progress.total}
            · ✓${ev.session.progress.pass} ✗${ev.session.progress.reject} ？${ev.session.progress.review} ○${ev.session.progress.pending}</div>
          <div><b>实验来源</b>：${ev.experiments.experiments.length ? ev.experiments.experiments.map((x) => `${escapeHtml(x.name)}（${x.variants.filter((v) => v.status === 'done').length}/${x.variants.length} 完成）`).join('；') : '无实验节点'}</div>
          <div class="rl-ev-span"><b>通知处理摘要</b>：事件 ${ev.notify.eventCount} · 通知项 ${ev.notify.itemCount}
            · 待处理 <b class="${ev.notify.actionableCount ? 'rl-bad' : 'rl-ok'}">${ev.notify.actionableCount}</b>
            · FIFO 队列 <b class="${ev.notify.queued.length ? 'rl-bad' : 'rl-ok'}">${ev.notify.queued.length}</b>
            ${Object.keys(ev.notify.byStatus).length ? ' · ' + statusText(ev.notify.byStatus) : ''}</div>
        </div>
      </div>

      ${this._issuesHtml(r, view)}
      ${this._gateHtml(gate, view)}
      ${this._nodesHtml(r)}
      ${this._approvalsHtml(r)}
      ${this._historyHtml(r)}
    </div>`;
  }

  _staleBanner(view, conflict) {
    const parts = [];
    if (view?.stale) {
      const reasons = view.staleReasons.length ? view.staleReasons : view.staleCodes.map((c) => STALE_TEXT[c] || c);
      parts.push(`<div class="rv-banner bad">⛔ 证据快照已过期，批准已被阻止：
        <ul class="rl-stale-list">${reasons.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>
        请处理变化后点「⟳ 重新生成快照」（旧候选完整保留为审计记录，新快照另立候选）。</div>`);
    }
    if (conflict) {
      const map = {
        'release-advanced': `另一个窗口已在同一候选上完成操作（服务端 rev ${conflict.serverRev ?? '?'}）：本地审批意见已保留，可在下方重试或放弃。`,
        'release-stale': '审批期间证据发生变化：提交被拒绝（409），请重新生成快照后再批准。',
        'release-gate-blocked': '门禁仍有阻断项，批准被拒绝（409）。',
        'release-revocation-reason-required': '撤销必须填写原因（409）。',
        'release-session-missing': '原审阅会话已不存在（409）。',
      };
      parts.push(`<div class="rv-banner bad">⛔ 409 发布冲突：${escapeHtml(map[conflict.reason] || conflict.reason)}
        ${conflict.staleCodes?.length ? '（' + conflict.staleCodes.map((c) => escapeHtml(STALE_TEXT[c] || c)).join('；') + '）' : ''}</div>`);
    }
    return parts.join('');
  }

  _proposalsHtml(r, proposals) {
    if (!proposals.length) return '';
    return `<div class="rv-proposals">
      <div class="rv-prop-h">待合并的本地审批意见（${proposals.length}，409 后保留，未写入候选）</div>
      ${proposals.map((p, i) => `<div class="rv-prop" data-prop-idx="${i}">
        <span class="rv-prop-node">${escapeHtml(p.approver)} 的批准意见</span>
        <span class="rv-prop-reason">${escapeHtml(p.comment || '（无意见）')}</span>
        <span class="spacer"></span>
        <button class="mini primary" data-rl-act="retry-approval" data-idx="${i}">在最新 rev 上重试</button>
        <button class="mini" data-rl-act="discard-approval" data-idx="${i}">放弃</button>
      </div>`).join('')}
    </div>`;
  }

  _issuesHtml(r, view) {
    const ev = r.evidence;
    const liveKeys = new Set((view?.view?.byKey ? [...view.view.byKey.keys()] : []));
    const missing = ev.session.nodes.filter((n) => n.absent || (view?.view && !liveKeys.has(n.key)));
    const corrupt = ev.session.nodes.filter((n) => n.severity === 'bad' || n.autoReview?.codes?.includes('corrupt'));
    const review = ev.session.nodes.filter((n) => n.effectiveDecision === 'review');
    const drift = [];
    if (view?.view) {
      for (const n of ev.session.nodes) {
        const live = view.view.byKey.get(n.key);
        if (live && n.fingerprint) {
          const fp = live.hashAfter || live.hashBefore;
          if (fp && fp !== n.fingerprint) drift.push({ title: n.title, from: n.fingerprint, to: fp });
        }
      }
    }
    const items = [];
    if (missing.length) items.push(['bad', `缺失节点 ${missing.length}`, missing.map((n) => n.title).join('、')]);
    if (corrupt.length) items.push(['bad', `损坏 / 不可回放节点 ${corrupt.length}`, corrupt.map((n) => n.title).join('、')]);
    if (review.length) items.push(['warn', `待复核项 ${review.length}`, review.map((n) => n.title).join('、')]);
    if (drift.length) items.push(['warn', `指纹漂移 ${drift.length}`, drift.map((x) => x.title).join('、')]);
    if (ev.notify.actionableCount) items.push(['bad', `待处理通知 ${ev.notify.actionableCount}`, '待发送 / 已送达未确认 / 稍后 / 失败 / 静音延迟']);
    if (ev.notify.queued.length) items.push(['bad', `通知队列未处理 ${ev.notify.queued.length}`, 'FIFO outbox 仍有条目']);
    if (view?.stale) items.push(['bad', '证据快照已过期', view.staleReasons.join('；')]);
    if (!items.length) items.push(['ok', '证据快照无缺失 / 过期 / 待复核项', '']);
    return `<div class="rl-issues">${items.map(([level, head, detail]) =>
      `<div class="rl-issue ${level}"><b>${level === 'ok' ? '✓ ' : level === 'bad' ? '✗ ' : '⚠ '}${escapeHtml(head)}</b>${detail ? ` — <span>${escapeHtml(detail)}</span>` : ''}</div>`).join('')}</div>`;
  }

  _gateHtml(gate, view) {
    const current = view?.gate;
    return `<details class="rl-gate" open>
      <summary>门禁检查（${gate.checks.filter((c) => c.ok).length}/${gate.checks.length} 通过${gate.blockers.length ? ` · ${gate.blockers.length} 项阻断` : ' · 全部通过'}）</summary>
      <table class="rl-gate-table">
        <thead><tr><th></th><th>检查项</th><th>冻结时（${fmtTime(gate.evaluatedAt)}）</th><th>当前</th></tr></thead>
        <tbody>${gate.checks.map((c) => {
          const now = current?.checks?.find((x) => x.code === c.code);
          return `<tr class="${c.ok ? '' : 'bad-row'}">
            <td>${c.ok ? '<span class="rl-ok">✓</span>' : (c.blocking ? '<span class="rl-bad">✗</span>' : '<span class="rl-warn">⚠</span>')}</td>
            <td>${escapeHtml(c.label)}${c.blocking ? '' : ' <span class="rl-nonblock">（提示）</span>'}</td>
            <td>${escapeHtml(c.detail)}</td>
            <td class="${now && !now.ok ? 'rl-bad' : 'rl-ok'}">${now ? escapeHtml(now.detail) : '—'}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </details>`;
  }

  _nodesHtml(r) {
    const nodes = r.evidence.session.nodes;
    return `<details class="rl-nodes">
      <summary>证据节点（${nodes.length}）：每节点最新决定与签署状态</summary>
      <div class="rl-node-list">${nodes.map((n) => `
        <div class="rl-node ${n.effectiveDecision}">
          <span class="rl-node-order">${String(n.order + 1).padStart(3, '0')}</span>
          <span class="rl-node-title">${escapeHtml(n.title)}</span>
          <span class="rl-node-dec m-${n.effectiveDecision}">${({ pass: '✓ 通过', reject: '✗ 驳回', review: '？待复核', pending: '○ 未处理' })[n.effectiveDecision]}</span>
          <span class="rl-node-sign">有效签名 ${n.activeCount}${n.autoReview ? ' · 系统转待复核：' + escapeHtml(n.autoReview.reason || n.autoReview.code) : ''}</span>
          <span class="spacer"></span>
          <code title="冻结指纹">${(n.fingerprint || '—').slice(0, 8)}</code>
        </div>`).join('')}</div>
    </details>`;
  }

  _approvalsHtml(r) {
    const rows = [];
    for (const a of r.approvals || []) {
      rows.push(`<li class="rl-a-ok"><b>${escapeHtml(a.by)}</b> · ${fmtTime(a.at)}${a.comment ? ` · ${escapeHtml(a.comment)}` : ''}
        <span class="rl-ok">已批准</span> <code title="批准时证据哈希">${(a.evidenceHash || '').slice(0, 8)}</code></li>`);
    }
    if (r.revocation) {
      rows.push(`<li class="rl-a-revoked"><b>${escapeHtml(r.revocation.by)}</b> · ${fmtTime(r.revocation.at)}
        <span class="rl-bad">已撤销</span> · 原因：${escapeHtml(r.revocation.reason)}</li>`);
    }
    if (r.state === 'superseded') {
      rows.push(`<li class="rl-a-sup">快照于 ${fmtTime(r.supersededAt)} 被候选 #${(this.store.releaseById(r.supersededById)?.candidateNo) || '?'} 取代（证据与审批意见原样保留）</li>`);
    }
    return `<details class="rl-audit" ${r.state === 'approved' || r.state === 'revoked' ? 'open' : ''}>
      <summary>审批 / 撤销记录（${(r.approvals || []).length + (r.revocation ? 1 : 0)}）</summary>
      <ol class="rl-a-list">${rows.join('') || '<li class="rv-none">还没有审批记录。</li>'}</ol>
    </details>`;
  }

  _historyHtml(r) {
    return `<details class="rl-audit">
      <summary>完整审计链（${r.history.length}）</summary>
      <ol class="rl-a-list">${r.history.map((h) =>
        `<li>${fmtTime(h.at)} · ${escapeHtml(h.by || '系统')} · <b>${escapeHtml(h.action)}</b>${h.detail ? ` · ${escapeHtml(h.detail)}` : ''}</li>`).join('')}</ol>
    </details>`;
  }

  _bindDom() {
    const s = this.store;
    this.$body.querySelectorAll('[data-rl-select]').forEach((el) => {
      el.onclick = () => s.selectRelease(s.activeReleaseId === el.dataset.rlSelect ? null : el.dataset.rlSelect);
    });
    this.$body.querySelectorAll('[data-rl-act]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        this._action(btn.dataset.rlAct, btn);
      };
    });
  }

  _action(act, btn) {
    const s = this.store;
    const id = s.activeReleaseId;
    const r = s.releaseById(id);
    if (!r) return;
    if (act === 'close') { s.selectRelease(null); return; }
    if (act === 'approve') {
      const comment = prompt('批准发布意见（可留空；证据哈希与门禁结果将一并记录）：', '') ?? null;
      if (comment === null) return;
      const res = s.approveRelease(id, comment);
      if (res.ok) { this.hooks.toast(res.idempotent ? '批准已存在（幂等）' : `已批准发布「${r.name}」：证据快照与审批记录已持久化`); return; }
      this._handleError(res);
      return;
    }
    if (act === 'revoke') {
      const reason = prompt('撤销已批准发布必须填写原因：', '');
      if (reason === null) return;
      if (!reason.trim()) { this.hooks.toast('撤销必须填写原因', 'warn'); return; }
      const res = s.revokeRelease(id, reason);
      if (res.ok) { this.hooks.toast('已撤销发布：撤销原因与完整审计链已保留'); return; }
      this.hooks.toast(res.error || res.reason || '撤销失败', 'error');
      return;
    }
    if (act === 'regenerate') {
      const res = s.regenerateRelease(id);
      if (!res.ok) { this.hooks.toast(res.error || res.reason || '重新生成失败', 'error'); return; }
      this.hooks.toast(`已重新冻结证据快照：旧候选 #${r.candidateNo} 保留为审计记录，当前为候选 #${res.release.candidateNo}`);
      return;
    }
    if (act === 'report') { this._export(id); return; }
    if (act === 'retry-approval' || act === 'discard-approval') {
      const idx = Number(btn.dataset.idx);
      const proposal = s.releaseProposals(id)[idx];
      if (!proposal) return;
      if (act === 'discard-approval') { s.discardReleaseProposal(id, proposal); this.hooks.toast('已放弃本地审批意见'); return; }
      const res = s.retryReleaseApproval(id, proposal);
      if (res.ok) { this.hooks.toast('已在最新候选 rev 上完成批准（本地审批意见已采用）'); return; }
      this._handleError(res);
    }
  }

  _handleError(res) {
    if (res.reason === 'release-stale') {
      this.hooks.toast('证据快照已过期：请重新生成快照后再批准（本地审批意见已保留）', 'error');
      return;
    }
    if (res.reason === 'release-gate-blocked') {
      const text = (res.blockers || []).map((c) => GATE_TEXT[c] || c).join('；');
      this.hooks.toast('门禁未通过：' + text, 'error');
      return;
    }
    if (res.reason === 'release-advanced') {
      this.hooks.toast('另一窗口已操作同一候选（409）：本地审批意见已保留，可重试或放弃', 'error');
      return;
    }
    this.hooks.toast(res.error || res.reason || '操作失败', 'error');
  }

  _export(id) {
    const report = this.store.releaseReport(id, { generatedAt: null });
    if (!report) { this.hooks.toast('候选不存在', 'error'); return; }
    const text0 = stableStringify(report);
    const doc = { ...report, contentChecksum: exportChecksum(text0) };
    const text = stableStringify(doc);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    a.href = url;
    a.download = `release-report-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    this.hooks.toast(`已导出发布报告（证据快照 / 门禁 / 审批 / 撤销 / 审计链 / 校验和 ${doc.contentChecksum}）`);
  }
}

function filterText(f) {
  const parts = [];
  if (f.branchId) parts.push(`分支 ${f.branchId}`);
  if (f.experimentId) parts.push(`实验 ${f.experimentId}`);
  if (f.variantId) parts.push(`变体 ${f.variantId}`);
  if (f.severity && f.severity !== 'all') parts.push(`健康=${f.severity}`);
  if (f.text) parts.push(`文本“${f.text}”`);
  return parts.join(' · ') || '全部节点';
}

function statusText(byStatus) {
  const LABEL = {
    scheduled: '待到期', deferred: '静音延迟', pending: '待发送', sent: '已发送', delivered: '已送达未确认',
    acknowledged: '已确认', snoozed: '稍后', transferred: '已转交', failed: '失败', cancelled: '已取消',
  };
  return Object.entries(byStatus).filter(([, n]) => n).map(([k, n]) => `${LABEL[k] || k} ${n}`).join(' · ');
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
