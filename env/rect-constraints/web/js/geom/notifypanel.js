/*
 * 审阅通知与升级中心面板：
 * - 收件箱：当前操作者的待处理通知，可确认 / 稍后提醒 / 转交 / 手动重发（失败项）；
 * - 规则：为每个审阅会话配置按 决定 / 签署进度 / 冲突 / 完成 触发的多级接收人、
 *   延迟与升级顺序；规则修改不补发旧事件，启用/停用为暂停-恢复语义；
 * - 队列：FIFO 发送队列、重试次数、失败原因与在线状态（断网留队列、恢复按序重试）；
 * - 时间线：按会话查看完整通知时间线（每事件 → 每级别每接收人 → 送达/确认结果）并导出报告；
 * - 多窗口版本冲突：规则被另一窗口修改、通知项被另一窗口处理时 409，本地未提交操作保留，
 *   可重新提交（采用本地）或放弃。
 */

import { TRIGGER_TYPES, TRIGGER_LABEL, EVENT_LABEL, MAX_ATTEMPTS } from './notifications.js';
import { normalizeRecipient } from './notifications.js';
import { stableStringify, exportChecksum } from './auditbench.js';

const STATUS_LABEL = {
  scheduled: '待到期', pending: '待发送', sent: '已发送', delivered: '已送达',
  acknowledged: '已确认', snoozed: '稍后提醒', transferred: '已转交',
  failed: '发送失败', cancelled: '已取消',
};

export class NotifyPanel {
  constructor(store, hooks) {
    this.store = store;
    this.hooks = hooks; // { toast }
    this.$body = document.querySelector('[data-body="notify"]');
    this.$count = document.querySelector('#ntf-count');
    this.view = 'inbox';       // inbox | rules | queue | timeline
    this.timelineSession = null;
    this._buildDom();
    this._bind();
    store.addEventListener('notify', () => this.render());
    store.addEventListener('reviews', () => this.render());
    store.addEventListener('load', () => this.render());
    store.addEventListener('saved', () => this.render());
    store.addEventListener('saveerror', () => this.render());
    this._timer = setInterval(() => this.render(), 5000);
    if (this._timer.unref) this._timer.unref();
  }

  _buildDom() {
    this.$body.innerHTML = `
      <div class="ntf-subbar">
        <button class="mini ntf-tab active" data-ntf-view="inbox">📥 待处理</button>
        <button class="mini ntf-tab" data-ntf-view="rules">🔔 通知规则</button>
        <button class="mini ntf-tab" data-ntf-view="queue">🛫 发送队列</button>
        <button class="mini ntf-tab" data-ntf-view="timeline">📜 时间线报告</button>
        <span class="spacer"></span>
        <label class="ntf-me">当前接收人
          <input id="ntf-me" type="text" maxlength="40" placeholder="你的署名" />
        </label>
      </div>
      <div id="ntf-online"></div>
      <div id="ntf-conflict"></div>
      <div id="ntf-view"></div>`;
    this.$view = this.$body.querySelector('#ntf-view');
    this.$me = this.$body.querySelector('#ntf-me');
    this.$online = this.$body.querySelector('#ntf-online');
    this.$conflict = this.$body.querySelector('#ntf-conflict');
  }

  _bind() {
    this.$body.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-ntf-view]');
      if (tab) { this.view = tab.dataset.ntfView; this.render(); return; }
      const act = e.target.closest('[data-ntf-act]');
      if (act) { this._action(act); e.stopPropagation(); return; }
      const snoozeSel = e.target.closest('[data-ntf-snooze]');
      if (snoozeSel && snoozeSel.value) {
        const mins = Number(snoozeSel.value);
        const res = this.store.snoozeNotification(snoozeSel.dataset.ntfSnooze, mins);
        this._handle(res, `将在 ${mins} 分钟后再次提醒`, '稍后提醒失败');
        snoozeSel.value = '';
      }
    });
    this.$me.addEventListener('change', () => {
      const name = this.$me.value.trim();
      if (name) { this.store.setActor(name); this.hooks.toast(`已切换接收人 / 操作者：${name}`); this.render(); }
    });
  }

  get me() { return (this.store.actor || '').trim(); }

  /* ---------------- 渲染入口 ---------------- */

  render() {
    if (this.$me.value !== this.me) this.$me.value = this.me;
    this.$body.querySelectorAll('.ntf-tab').forEach((b) => b.classList.toggle('active', b.dataset.ntfView === this.view));
    const inbox = this.store.notifyInbox(this.me || '__none__');
    this.$count.textContent = inbox.length;
    this.$count.classList.toggle('zero', inbox.length === 0);
    this._renderOnline();
    this._renderConflict();
    if (this.view === 'inbox') this._renderInbox(inbox);
    else if (this.view === 'rules') this._renderRules();
    else if (this.view === 'queue') this._renderQueue();
    else this._renderTimeline();
  }

  _renderOnline() {
    const queueLen = this.store.notifyOutbox.length;
    if (!this.store.online) {
      this.$online.innerHTML = `<div class="ntf-banner bad">📵 网络不可用：${queueLen} 条待发送通知保留在队列中，恢复后将按原顺序重试（不会重复发送）。</div>`;
    } else if (queueLen) {
      this.$online.innerHTML = `<div class="ntf-banner info">🛫 在线：队列中 ${queueLen} 条通知按 FIFO 发送中…</div>`;
    } else {
      this.$online.innerHTML = '';
    }
  }

  _renderConflict() {
    const locks = [];
    for (const rid of this.store._notifyLockedRules) {
      const rule = this.store.notifyRuleById(rid);
      locks.push({ kind: 'rule', id: rid, name: rule?.name || rid });
    }
    for (const nid of this.store._notifyLockedItems) {
      const it = this.store.notificationById(nid);
      locks.push({ kind: 'item', id: nid, name: it?.title || nid });
    }
    if (!locks.length) { this.$conflict.innerHTML = ''; return; }
    this.$conflict.innerHTML = locks.map((l) => {
      if (l.kind === 'rule') {
        const draft = this.store.notifyRuleDrafts(l.id);
        return `<div class="ntf-banner bad">⛔ 409 规则版本冲突：「${escapeHtml(l.name)}」已在另一窗口修改。本地未提交编辑已保留。
          <button class="mini primary" data-ntf-act="rule-reapply" data-id="${escapeHtml(l.id)}">采用本地（作为新修订）</button>
          <button class="mini" data-ntf-act="rule-discard" data-id="${escapeHtml(l.id)}">放弃本地</button>
          ${draft ? '<span class="ntf-lock-note">（放弃后可在最新版本上重新编辑）</span>' : '<span class="ntf-lock-note">（本地没有额外编辑，仅需解除锁定）</span>'}</div>`;
      }
      const drafts = this.store.notifyItemDrafts(l.id);
      return `<div class="ntf-banner bad">⛔ 409 通知已被另一窗口处理：「${escapeHtml(l.name)}」。本地操作已保留（${drafts.length} 项）。
        ${drafts.map((d, i) => `<button class="mini primary" data-ntf-act="item-reapply" data-id="${escapeHtml(l.id)}" data-idx="${i}">重试本地：${draftActionLabel(d)}</button>`).join('')}
        <button class="mini" data-ntf-act="item-discard-all" data-id="${escapeHtml(l.id)}">全部放弃</button></div>`;
    }).join('');
  }

  /* ---------------- 收件箱 ---------------- */

  _renderInbox(inbox) {
    if (!this.me) {
      this.$view.innerHTML = `<div class="empty-note">请先在右上角填写「当前接收人」（与审阅署名一致），<br>命中规则接收人名单的通知会出现在这里。</div>`;
      return;
    }
    if (!inbox.length) {
      this.$view.innerHTML = `<div class="empty-note">✓ 当前没有待你处理的通知。<br>
        <span class="ntf-sub">在「通知规则」页为审阅会话配置触发事件、多级接收人与升级延迟。</span></div>`;
      return;
    }
    const bySession = new Map();
    for (const it of inbox) {
      const arr = byKey(bySession, it.sessionId);
      arr.push(it);
    }
    let html = '';
    for (const [sid, items] of bySession) {
      const sess = this.store.reviewSessionById(sid);
      html += `<div class="ntf-session"><div class="ntf-session-h">📝 ${escapeHtml(sess?.name || sid)}</div>`;
      html += items.map((it) => this._itemCard(it)).join('');
      html += `</div>`;
    }
    this.$view.innerHTML = html;
  }

  _itemCard(it) {
    const rule = this.store.notifyRuleById(it.ruleId);
    const snoozed = it.status === 'snoozed';
    const failed = it.status === 'failed';
    return `<div class="ntf-item st-${it.status}" data-ntf-item="${escapeHtml(it.id)}">
      <div class="ntf-i-row1">
        <span class="ntf-lvl">L${it.level + 1}</span>
        <span class="ntf-tag t-${it.eventType}">${EVENT_LABEL[it.eventType] || it.eventType}</span>
        <b class="ntf-i-title">${escapeHtml(it.title)}</b>
        <span class="spacer"></span>
        <span class="ntf-state s-${it.status}">${STATUS_LABEL[it.status] || it.status}</span>
      </div>
      <div class="ntf-i-summary">${escapeHtml(it.summary)}</div>
      <div class="ntf-i-meta">
        规则「${escapeHtml(rule?.name || it.ruleId.slice(0, 6))}」rev ${it.ruleRev} ·
        事件时间 ${fmtTime(it.eventAt)} · 应处理 ${fmtTime(it.dueAt)} · 重试 ${it.attempts}/${MAX_ATTEMPTS}
        ${snoozed && it.snoozeUntil ? ` · 提醒于 ${fmtTime(it.snoozeUntil)}` : ''}
        ${failed && it.lastError ? ` · <span class="ntf-err">${escapeHtml(it.lastError)}</span>` : ''}
      </div>
      <div class="ntf-i-actions">
        <button class="mini ok" data-ntf-act="ack" data-id="${escapeHtml(it.id)}">✓ 确认</button>
        <select class="ntf-snooze" data-ntf-snooze="${escapeHtml(it.id)}">
          <option value="">稍后提醒…</option>
          <option value="15">15 分钟</option>
          <option value="60">1 小时</option>
          <option value="240">4 小时</option>
          <option value="1440">明天</option>
        </select>
        <button class="mini" data-ntf-act="transfer" data-id="${escapeHtml(it.id)}">↪ 转交…</button>
        ${failed ? `<button class="mini primary" data-ntf-act="retry" data-id="${escapeHtml(it.id)}">⟳ 重新发送</button>` : ''}
      </div>
    </div>`;
  }

  /* ---------------- 规则 ---------------- */

  _renderRules() {
    const sessions = [...this.store.reviewSessions].sort((a, b) => (b.createdAt - a.createdAt) || (a.id < b.id ? -1 : 1));
    if (!sessions.length) {
      this.$view.innerHTML = `<div class="empty-note">还没有审阅会话。<br>请先在「审计台」从筛选结果创建审阅会话，再为它配置通知规则。</div>`;
      return;
    }
    let html = `<div class="ntf-rules-head">为审阅会话配置通知规则：触发事件、多级接收人、各级延迟与升级顺序。
      规则修改只对之后发生的事件生效（不补发旧事件）；停用是暂停，恢复后未确认事件继续升级。</div>`;
    for (const sess of sessions) {
      const rules = this.store.notifyRules.filter((r) => r.sessionId === sess.id && !r.deleted);
      html += `<div class="ntf-rule-session">
        <div class="ntf-session-h">📝 ${escapeHtml(sess.name)}
          <span class="ntf-session-state">${sess.status === 'completed' ? '已完成' : '进行中'}</span>
          <button class="mini primary ntf-new-rule" data-ntf-act="new-rule" data-sid="${escapeHtml(sess.id)}">＋ 新建规则</button>
        </div>
        <div class="ntf-rule-list">${rules.map((r) => this._ruleCard(sess, r)).join('') || '<div class="ntf-sub">暂无规则</div>'}</div>
      </div>`;
    }
    this.$view.innerHTML = html;
  }

  _ruleCard(sess, rule) {
    const trig = TRIGGER_TYPES.filter((t) => rule.triggers[t]).map((t) => EVENT_KIND_SHORT[t]).join('、');
    const trigText = trig || '无触发事件';
    const locked = this.store._notifyLockedRules.has(rule.id);
    return `<div class="ntf-rule ${locked ? 'locked' : ''} ${rule.enabled ? '' : 'off'}">
      <div class="ntf-r-row1">
        <b>🔔 ${escapeHtml(rule.name)}</b>
        <span class="ntf-sub">rev ${rule.rev} · ${escapeHtml(rule.createdBy)} · 修改水位 ${fmtTime(rule.revisedAt)}</span>
        <span class="spacer"></span>
        <label class="ntf-switch"><input type="checkbox" data-ntf-act="toggle-rule" data-id="${escapeHtml(rule.id)}" ${rule.enabled ? 'checked' : ''}/> 启用</label>
      </div>
      <div class="ntf-r-triggers">触发：${escapeHtml(trigText)}</div>
      <ol class="ntf-levels">
        ${rule.levels.map((lv, i) => `<li>
          <span class="ntf-lvl">L${i + 1}</span>
          接收人 <b>${lv.recipients.map(escapeHtml).join('、')}</b>
          <span class="ntf-sub">${i === 0 ? '立即' : `事件后延迟 ${lv.delayMin} 分钟，前序级别未确认时升级`}</span>
        </li>`).join('')}
      </ol>
      <div class="ntf-r-actions">
        <button class="mini" data-ntf-act="edit-rule" data-id="${escapeHtml(rule.id)}" ${locked ? 'disabled' : ''}>编辑</button>
        <button class="mini danger" data-ntf-act="delete-rule" data-id="${escapeHtml(rule.id)}" ${locked ? 'disabled' : ''}>删除</button>
        ${locked ? '<span class="ntf-lock-note">规则版本冲突未解决，编辑已锁定（见顶部横幅）</span>' : ''}
      </div>
    </div>`;
  }

  /* ---------------- 队列 ---------------- */

  _renderQueue() {
    const out = [...this.store.notifyOutbox].sort((a, b) => (a.enqueuedAt - b.enqueuedAt) || (a.id < b.id ? -1 : 1));
    const counters = this.store.notifyCounters();
    let html = `<div class="ntf-q-summary">
      通知 ${counters.total}：已送达 ${counters.delivered} · 已确认 ${counters.acknowledged} ·
      待处理 ${counters.actionable} · 稍后 ${counters.snoozed} · 已转交 ${counters.transferred} ·
      已取消 ${counters.cancelled} · <span class="${counters.failed ? 'ntf-err' : ''}">失败 ${counters.failed}</span>
    </div>`;
    if (!out.length) {
      html += `<div class="empty-note">✓ 发送队列已清空。<br><span class="ntf-sub">断网时待发送通知会保留在这里，恢复后按原顺序自动重试，每条通知有稳定队列 id，不会重复。</span></div>`;
    } else {
      html += '<div class="ntf-q-list">' + out.map((o) => {
        const it = this.store.notificationById(o.notifyId);
        const waiting = o.nextAttemptAt && Date.now() < o.nextAttemptAt;
        return `<div class="ntf-q-item">
          <span class="ntf-lvl">L${(it?.level ?? 0) + 1}</span>
          <b>${escapeHtml(it?.title || o.notifyId.slice(0, 8))}</b>
          <span class="ntf-sub">→ ${escapeHtml(it?.recipient || '?')} · ${EVENT_LABEL[it?.eventType] || ''}</span>
          <span class="spacer"></span>
          <span class="ntf-state ${waiting ? 'snoozed' : 'pending'}">${waiting ? `退避至 ${fmtTime(o.nextAttemptAt)}` : '待发送'}</span>
          <span class="ntf-sub">尝试 ${o.attempts}/${MAX_ATTEMPTS} · 入队 ${fmtTime(o.enqueuedAt)}</span>
          ${o.lastError ? `<div class="ntf-err">${escapeHtml(o.lastError)}</div>` : ''}
        </div>`;
      }).join('') + '</div>';
    }
    // 失败项（已出队）
    const failed = this.store.notifications.filter((n) => n.status === 'failed');
    if (failed.length) {
      html += `<h4 class="ntf-h">失败（${failed.length}）——可在收件箱手动重发</h4>` +
        failed.map((it) => `<div class="ntf-q-item dead">
          <b>${escapeHtml(it.title)}</b> → ${escapeHtml(it.recipient)}
          <span class="ntf-err">${escapeHtml(it.lastError || '发送失败')}（${it.attempts} 次）</span></div>`).join('');
    }
    this.$view.innerHTML = html;
  }

  /* ---------------- 时间线报告 ---------------- */

  _renderTimeline() {
    const sessions = [...this.store.reviewSessions].sort((a, b) => (b.createdAt - a.createdAt) || (a.id < b.id ? -1 : 1));
    const opts = sessions.map((s) => `<option value="${escapeHtml(s.id)}" ${this.timelineSession === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('');
    let html = `<div class="ntf-tl-bar">
        <label>审阅会话 <select id="ntf-tl-select"><option value="">— 选择会话 —</option>${opts}</select></label>
        <span class="spacer"></span>
        <button class="mini primary" id="ntf-tl-export" disabled>⬇ 导出通知时间线报告（JSON）</button>
      </div>`;
    const sid = this.timelineSession && sessions.some((s) => s.id === this.timelineSession) ? this.timelineSession
      : (sessions[0]?.id || null);
    this.timelineSession = sid;
    if (!sid) { html += '<div class="empty-note">还没有审阅会话。</div>'; this.$view.innerHTML = html; return; }

    const report = this.store.notifyReport(sid, { generatedAt: 'fixed' });
    html += `<div class="ntf-tl-summary">规则 ${report.rules.length} · 通知事件 ${report.eventCount} ·
      通知项 ${report.delivery.total}：已送达 ${report.delivery.delivered}、已确认 ${report.delivery.acknowledged}、
      待处理 ${report.delivery.pending}、已转交 ${report.delivery.transferred}、已取消 ${report.delivery.cancelled}、
      <span class="${report.delivery.failed ? 'ntf-err' : ''}">失败 ${report.delivery.failed}</span>
      ${report.delivery.queued ? ` · 队列中 ${report.delivery.queued}` : ''}</div>`;

    if (!report.timeline.length) {
      html += '<div class="empty-note">该会话还没有产生通知事件（尚无决定 / 签名 / 冲突 / 完成，或没有匹配的启用规则）。</div>';
    } else {
      html += report.timeline.map((ev) => {
        const nots = ev.notifications.map((n) => `<li class="ntf-tl-n st-${n.status}">
          <span class="ntf-lvl">L${n.level + 1}</span> ${escapeHtml(n.recipient)}
          <span class="ntf-state s-${n.status}">${STATUS_LABEL[n.status]}</span>
          <span class="ntf-sub">应处理 ${fmtTime(n.dueAt)}${n.deliveredAt ? ` · 送达 ${fmtTime(n.deliveredAt)}` : ''}${n.ackedAt ? ` · ${escapeHtml(n.ackedBy || '')} 确认于 ${fmtTime(n.ackedAt)}` : ''} · 重试 ${n.attempts}</span>
          ${n.lastError ? `<div class="ntf-err">失败原因：${escapeHtml(n.lastError)}</div>` : ''}
        </li>`).join('');
        return `<div class="ntf-tl-ev ${ev.invalid ? 'invalid' : ''}">
          <div class="ntf-tl-ev-h">
            <span class="ntf-tag t-${ev.type}">${EVENT_LABEL[ev.type] || ev.type}</span>
            <b>${escapeHtml(ev.title)}</b>
            <span class="ntf-sub">${fmtTime(ev.at)} · ${escapeHtml(ev.actor)}${ev.decision ? ' · ' + (ev.decision === 'pass' ? '通过' : ev.decision === 'reject' ? '驳回' : '待复核') : ''}</span>
          </div>
          ${nots ? `<ul class="ntf-tl-nots">${nots}</ul>` : '<div class="ntf-sub">无通知项（无匹配规则 / 在规则水位之前 / 已确认不升级）</div>'}
        </div>`;
      }).join('');
    }
    this.$view.innerHTML = html;
    this.$view.querySelector('#ntf-tl-select').onchange = (e) => { this.timelineSession = e.target.value || null; this.render(); };
    this.$view.querySelector('#ntf-tl-export').disabled = false;
    this.$view.querySelector('#ntf-tl-export').onclick = () => this._exportReport(sid);
  }

  _exportReport(sid) {
    const report = this.store.notifyReport(sid);
    const text0 = stableStringify(report);
    const doc = { ...report, contentChecksum: exportChecksum(text0) };
    const text = stableStringify(doc);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    a.href = url; a.download = `notify-report-${stamp}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    this.hooks.toast(`已导出通知时间线报告（事件 ${report.eventCount} / 通知项 ${report.delivery.total} / 失败 ${report.delivery.failed} / 校验和 ${doc.contentChecksum}）`);
  }

  /* ---------------- 动作 ---------------- */

  _action(btn) {
    const s = this.store;
    const act = btn.dataset.ntfAct;
    const id = btn.dataset.id;
    if (act === 'ack') {
      const note = prompt('确认备注（可留空）：', '');
      if (note === null) return;
      const res = s.ackNotification(id, note);
      this._handle(res, '已确认：该事件后续升级将不再发送', '确认失败');
    } else if (act === 'transfer') {
      const to = prompt('转交给（接收人署名）：', '');
      if (to === null) return;
      const reason = prompt('转交说明（可留空）：', '') || '';
      const res = s.transferNotification(id, to, reason);
      this._handle(res, `已转交给 ${normalizeRecipient(to)}（新通知进入其待处理）`, '转交失败');
    } else if (act === 'retry') {
      const res = s.retryNotification(id);
      this._handle(res, '已重新排队发送', '重发失败');
    } else if (act === 'new-rule') {
      this._openRuleEditor(btn.dataset.sid, null);
    } else if (act === 'edit-rule') {
      this._openRuleEditor(null, s.notifyRuleById(id));
    } else if (act === 'delete-rule') {
      const r = s.notifyRuleById(id);
      if (!confirm(`删除规则「${r?.name}」？已产生的通知保留，仅停止后续新通知。`)) return;
      const res = s.removeNotifyRule(id);
      if (!res.ok) this.hooks.toast(res.error, 'error');
      else this.hooks.toast('规则已删除（墓碑保留，跨窗口不会被旧副本复活）');
    } else if (act === 'toggle-rule') {
      s.toggleNotifyRule(id, btn.checked);
      this.hooks.toast(btn.checked ? '规则已恢复：未确认事件继续升级' : '规则已暂停：保留已有通知、停止新通知');
    } else if (act === 'rule-reapply') {
      const res = s.reapplyNotifyRuleDraft(id);
      this._handle(res, '本地规则编辑已作为新修订提交', '提交失败');
    } else if (act === 'rule-discard') {
      s.discardNotifyRuleDraft(id);
      // 本地无额外编辑时仅解除该规则的写锁
      if (!s.notifyRuleDrafts(id)) {
        s._notifyLockedRules.delete(id);
        if (!s._hasNotifyLocks()) s.notifyConflict = null;
      }
      this.hooks.toast('已放弃本地规则编辑，采用服务端最新版本');
    } else if (act === 'item-reapply') {
      const draft = s.notifyItemDrafts(id)[Number(btn.dataset.idx)];
      if (!draft) return;
      const res = s.reapplyNotifyItemDraft(id, draft);
      this._handle(res, `本地操作「${draftActionLabel(draft)}」已重新应用`, '重试失败');
    } else if (act === 'item-discard-all') {
      for (const d of [...s.notifyItemDrafts(id)]) s.discardNotifyItemDraft(id, d);
      this.hooks.toast('已放弃本地通知操作');
    }
  }

  _handle(res, okMsg, errPrefix) {
    if (res?.ok) { if (!res.idempotent) this.hooks.toast(okMsg); else this.hooks.toast('操作幂等：状态未重复改变'); return; }
    if (res?.status === 409 || String(res?.reason || '').startsWith('notify-')) {
      this.hooks.toast(`409 版本冲突：${res.reason}。本地未提交操作已保留，可在顶部横幅重试或放弃。`, 'error');
      return;
    }
    if (res?.status === 400) { this.hooks.toast(`${errPrefix}：${res.reason}`, 'warn'); return; }
    this.hooks.toast(res?.error || `${errPrefix}（${res?.reason || '未知错误'}）`, 'error');
  }

  /* ---------------- 规则编辑器（模态） ---------------- */

  _openRuleEditor(sid, rule) {
    const isEdit = !!rule;
    const sessionId = isEdit ? rule.sessionId : sid;
    const sess = this.store.reviewSessionById(sessionId);
    const levels = isEdit
      ? rule.levels.map((l) => ({ delayMin: l.delayMin, recipients: [...l.recipients] }))
      : [{ delayMin: 0, recipients: [this.me || sess?.createdBy || ''].filter(Boolean) }, { delayMin: 60, recipients: [] }];
    const triggers = isEdit ? { ...rule.triggers } : { decision: true, signoff: true, conflict: true, completed: true };

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-card ntf-editor-card">
        <div class="modal-head"><span>${isEdit ? '编辑通知规则' : '新建通知规则'} · ${escapeHtml(sess?.name || sessionId)}</span><span class="spacer"></span>
          <button class="icon-btn ntf-x">✕</button></div>
        <div class="ntf-editor">
          <label class="ntf-frow">规则名称 <input class="ntf-name" maxlength="60" value="${escapeHtml(isEdit ? rule.name : `通知规则 ${new Date().toLocaleString()}`)}"/></label>
          <div class="ntf-frow"><div class="ntf-flabel">触发事件</div>
            <div class="ntf-trig-grid">
              ${TRIGGER_TYPES.map((t) => `<label class="ntf-check"><input type="checkbox" data-trig="${t}" ${triggers[t] ? 'checked' : ''}/> ${TRIGGER_LABEL[t]}</label>`).join('')}
            </div>
          </div>
          <div class="ntf-frow"><div class="ntf-flabel">升级级别（接收人 / 延迟 / 升级顺序）</div>
            <div class="ntf-level-editor"></div>
            <button class="mini ntf-add-level">＋ 增加升级级别</button>
          </div>
          <div class="ntf-form-note" id="ntf-edit-error"></div>
          ${isEdit ? '<div class="ntf-form-warn">保存修改会推进规则版本并把时间水位推到现在：旧事件不会因新接收人 / 新延迟被补发；已有通知项保留。</div>' : ''}
        </div>
        <div class="modal-foot"><span class="spacer"></span>
          <button class="ntf-x">取消</button>
          <button class="primary ntf-ok">${isEdit ? '保存修订' : '创建规则'}</button></div>
      </div>`;
    document.body.appendChild(modal);
    const levelHost = modal.querySelector('.ntf-level-editor');
    const renderLevels = () => {
      levelHost.innerHTML = levels.map((lv, i) => `
        <div class="ntf-level-row" data-idx="${i}">
          <span class="ntf-lvl">L${i + 1}</span>
          <input class="ntf-recips" placeholder="接收人（逗号 / 顿号分隔）" value="${escapeHtml(lv.recipients.join('、'))}" ${i === 0 ? '' : ''}/>
          <input class="ntf-delay" type="number" min="0" max="43200" value="${lv.delayMin}" ${i === 0 ? 'disabled title="第一级立即发送"' : ''}/>
          <span class="ntf-sub">分钟${i === 0 ? '（立即）' : '延迟'}</span>
          ${i > 0 ? '<button class="mini danger ntf-del-level">✕</button>' : ''}
        </div>`).join('');
      levelHost.querySelectorAll('.ntf-level-row').forEach((row) => {
        const i2 = Number(row.dataset.idx);
        row.querySelector('.ntf-recips').oninput = (e) => {
          levels[i2].recipients = parseRecipients(e.target.value);
        };
        row.querySelector('.ntf-delay').onchange = (e) => {
          levels[i2].delayMin = Math.max(0, Math.round(Number(e.target.value) || 0));
        };
        row.querySelector('.ntf-del-level')?.addEventListener('click', () => { levels.splice(i2, 1); renderLevels(); });
      });
    };
    renderLevels();
    modal.querySelector('.ntf-add-level').onclick = () => { levels.push({ delayMin: 60, recipients: [] }); renderLevels(); };
    const close = () => modal.remove();
    modal.querySelectorAll('.ntf-x').forEach((b) => b.onclick = close);
    modal.querySelector('.ntf-ok').onclick = () => {
      const name = modal.querySelector('.ntf-name').value.trim();
      const trig = {};
      modal.querySelectorAll('[data-trig]').forEach((c) => { trig[c.dataset.trig] = c.checked; });
      const cleanLevels = levels
        .map((lv) => ({ delayMin: Math.max(0, Math.round(Number(lv.delayMin) || 0)), recipients: lv.recipients.map((x) => normalizeRecipient(x)).filter(Boolean) }))
        .filter((lv) => lv.recipients.length);
      const err = modal.querySelector('#ntf-edit-error');
      if (!name) { err.textContent = '请填写规则名称'; return; }
      if (!TRIGGER_TYPES.some((t) => trig[t])) { err.textContent = '请至少选择一种触发事件'; return; }
      if (!cleanLevels.length) { err.textContent = '请至少配置一个级别并填写接收人'; return; }
      const spec = { name, triggers: trig, levels: cleanLevels };
      const res = isEdit
        ? this.store.saveNotifyRule(sessionId, spec, { editId: rule.id })
        : this.store.saveNotifyRule(sessionId, spec);
      if (!res.ok) { err.textContent = res.error || res.reason || '保存失败'; return; }
      close();
      this.hooks.toast(isEdit
        ? '规则已修订（新版本，旧事件不补发）'
        : `已创建规则：命中事件将按 ${cleanLevels.length} 级升级顺序通知`);
    };
  }
}

/* ---------------- 工具 ---------------- */

const EVENT_KIND_SHORT = { decision: '决定', signoff: '签署进度', conflict: '冲突', completed: '完成' };

function parseRecipients(text) {
  const seen = new Set(); const out = [];
  for (const raw of String(text || '').split(/[\n,，、;；]/)) {
    const name = normalizeRecipient(raw);
    if (name && !seen.has(name)) { seen.add(name); out.push(name); }
  }
  return out;
}

function byKey(map, k) { if (!map.has(k)) map.set(k, []); return map.get(k); }

function draftActionLabel(d) {
  return { ack: '确认', snooze: `稍后 ${d.payload?.snoozeMin || ''} 分钟`, transfer: `转交 ${d.payload?.to || ''}`, retry: '重发' }[d.action] || d.action;
}

function fmtTime(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
