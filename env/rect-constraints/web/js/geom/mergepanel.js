/*
 * 编辑分支三方合并面板：
 * - 选择来源 / 目标分支 -> 基于共同祖先生成可反复打开的合并草案；
 * - 预览矩形位置尺寸、约束、自动合并项、冲突项；
 * - 每个冲突可选 保留目标 / 采用来源 / 手动填写结果；
 * - 合并后悬空引用 / 循环依赖 / 越界 / 未解决冲突都明确阻止完成；
 * - 合并期间目标分支前进 -> 版本冲突，本地选择保留，更新到最新 head 后逐项重新确认；
 * - 完成后在目标分支生成 merge 审计事件，可查看合并前后差异与逐项裁决报告。
 */

import { diffHtml, FIELD_NAME, escapeHtml } from './diff.js';
import { itemKey } from './merge.js';
import { compareVersions } from './versions.js';

export class MergePanel {
  constructor(store, hooks) {
    this.store = store;
    this.hooks = hooks; // { toast }
    this.$body = document.querySelector('[data-body="merge"]');
    this.$count = document.querySelector('#merge-count');
    this._buildSkeleton();
    this.$targetSel = this.$body.querySelector('#mg-target');
    this.$sourceSel = this.$body.querySelector('#mg-source');
    this.$openBtn = this.$body.querySelector('#mg-open');
    this.$draftList = this.$body.querySelector('#mg-drafts');
    this.$work = this.$body.querySelector('#mg-work');
    this.$error = this.$body.querySelector('#mg-error');

    this.$openBtn.onclick = () => {
      const t = this.$targetSel.value, s = this.$sourceSel.value;
      if (!t || !s) { this._toast('请先选择来源分支与目标分支', 'warn'); return; }
      if (t === s) { this._toast('来源分支与目标分支不能相同', 'warn'); return; }
      const res = this.store.openMergeDraft(t, s);
      if (!res.ok) { this._toast(res.error, 'warn'); return; }
      this._toast(`已打开合并草案：共同祖先 #${res.plan.baseSeq}「${res.plan.baseLabel}」`);
      this.render();
    };
    store.addEventListener('merge', () => this.render());
  }

  _toast(text, level = '') { this.hooks.toast(text, level); }

  _buildSkeleton() {
    this.$body.innerHTML = `
      <div class="mg-start">
        <div class="note" style="margin:0 0 10px">
          基于两个分支的<b>共同祖先</b>做三方合并：只在一边改动的对象自动合并；两边改动同一矩形 / 约束、
          删除与修改相撞时逐项解决。合并结果出现悬空引用、循环依赖或越界会被明确阻止。原分支与历史事件绝不改写，
          草案与冲突选择随文档保存、可反复打开；重复提交同一份结果不会产生重复事件。
        </div>
        <div class="mg-pick">
          <label>目标分支（合并结果提交到这里）<select id="mg-target"></select></label>
          <span class="cmp-arrow">⇐</span>
          <label>来源分支<select id="mg-source"></select></label>
          <button id="mg-open" class="primary">⎀ 预览合并 / 打开草案</button>
        </div>
        <div id="mg-error" class="dlg-error"></div>
      </div>
      <div id="mg-active"></div>
      <h4 class="ver-h">合并草案</h4>
      <div id="mg-drafts" class="list"></div>`;
  }

  render() {
    const s = this.store;
    const branches = [...s.branches].sort((a, b) => (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : 1));
    const opts = (sel) => branches.map((b) => `<option value="${b.id}" ${b.id === sel ? 'selected' : ''}>${escapeHtml(b.name)}</option>`).join('');
    const curT = this.$targetSel.value || s.currentBranchId;
    // 默认来源：第一个不同于目标的分支
    const curS = this.$sourceSel.value || branches.find((b) => b.id !== curT)?.id || '';
    this.$targetSel.innerHTML = opts(curT);
    this.$sourceSel.innerHTML = opts(curS);

    const openN = s.mergeDrafts.filter((d) => d.status === 'open').length;
    this.$count.textContent = s.mergeDrafts.length;
    this.$count.classList.toggle('zero', !s.mergeDrafts.length);
    this.$count.title = `${openN} 个进行中 / ${s.mergeDrafts.length} 个草案`;

    this._renderActive();
    this._renderDraftList();
  }

  /* ---------- 当前草案工作区 ---------- */

  _renderActive() {
    const host = this.$body.querySelector('#mg-active');
    const s = this.store;
    const draft = s.activeMergeDraft;
    if (!draft) { host.innerHTML = ''; return; }

    if (draft.status === 'completed') return this._renderCompleted(host, draft);
    if (draft.status !== 'open') return this._renderClosed(host, draft);

    const view = s.mergeDraftView(draft.id);
    if (!view?.ok) {
      host.innerHTML = `<div class="mg-conflict-banner">无法重建合并计划：${escapeHtml(view?.message || '草案数据缺失')}</div>`;
      return;
    }
    const { plan, models, choices } = view;
    const preview = s.previewMerge(draft.id);
    const advanced = s.mergeTargetAdvanced(draft) || s.mergeConflict?.draftId === draft.id
      || s.mergeConflict?.reason === 'merge-source-advanced';
    const tbName = s.branches.find((b) => b.id === draft.targetBranchId)?.name || plan.targetBranchName;
    const sbName = s.branches.find((b) => b.id === draft.sourceBranchId)?.name || plan.sourceBranchName;

    host.innerHTML = `
      <div class="mg-card">
        <div class="mg-head">
          <b>⎀ 合并「${escapeHtml(sbName)}」→「${escapeHtml(tbName)}」</b>
          <span class="spacer"></span>
          <button class="mini" data-act="abandon">放弃草案</button>
          <button class="mini" data-act="close">关闭</button>
        </div>
        <div class="mg-base">共同祖先：#${plan.baseSeq}「${escapeHtml(plan.baseLabel)}」
          （目标 #${plan.targetHeadSeq} · 来源 #${plan.sourceHeadSeq}）</div>
        ${advanced ? this._advancedBanner(draft, plan) : ''}
        <div class="mg-sum">
          <span class="mg-auto">自动合并 ${plan.counts.auto} 项</span>
          <span class="${plan.counts.conflicts ? 'mg-bad' : 'mg-ok'}">冲突 ${plan.counts.conflicts} 项</span>
          <span class="spacer"></span>
          <button class="primary" data-act="commit" ${advanced ? 'disabled' : ''}>✓ 完成合并并提交到目标分支</button>
        </div>
        <div id="mg-blockers"></div>
        <div id="mg-conflicts"></div>
        <details class="mg-details"><summary>自动合并项（${plan.counts.auto}）与合并预览</summary><div id="mg-autos"></div></details>
        <details class="mg-details" ${preview.ok ? 'open' : ''}><summary>合并结果差异（目标 head → 合并后，含求解后的位置 / 尺寸 / 冲突）</summary><div id="mg-diff"></div></details>
      </div>`;

    this._renderBlockers(host.querySelector('#mg-blockers'), preview, advanced);
    this._renderConflicts(host.querySelector('#mg-conflicts'), view, choices);
    this._renderAutos(host.querySelector('#mg-autos'), plan);
    const diffHost = host.querySelector('#mg-diff');
    if (preview.ok) {
      const targetEvent = s.eventsById.get(draft.targetHeadId);
      const d = compareVersions(
        { model: targetEvent.model, report: targetEvent.report, hash: targetEvent.hash },
        { model: preview.model, report: preview.report, hash: preview.report.hash },
      );
      diffHost.innerHTML = diffHtml(d);
    } else {
      diffHost.innerHTML = '<div class="empty-note">解决全部冲突并通过校验后，这里显示合并前后差异。</div>';
    }

    host.querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = () => {
        const act = btn.dataset.act;
        if (act === 'abandon') { if (confirm('放弃该合并草案？（不会改动任何分支或历史事件）')) { s.abandonMergeDraft(draft.id); s.selectMergeDraft(null); } }
        else if (act === 'close') { s.selectMergeDraft(null); this.render(); }
        else if (act === 'commit') this._commit(draft.id);        else if (act === 'refresh-heads') {
          const r = s.refreshMergeDraftHeads(draft.id);
          if (!r.ok) this._toast(r.error, 'error');
          else this._toast(`已更新到最新分支头，${r.carried} 项已有选择保留，请逐项重新确认`);
        }
      };
    });
  }

  _advancedBanner(draft, plan) {
    const s = this.store;
    const reason = s.mergeConflict?.reason;
    const tb = s.branches.find((b) => b.id === draft.targetBranchId);
    const sb = s.branches.find((b) => b.id === draft.sourceBranchId);
    let headText = '';
    if (reason === 'merge-source-advanced') {
      const sh = s.eventsById.get(sb?.headEventId);
      headText = `来源分支「${sb?.name || ''}」已前进到 #${sh?.seq ?? '?'}`;
    } else {
      const th = s.eventsById.get(tb?.headEventId);
      headText = `目标分支「${tb?.name || ''}」已前进到 #${th?.seq ?? '?'}`;
    }
    return `<div class="mg-conflict-banner">
      ⚠ <b>版本冲突：${escapeHtml(headText)}</b>。本地冲突选择已保留，完成合并被阻止。请先
      <button class="mini" data-act="refresh-heads">更新到最新分支头并逐项重新确认</button>。
    </div>`;
  }

  _renderBlockers(host, preview, advanced) {
    const errs = preview.ok ? [] : (preview.errors || []);
    if (preview.unresolved?.length) {
      host.innerHTML = `<div class="mg-blocker">⛔ 还有 ${preview.unresolved.length} 个冲突项未选择处理方式，不能完成合并。</div>`;
    } else if (errs.length) {
      host.innerHTML = errs.map((e) => `<div class="mg-blocker">⛔ ${this._blockerText(e)}</div>`).join('');
    } else if (advanced) {
      host.innerHTML = '';
    } else {
      host.innerHTML = '<div class="mg-ready">✓ 所有冲突已解决，合并结果通过结构 / 悬空引用 / 环 / 越界校验。</div>';
    }
  }

  _blockerText(e) {
    if (e.code === 'cycle') return `循环依赖：${escapeHtml(e.message)}`;
    if (e.code === 'dangling-ref') return `悬空引用：${escapeHtml(e.message)}`;
    if (e.code === 'out-of-bounds') return `越界：${escapeHtml(e.message)}`;
    if (e.code === 'duplicate-id') return escapeHtml(e.message);
    return escapeHtml(e.message);
  }

  /* ---------- 冲突项 ---------- */

  _renderConflicts(host, view, choices) {
    const { plan, models } = view;
    const items = [...plan.rects.conflicts, ...plan.constraints.conflicts];
    if (!items.length) { host.innerHTML = '<div class="mg-no-conflict">两边改动互不相交：没有需要人工解决的冲突。</div>'; return; }
    host.innerHTML = '<h4 class="ver-h">需逐项解决的冲突</h4>' + items.map((item) => {
      const key = itemKey(item);
      const ch = choices.get(key);
      const res = ch?.resolution || '';
      return `<div class="mg-conf ${res ? 'resolved' : 'open'}" data-key="${key}" data-kind="${item.kind}">
        ${this._conflictHeader(item)}
        <div class="mg-sides">
          <div class="mg-side target">${this._sideValue(item, 'target', models)}</div>
          <div class="mg-side source">${this._sideValue(item, 'source', models)}</div>
        </div>
        <div class="mg-choices">
          <label><input type="radio" name="${key}" value="target" ${res === 'target' ? 'checked' : ''}/> 保留目标</label>
          <label><input type="radio" name="${key}" value="source" ${res === 'source' ? 'checked' : ''}/> 采用来源</label>
          <label><input type="radio" name="${key}" value="manual" ${res === 'manual' ? 'checked' : ''}/> 手动填写</label>
          <label class="mg-del-manual"><input type="checkbox" data-f="manualdelete" ${res === 'manual' && !ch.manual ? 'checked' : ''}/> 手动删除</label>
        </div>
        <div class="mg-manual" ${res === 'manual' ? '' : 'hidden'}>${this._manualEditor(item, ch)}</div>
      </div>`;
    }).join('');

    host.querySelectorAll('.mg-conf').forEach((card) => {
      const key = card.dataset.key;
      const kind = card.dataset.kind;
      const item = items.find((x) => itemKey(x) === key);
      const draftId = this.store.activeMergeDraft?.id;
      card.querySelectorAll('input[type=radio]').forEach((radio) => {
        radio.onchange = () => {
          if (radio.value !== 'manual') {
            const r = this.store.setMergeResolution(draftId, key, radio.value);
            if (!r.ok) this._toast(r.error, 'error');
          } else {
            // 切到手动：默认用来源值（无则目标值）预填，用户在编辑器里改后点“应用”
            const seed = item.source || item.target || item.base;
            const manual = kind === 'rect' ? seed : structuredClone(seed);
            const r = this.store.setMergeResolution(draftId, key, 'manual', manual);
            if (!r.ok) this._toast(r.error, 'warn');
          }
        };
      });
      const del = card.querySelector('[data-f=manualdelete]');
      del.onchange = () => {
        const r = this.store.setMergeResolution(draftId, key, 'manual', null);
        if (!r.ok) this._toast(r.error, 'error');
      };
      const apply = card.querySelector('[data-act=apply-manual]');
      apply.onclick = () => {
        let manual;
        try { manual = this._readManual(card, item, kind); } catch { return; }
        const r = this.store.setMergeResolution(draftId, key, 'manual', manual);
        if (!r.ok) this._toast(r.error, 'error');
        else this._toast('已采用手动填写结果');
      };
    });
  }

  _conflictHeader(item) {
    if (item.kind === 'rect') {
      const t = item.targetChanged ? (item.target ? '改' : '删') : '—';
      const s = item.sourceChanged ? (item.source ? '改' : '删') : '—';
      return `<div class="mg-conf-h">▭ 矩形「${escapeHtml(item.name)}」 <span class="mg-flag">目标:${t} / 来源:${s}</span>${item.sameResult && item.target && item.source ? '<span class="mg-same">两边结果相同</span>' : ''}</div>`;
    }
    return `<div class="mg-conf-h">🔗 约束 <span class="mg-flag">目标:${item.targetChanged ? (item.target ? '改' : '删') : '—'} / 来源:${item.sourceChanged ? (item.source ? '改' : '删') : '—'}</span><div class="mg-cons-label">${escapeHtml(item.label)}</div></div>`;
  }

  _sideValue(item, side, models) {
    const v = item[side];
    const title = side === 'target' ? '目标' : '来源';
    const cls = side === 'target' ? 'target' : 'source';
    if (v === null || v === undefined) {
      // base 里有但该侧没有 = 该侧删除；base 里也没有 = 该侧新增
      const deleted = !!item.base;
      return `<div class="mg-side-h ${cls}">${title}：${deleted ? '🗑 已删除' : '（无此对象）'}</div>`;
    }
    if (item.kind === 'rect') {
      return `<div class="mg-side-h ${cls}">${title}：<b>${escapeHtml(v.name || v.id)}</b></div>
        <div class="mg-geo">x ${Math.round(v.x)} · y ${Math.round(v.y)} · 宽 ${Math.round(v.w)} · 高 ${Math.round(v.h)}</div>`;
    }
    return `<div class="mg-side-h ${cls}">${title}</div><div class="mg-cons-fields">${this._constraintFields(v)}</div>`;
  }

  _constraintFields(c) {
    const rows = [
      ['类型', c.kind], ['优先级', c.priority], ['启用', c.enabled !== false ? '是' : '否'],
    ];
    if (c.kind === 'snap') rows.push(['轴', c.axis], ['边', `${c.edge}/${c.otherEdge}`], ['偏移', c.gap], ['锚点', c.other]);
    if (c.kind === 'minGap') rows.push(['方向', c.side], ['间距', c.gap], ['障碍', c.other]);
    if (c.kind === 'contain') rows.push(['边距', c.margin]);
    if (c.kind === 'lock') rows.push(['锁定宽', c.w], ['锁定高', c.h]);
    return rows.map(([k, v]) => `<span><em>${escapeHtml(FIELD_NAME[k] || k)}</em>: ${escapeHtml(String(v))}</span>`).join('');
  }

  /* ---------- 手动编辑器 ---------- */

  _manualEditor(item, ch) {
    if (ch?.resolution === 'manual' && !ch.manual) {
      return '<div class="mg-manual-note">手动结果：<b>删除该对象</b>（勾选“手动删除”；取消勾选可改回填写）。</div>';
    }
    if (item.kind === 'rect') {
      const v = ch?.manual || item.source || item.target || item.base;
      return `<div class="mg-manual-form">
        <label>名称<input type="text" data-f="name" value="${escapeHtml(v?.name || '')}"/></label>
        <label>x<input type="number" data-f="x" value="${Math.round(v?.x ?? 0)}"/></label>
        <label>y<input type="number" data-f="y" value="${Math.round(v?.y ?? 0)}"/></label>
        <label>宽<input type="number" data-f="w" value="${Math.round(v?.w ?? 10)}"/></label>
        <label>高<input type="number" data-f="h" value="${Math.round(v?.h ?? 10)}"/></label>
        <button class="mini primary" data-act="apply-manual">应用手动结果</button>
      </div>`;
    }
    const v = ch?.manual || item.source || item.target || item.base;
    const rects = this._allRectNames(item);
    const rectOpts = (sel) => rects.map(([id, name]) =>
      `<option value="${id}" ${id === sel ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('');
    let fields = '';
    if (v?.kind === 'snap') {
      fields = `
        <label>轴<select data-f="axis"><option value="x" ${v.axis === 'x' ? 'selected' : ''}>x</option><option value="y" ${v.axis === 'y' ? 'selected' : ''}>y</option></select></label>
        <label>跟随边<select data-f="edge">${['l', 'r', 't', 'b', 'mid'].map((e) => `<option ${v.edge === e ? 'selected' : ''}>${e}</option>`).join('')}</select></label>
        <label>锚点边<select data-f="otherEdge">${['l', 'r', 't', 'b', 'mid'].map((e) => `<option ${v.otherEdge === e ? 'selected' : ''}>${e}</option>`).join('')}</select></label>
        <label>偏移<input type="number" data-f="gap" value="${v.gap ?? 0}"/></label>`;
    } else if (v?.kind === 'minGap') {
      fields = `
        <label>方向<select data-f="side">${['left', 'right', 'above', 'below'].map((e) => `<option ${v.side === e ? 'selected' : ''}>${e}</option>`).join('')}</select></label>
        <label>间距<input type="number" data-f="gap" value="${v.gap ?? 0}"/></label>`;
    } else if (v?.kind === 'contain') {
      fields = `<label>边距<input type="number" data-f="margin" min="0" value="${v.margin ?? 0}"/></label>`;
    } else if (v?.kind === 'lock') {
      fields = `
        <label>锁定宽<input type="number" data-f="w" value="${v.w ?? 10}"/></label>
        <label>锁定高<input type="number" data-f="h" value="${v.h ?? 10}"/></label>`;
    }
    return `<div class="mg-manual-form" data-kind="${v?.kind || ''}">
        <label>跟随矩形<select data-f="rect">${rectOpts(v?.rect)}</select></label>
        ${(v?.kind === 'snap' || v?.kind === 'minGap') ? `<label>锚点矩形<select data-f="other">${rectOpts(v?.other)}</select></label>` : ''}
        ${fields}
        <label>优先级<input type="number" min="1" max="999" data-f="priority" value="${v?.priority ?? 50}"/></label>
        <label>启用<input type="checkbox" data-f="enabled" ${v?.enabled !== false ? 'checked' : ''}/></label>
        <button class="mini primary" data-act="apply-manual">应用手动结果</button>
      </div>
      <details class="mg-json-details"><summary>直接编辑 JSON</summary>
        <textarea class="mg-json" data-f="json" rows="6">${escapeHtml(JSON.stringify(v || {}, null, 2))}</textarea>
      </details>`;
  }

  _allRectNames(item) {
    const s = this.store;
    const draft = s.activeMergeDraft;
    const view = draft ? s.mergeDraftView(draft.id) : null;
    const models = view?.models;
    const map = new Map();
    for (const m of models ? [models.base, models.target, models.source] : []) {
      for (const r of m?.rects || []) if (!map.has(r.id)) map.set(r.id, r.name || r.id);
    }
    void item;
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }

  _readManual(card, item, kind) {
    if (card.querySelector('[data-f=manualdelete]')?.checked) return null;
    if (kind === 'rect') {
      const g = (f) => Number(card.querySelector(`[data-f=${f}]`)?.value);
      const name = card.querySelector('[data-f=name]')?.value || '';
      return { id: item.id, name, x: g('x'), y: g('y'), w: g('w'), h: g('h') };
    }
    // 若用户展开并修改了 JSON，以 JSON 为准
    const jsonHost = card.querySelector('[data-f=json]');
    const form = card.querySelector('.mg-manual-form');
    const base = item.source || item.target || item.base || {};
    if (jsonHost && document.activeElement === jsonHost) {
      try { return JSON.parse(jsonHost.value || '{}'); }
      catch (e) { this._toast('手动约束 JSON 解析失败：' + e.message, 'error'); throw e; }
    }
    const val = (f) => form.querySelector(`[data-f=${f}]`)?.value;
    const num = (f, d = 0) => { const n = Number(val(f)); return Number.isFinite(n) ? n : d; };
    const ckind = form.dataset.kind || base.kind;
    const c = { id: item.id, kind: ckind, rect: val('rect'), priority: Math.round(num('priority', 50)),
      enabled: form.querySelector('[data-f=enabled]')?.checked !== false };
    if (ckind === 'snap') Object.assign(c, { other: val('other'), axis: val('axis'), edge: val('edge'), otherEdge: val('otherEdge'), gap: num('gap') });
    else if (ckind === 'minGap') Object.assign(c, { other: val('other'), side: val('side'), gap: num('gap') });
    else if (ckind === 'contain') Object.assign(c, { margin: Math.max(0, num('margin')) });
    else if (ckind === 'lock') Object.assign(c, { w: Math.max(1, num('w', 10)), h: Math.max(1, num('h', 10)) });
    return c;
  }

  /* ---------- 自动项 ---------- */

  _renderAutos(host, plan) {
    const rectRows = plan.rects.auto.map((it) => {
      const verb = !it.target && it.source ? '来源新增' : it.target && !it.source ? '' : '';
      return `<div class="mg-auto-item ${it.resolution}">▭ ${this._autoText(it)}</div>`;
    });
    const consRows = plan.constraints.auto.map((it) => `<div class="mg-auto-item ${it.resolution}">🔗 ${this._autoText(it)}</div>`);
    host.innerHTML = [...rectRows, ...consRows].join('') || '<div class="empty-note">无自动合并项。</div>';
  }

  _autoText(it) {
    const name = it.kind === 'rect' ? `矩形「${it.name}」` : `约束（${it.label}）`;
    const sideText = it.resolution === 'source' ? '来源' : '目标';
    // auto 项有且只有一边改动：target/source 为 null 表示该侧删除
    if (it.resolution === 'source') {
      if (!it.source) return `${name}：来源已删除，自动删除`;
      if (!it.target && it.base) return `${name}：来源已修改，自动采用来源`;
      if (!it.target) return `${name}：来源新增，自动并入`;
      return `${name}：仅来源改动，自动采用来源`;
    }
    if (!it.target) return `${name}：目标已删除，自动删除`;
    if (!it.source && it.base) return `${name}：目标已修改，自动保留目标`;
    if (!it.source) return `${name}：目标新增，自动保留`;
    return `${name}：仅${sideText}改动，自动保留${sideText}`;
  }

  async _commit(id) {
    const res = await this.store.commitMerge(id);
    if (!res.ok) {
      if (res.status === 409) this._toast(res.error, 'error');
      else this._toast(res.error || '合并被阻止', 'error');
      this.render();
      return;
    }
    this._toast(res.idempotent ? '该合并已提交过（幂等，未产生重复事件）' : '合并完成：已在目标分支生成新的合并事件，原分支与历史未改写');
    this.render();
  }

  /* ---------- 已完成 / 已关闭草案 ---------- */

  _renderCompleted(host, draft) {
    const ev = this.store.eventsById.get(draft.mergeEventId);
    const report = draft.report || ev?.merge?.report;
    host.innerHTML = `
      <div class="mg-card">
        <div class="mg-head"><b>✓ 合并完成</b><span class="spacer"></span>
          <button class="mini" data-act="close">关闭</button></div>
        <div class="mg-base">合并事件 #${ev?.seq ?? '?'}「${escapeHtml(ev?.label || '合并分支')}」 · ${new Date(draft.completedAt || ev?.t).toLocaleString()}</div>
        <div id="mg-completed-report"></div>
      </div>`;
    const rh = host.querySelector('#mg-completed-report');
    if (report?.diff) rh.innerHTML = this._reportHtml(report);
    else rh.innerHTML = '<div class="empty-note">合并报告缺失。</div>';
    host.querySelector('[data-act=close]').onclick = () => { this.store.selectMergeDraft(null); this.render(); };
  }

  _renderClosed(host, draft) {
    host.innerHTML = `<div class="mg-card"><div class="mg-head"><b>草案${draft.status === 'abandoned' ? '（已放弃）' : '（已被更新草案取代）'}</b>
      <span class="spacer"></span><button class="mini" data-act="close">关闭</button></div></div>`;
    host.querySelector('[data-act=close]').onclick = () => { this.store.selectMergeDraft(null); this.render(); };
  }

  _reportHtml(r) {
    const itemRows = r.items.map((it) => `<tr>
      <td>${it.kind === 'rect' ? '▭' : '🔗'}</td>
      <td>${escapeHtml(it.name)}</td>
      <td>${it.targetChanged ? '✓' : ''}</td>
      <td>${it.sourceChanged ? '✓' : ''}</td>
      <td><span class="mg-res ${it.resolution}">${{ target: '保留目标', source: '采用来源', manual: '手动', unresolved: '未解决' }[it.resolution] || it.resolution}</span></td>
    </tr>`).join('');
    return `
      <div class="mg-base">共同祖先 #${r.base.seq}「${escapeHtml(r.base.label)}」 · 自动 ${r.autoCount} 项 / 冲突 ${r.conflictCount} 项</div>
      ${diffHtml(r.diff)}
      <h4 class="ver-h">逐项裁决</h4>
      <table class="mg-table"><thead><tr><th></th><th>对象</th><th>目标改</th><th>来源改</th><th>结果</th></tr></thead><tbody>${itemRows}</tbody></table>`;
  }

  /* ---------- 草案列表 ---------- */

  _renderDraftList() {
    const s = this.store;
    const drafts = [...s.mergeDrafts].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (!drafts.length) { this.$draftList.innerHTML = '<div class="empty-note">还没有合并草案。选择两个分支后点“预览合并”。</div>'; return; }
    this.$draftList.innerHTML = drafts.map((d) => {
      const tb = s.branches.find((b) => b.id === d.targetBranchId)?.name || d.targetBranchId;
      const sb = s.branches.find((b) => b.id === d.sourceBranchId)?.name || d.sourceBranchId;
      const st = { open: '进行中', completed: '已完成', abandoned: '已放弃', superseded: '已更新' }[d.status] || d.status;
      const cls = { open: 'st-open', completed: 'st-done', abandoned: 'st-ab', superseded: 'st-su' }[d.status] || '';
      return `<div class="mg-draft ${d.id === s.activeMergeDraftId ? 'active' : ''}" data-id="${d.id}">
        <span class="mg-st ${cls}">${st}</span>
        <b>⎀ ${escapeHtml(sb)} → ${escapeHtml(tb)}</b>
        <span class="mg-draft-meta">冲突选择 ${d.choices.length} · ${d.completedAt ? new Date(d.completedAt).toLocaleDateString() : '未完成'}</span>
        <span class="spacer"></span>
        <button class="mini" data-act="open">${d.status === 'completed' ? '查看报告' : '打开'}</button>
      </div>`;
    }).join('');
    this.$draftList.querySelectorAll('[data-act=open]').forEach((btn) => {
      btn.onclick = () => {
        const id = btn.closest('[data-id]').dataset.id;
        const r = this.store.selectMergeDraft(id);
        if (!r.ok) this._toast('草案无法打开', 'error');
      };
    });
  }
}
