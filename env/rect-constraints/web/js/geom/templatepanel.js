/*
 * 参数化约束模板面板：
 *  - 从所选矩形创建模板（抽取槽位 / 声明哪些参数可在实例覆盖）；
 *  - 把模板版本应用到其他矩形组合（槽位匹配 + 参数覆盖 + 应用前预览
 *    新增/替换/保留约束、求解后位置、未满足项与冲突链）；
 *  - 模板详情（草稿可覆盖性编辑、发布新版本）；
 *  - 实例列表：升级（逐个看差异）/ 固定旧版本 / 取消固定 / 脱离模板。
 * 所有几何与模板数据操作都走 Store（校验 / 环 / 越界 / 持久化 / 并发在那里统一处理）。
 */

import { tplConstraintLabel, diffTemplateVersions } from './templates.js';

export class TemplatePanel {
  constructor(store, hooks) {
    this.store = store;
    this.hooks = hooks; // { toast, getSelectedRectIds }
    this.$list = document.querySelector('#template-list');
    this.$instList = document.querySelector('#template-instance-list');
    this.$warn = document.querySelector('#tpl-warnings');
    this.$count = document.querySelector('#tpl-count');
    this.$newBtn = document.querySelector('#btn-new-tpl');

    this.newDlg = this._bindModal('tpl-new');
    this.applyDlg = this._bindModal('tpl-apply');
    this.editDlg = this._bindModal('tpl-edit');

    // 对话框工作状态
    this._newDraft = null;     // 创建对话框内编辑的草稿
    this._newName = '';
    this._applyCtx = null;     // {templateId, versionNo, instanceId?, mapping, params}
    this._editId = null;       // 详情对话框打开的模板 id
    this._editDraftBaseRev = 0;

    this.$newBtn.onclick = () => this.openCreate();
    document.querySelector('#tpl-edit-publish').onclick = () => this._publishFromEditor();
  }

  _bindModal(prefix) {
    const root = document.querySelector('#' + prefix + '-dlg');
    return {
      root,
      body: root.querySelector('#' + prefix + '-body'),
      error: root.querySelector('#' + prefix + '-error'),
      open: () => root.classList.remove('hidden'),
      close: () => root.classList.add('hidden'),
      ok: root.querySelector('#' + prefix + '-ok'),
      cancel: root.querySelector('#' + prefix + '-cancel'),
    };
  }

  closeAll() {
    this.newDlg.close(); this.applyDlg.close(); this.editDlg.close();
  }

  toast(t, level = '') { this.hooks.toast(t, level); }

  render() {
    const s = this.store;
    this.$count.textContent = s.templates.length;
    this.$count.classList.toggle('zero', s.templates.length === 0);
    this.$newBtn.disabled = !!s.replaying;
    this._renderWarnings();
    this._renderTemplates();
    this._renderInstances();
  }

  /* ---------------- 顶部冲突横幅 ---------------- */

  _renderWarnings() {
    const c = this.store.templateConflict;
    if (!c) { this.$warn.classList.add('hidden'); this.$warn.innerHTML = ''; return; }
    const t = this.store.templateById(c.templateId);
    this.$warn.classList.remove('hidden');
    this.$warn.innerHTML = `
      <div class="tpl-conf">
        <b>⚠ 模板草稿版本冲突</b>：模板「${escapeHtml(t?.name || c.templateId)}」已在另一个页面保存了更新草稿
        （v 草稿 ${c.serverDraftRev}，本地基于 ${c.localDraftRev}）。为避免覆盖对方，<b>本地草稿已保留但未保存</b>。
        <div class="tpl-conf-actions">
          <button class="mini" data-act="discard">放弃本地草稿（采用对方）</button>
          <button class="mini primary" data-act="saveas">把本地草稿另存为新模板…</button>
        </div>
      </div>`;
    this.$warn.querySelector('[data-act=discard]').onclick = () => {
      this.store.discardLocalTemplateDraft(c.templateId);
      this.toast('已放弃本地草稿，采用另一页面保存的版本');
    };
    this.$warn.querySelector('[data-act=saveas]').onclick = () => {
      const name = prompt('把本地草稿另存为新模板，名称：', (t?.name || '模板') + '（本地副本）');
      if (name === null) return;
      const res = this.store.saveLocalDraftAsNewTemplate(c.templateId, name);
      if (!res.ok) { this.toast(res.error, 'error'); return; }
      this.toast('已把本地草稿另存为新模板（对方版本未被改写）');
    };
  }

  /* ---------------- 模板列表 ---------------- */

  _renderTemplates() {
    const list = this.store.templates;
    if (!list.length) {
      this.$list.innerHTML = `<div class="empty-note">还没有模板。<br>先在画布上选中一组矩形并在它们之间建立约束，<br>再点上方按钮保存成参数化模板。</div>`;
      return;
    }
    this.$list.innerHTML = '';
    const sorted = [...list].sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
    const links = this.store.instanceLinks();
    for (const t of sorted) {
      const nInst = this.store.templateInstances.filter((i) => i.templateId === t.id && i.status !== 'detached').length;
      const latest = t.versions[t.versions.length - 1];
      const item = document.createElement('div');
      item.className = 'ver-item tpl-item';
      item.innerHTML = `
        <div class="vrow1">
          <span class="vname" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</span>
          <span class="vtag tag-pub">v${t.publishedNo || latest?.no || 0}</span>
          ${t.draft ? '<span class="vtag tag-draft" title="存在可继续编辑、可发布为新版本的草稿">草稿</span>' : ''}
        </div>
        <div class="vmeta">
          槽位 ${latest?.slots.length || t.draft?.slots.length || 0} ·
          模板约束 ${latest?.constraints.length || t.draft?.constraints.length || 0} ·
          版本 ${t.versions.length} · 实例 ${nInst}
        </div>
        <div class="vactions">
          <button class="mini primary" data-act="apply" ${latest ? '' : 'disabled'}>应用到矩形…</button>
          <button class="mini" data-act="open">模板详情 / 新版本</button>
        </div>`;
      item.querySelector('[data-act=apply]').onclick = () => this.openApply(t.id);
      item.querySelector('[data-act=open]').onclick = () => this.openEditor(t.id);
      this.$list.appendChild(item);
    }
  }

  /* ---------------- 实例列表 ---------------- */

  _renderInstances() {
    const s = this.store;
    const links = s.instanceLinks();
    const rows = s.templateInstances.map((ins) => {
      const link = links.get(ins.id);
      return { ins, link };
    }).filter(({ ins, link }) => link && link.status !== 'absent');

    if (!rows.length) {
      this.$instList.innerHTML = `<div class="empty-note" style="margin-top:8px">当前分支还没有链接的模板实例。<br>应用模板后，可在这里升级、固定旧版本或脱离模板。</div>`;
      return;
    }
    this.$instList.innerHTML = '';
    for (const { ins, link } of rows.sort((a, b) => b.ins.updatedAt - a.ins.updatedAt)) {
      const t = s.templateById(ins.templateId);
      const latestNo = t?.publishedNo || ins.versionNo;
      const canUpgrade = !!t && link.status === 'linked' && latestNo > ins.versionNo;
      const slotNames = Object.entries(ins.mapping).map(([slot, rid]) => {
        const r = s.model.rects.find((x) => x.id === rid);
        return `${slot}→${r ? (r.name || rid.slice(-4)) : '?'}`;
      }).join('，');
      const item = document.createElement('div');
      item.className = 'ver-item tpl-inst' + (link.status === 'partial' ? ' partial' : '');
      item.innerHTML = `
        <div class="vrow1">
          <span class="vname">${escapeHtml(ins.templateName || '模板')} · v${ins.versionNo}${link.versionNo !== ins.versionNo ? ` (画布 v${link.versionNo})` : ''}</span>
          ${link.pinned ? '<span class="vtag tag-pin" title="已固定在该版本，不随新版本升级">📌 已固定</span>' : ''}
          ${link.status === 'partial' ? '<span class="vtag tag-warn" title="部分模板约束已不在画布（可能被手动删除）">部分链接</span>' : ''}
          ${canUpgrade ? `<span class="vtag tag-up">可升级 v${latestNo}</span>` : ''}
        </div>
        <div class="vmeta">槽位：${escapeHtml(slotNames || '—')}</div>
        ${ins.lastError ? `<div class="tpl-lasterr" title="最近一次升级失败原因">⛔ ${escapeHtml(typeof ins.lastError === 'string' ? ins.lastError : (ins.lastError.errors?.[0]?.message || ins.lastError.error || '升级失败'))}</div>` : ''}
        <div class="vactions">
          ${canUpgrade ? `<button class="mini primary" data-act="upgrade">预览升级到 v${latestNo}…</button>` : ''}
          ${link.pinned
            ? `<button class="mini" data-act="unpin">取消固定</button>`
            : `<button class="mini" data-act="pin" title="继续使用当前版本，不随新版本升级">固定此版本</button>`}
          <button class="mini danger" data-act="detach" title="移除模板链接，约束保留为普通约束">脱离模板</button>
        </div>`;
      const $ = (a) => item.querySelector(`[data-act=${a}]`);
      if (canUpgrade) $('upgrade')?.addEventListener('click', () => this.openUpgrade(ins.id, latestNo));
      $('pin')?.addEventListener('click', () => {
        const r = s.pinInstanceVersion(ins.id);
        if (r.ok) this.toast(`已固定实例在 v${ins.versionNo}（可撤销）`); else this.toast(r.error, 'error');
      });
      $('unpin')?.addEventListener('click', () => {
        const r = s.unpinInstanceVersion(ins.id);
        if (r.ok) this.toast('已取消固定（可撤销）'); else this.toast(r.error, 'error');
      });
      $('detach')?.addEventListener('click', () => {
        if (!confirm('脱离模板？该实例的约束会保留为普通约束（移除模板链接），此操作可撤销。')) return;
        const r = s.detachInstance(ins.id);
        if (r.ok) this.toast('实例已脱离模板，约束保留'); else this.toast(r.error, 'error');
      });
      this.$instList.appendChild(item);
    }
  }

  /* ---------------- 创建模板 ---------------- */

  openCreate() {
    if (this.store.replaying) { this.toast('回放模式为只读，不能创建模板', 'warn'); return; }
    const ids = [...(this.hooks.getSelectedRectIds?.() || [])];
    if (!ids.length) { this.toast('请先在画布上选中要保存为模板槽位的矩形', 'warn'); return; }
    const preview = this.store.previewExtractTemplate(ids);
    if (!preview.ok) {
      this._newDraft = null;
      this.newDlg.body.innerHTML = `<div class="empty-note">${preview.errors.map(escapeHtml).join('<br>')}</div>`;
      this.newDlg.error.innerHTML = '';
      this.newDlg.ok.disabled = true;
    } else {
      this._newDraft = preview.draft;
      this._newName = '';
      this.newDlg.ok.disabled = false;
      this.newDlg.error.innerHTML = '';
      this._renderNewBody();
    }
    this.newDlg.cancel.onclick = () => this.newDlg.close();
    document.querySelector('#tpl-new-close').onclick = () => this.newDlg.close();
    this.newDlg.ok.onclick = () => this._submitCreate();
    this.newDlg.open();
  }

  _renderNewBody() {
    const d = this._newDraft;
    this.newDlg.body.innerHTML = `
      <div class="field-row"><label>模板名称</label>
        <input type="text" id="tpl-new-name" placeholder="如：标题-副标题对齐" maxlength="40" value="${escapeHtml(this._newName)}" />
      </div>
      <div class="note">模板用具名槽位代替具体矩形。下列约束被纳入模板；勾选哪些参数允许在每个实例里覆盖。</div>
      <div class="tpl-slots"><b>槽位（${d.slots.length}）：</b>
        ${d.slots.map((s) => `<span class="slot-chip" title="槽位 ${escapeHtml(s.id)}">${escapeHtml(s.label)} <code>${escapeHtml(s.id)}</code></span>`).join('')}
      </div>
      <div id="tpl-new-cons"></div>`;
    document.querySelector('#tpl-new-name').oninput = (e) => (this._newName = e.target.value);
    this._renderConstraintOverrideTable(d, document.querySelector('#tpl-new-cons'), (key, field, flag) => {
      this._newDraft = this._toggleOverride(this._newDraft, key, field, flag);
      this._renderNewBody();
      document.querySelector('#tpl-new-name').focus();
    });
  }

  _toggleOverride(draft, key, field, flag) {
    // 直接改草稿里的 overrides（再经 store 的规范化在保存时兜底）
    const c = draft.constraints.find((x) => x.key === key);
    if (c?.overrides?.[field]) c.overrides[field] = { ...c.overrides[field], overridable: flag };
    return draft;
  }

  _submitCreate() {
    const name = (document.querySelector('#tpl-new-name')?.value || '').trim();
    if (!name) { this.newDlg.error.textContent = '请填写模板名称'; return; }
    const res = this.store.createTemplate(name, this._newDraft, { publish: true });
    if (!res.ok) { this.newDlg.error.innerHTML = (res.errors || [res.error]).map(escapeHtml).join('<br>'); return; }
    this.newDlg.close();
    this.toast(`已创建并发布模板「${name}」v1（${res.version.constraints.length} 条约束）`);
  }

  /* ---------------- 应用模板 ---------------- */

  openApply(templateId, instanceId = null) {
    const s = this.store;
    const t = s.templateById(templateId);
    if (!t) { this.toast('模板不存在', 'error'); return; }
    const existing = instanceId ? s.instanceById(instanceId) : null;
    const no = existing ? existing.versionNo : (t.publishedNo || t.versions[t.versions.length - 1]?.no);
    const version = t.versions.find((v) => v.no === no);
    if (!version) { this.toast('该模板还没有已发布版本', 'warn'); return; }
    // 默认映射：尽量按槽位标签/顺序预选当前画布矩形
    const mapping = {};
    const rects = s.model.rects;
    version.slots.forEach((slot, i) => {
      mapping[slot.id] = existing?.mapping?.[slot.id] || rects[i]?.id || '';
    });
    this._applyCtx = { templateId, versionNo: no, instanceId, mapping, params: structuredClone(existing?.params || {}) };
    document.querySelector('#tpl-apply-title').textContent = existing
      ? `重新应用实例 · 模板「${t.name}」v${no}`
      : `应用模板「${t.name}」v${no}`;
    document.querySelector('#tpl-apply-close').onclick = () => this.applyDlg.close();
    this.applyDlg.cancel.onclick = () => this.applyDlg.close();
    this.applyDlg.ok.textContent = existing ? '确认替换' : '确认应用';
    this.applyDlg.ok.onclick = () => this._submitApply();
    this.applyDlg.error.innerHTML = '';
    this.applyDlg.open();
    this._renderApplyBody();
  }

  openUpgrade(instanceId, targetNo) {
    // 升级走独立预览（差异 + 求解），确认后调用 upgradeInstance
    this._upgradeCtx = { instanceId, targetNo };
    this._renderUpgradeDialog();
  }

  _renderApplyBody() {
    const s = this.store;
    const { templateId, versionNo, instanceId, mapping, params } = this._applyCtx;
    const t = s.templateById(templateId);
    const version = t.versions.find((v) => v.no === versionNo);
    const rectOpts = (sel) =>
      `<option value="">（选择矩形）</option>` +
      s.model.rects.map((r) => `<option value="${r.id}" ${r.id === sel ? 'selected' : ''}>${escapeHtml(r.name || r.id.slice(-5))}</option>`).join('');

    const slotRows = version.slots.map((slot) => `
      <div class="field-row">
        <label title="槽位 ${escapeHtml(slot.id)}">槽位 ${escapeHtml(slot.label)}</label>
        <select data-slot="${slot.id}">${rectOpts(mapping[slot.id])}</select>
      </div>`).join('');

    this.applyDlg.body.innerHTML = `
      <div class="note">为每个槽位匹配一个矩形。每个槽位必须匹配且不能重复占用同一矩形；
      应用前会先预览新增约束、求解后矩形位置、未满足项与冲突链。</div>
      <div class="tpl-slots-grid">${slotRows}</div>
      <div id="tpl-apply-params"></div>
      <div id="tpl-apply-preview"></div>`;
    this.applyDlg.body.querySelectorAll('select[data-slot]').forEach((sel) => {
      sel.onchange = () => { this._applyCtx.mapping[sel.dataset.slot] = sel.value; this._refreshApplyPreview(); };
    });
    this._renderApplyParams(version, params);
    this._refreshApplyPreview();
  }

  _renderApplyParams(version, params) {
    const host = this.applyDlg.body.querySelector('#tpl-apply-params');
    const overridable = [];
    for (const c of version.constraints) {
      for (const [field, spec] of Object.entries(c.overrides || {})) {
        if (spec.overridable) overridable.push({ c, field, spec });
      }
    }
    if (!overridable.length) { host.innerHTML = ''; return; }
    host.innerHTML = `<h4 class="ver-h">实例参数覆盖（留空用模板默认）</h4><div id="tpl-apply-params-list"></div>`;
    const list = host.querySelector('#tpl-apply-params-list');
    const slotName = (id) => version.slots.find((s) => s.id === id)?.label || id;
    for (const { c, field, spec } of overridable) {
      const cur = params[c.key]?.[field];
      const row = document.createElement('div');
      row.className = 'field-row';
      row.innerHTML = `<label title="${escapeHtml(tplConstraintLabel(c, slotName))}">${escapeHtml(tplConstraintLabel(c, slotName))} · ${paramLabel(field)}</label>`;
      if (['edge', 'otherEdge', 'side'].includes(field)) {
        const opts = paramEnum(field);
        row.innerHTML += `<select data-k="${c.key}" data-f="${field}">
          <option value="">默认 (${escapeHtml(String(spec.value))})</option>
          ${opts.map(([v, w]) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${w}</option>`).join('')}
        </select>`;
      } else {
        row.innerHTML += `<input type="number" data-k="${c.key}" data-f="${field}" placeholder="默认 ${spec.value}" value="${cur ?? ''}" />`;
      }
      list.appendChild(row);
    }
    list.querySelectorAll('[data-k]').forEach((el) => {
      el.onchange = () => {
        const k = el.dataset.k, f = el.dataset.f;
        const val = el.value;
        this._applyCtx.params[k] = this._applyCtx.params[k] || {};
        if (val === '') delete this._applyCtx.params[k][f];
        else this._applyCtx.params[k][f] = ['edge', 'otherEdge', 'side'].includes(f) ? val : Number(val);
        if (!Object.keys(this._applyCtx.params[k]).length) delete this._applyCtx.params[k];
        this._refreshApplyPreview();
      };
    });
  }

  _refreshApplyPreview() {
    const s = this.store;
    const host = this.applyDlg.body.querySelector('#tpl-apply-preview');
    const { templateId, versionNo, instanceId, mapping, params } = this._applyCtx;
    const r = s.planTemplate({ templateId, versionNo, mapping, params, instanceId });
    const p = r.plan;
    this.applyDlg.ok.disabled = !p?.ok;
    if (!p) { host.innerHTML = ''; return; }
    if (!p.ok) {
      host.innerHTML = `<div class="tpl-prev-errors"><b>无法应用：</b><ul>${p.errors.map((e) => `<li>${escapeHtml(e.message)}</li>`).join('')}</ul></div>`;
      return;
    }
    host.innerHTML = this._planPreviewHtml(p, r.template, { showKept: !!instanceId });
  }

  /** 把一个应用/升级计划渲染成：新增/替换/保留 + 求解后位置 + 未满足 + 冲突链。 */
  _planPreviewHtml(p, template, { showKept = false } = {}) {
    const slotNameOf = (id) => {
      const v = template.versions.find((x) => x.no === p.versionNo);
      return v?.slots.find((s) => s.id === id)?.label || id;
    };
    const ch = p.changes;
    const changeBlock = (title, items, cls) => items.length ? `
      <div class="tpl-chg ${cls}"><b>${title}（${items.length}）</b>
        <ul>${items.map((it) => `<li>${escapeHtml(changeText(it, p.constraints, slotNameOf))}</li>`).join('')}</ul>
      </div>` : '';
    const movedRects = [...new Set(p.constraints.map((c) => c.rect))];
    const posRows = movedRects.map((rid) => {
      const r = p.model.rects.find((x) => x.id === rid);
      const rep = p.report.rects[rid] || r;
      return `<li>${escapeHtml(r?.name || rid.slice(-4))}: (${rep.x}, ${rep.y}) ${rep.w}×${rep.h}</li>`;
    }).join('');
    const unmet = p.report.conflicts || [];
    return `
      <h4 class="ver-h">约束变更预览</h4>
      <div class="tpl-chg-grid">
        ${changeBlock('将新增', ch.added, 'add')}
        ${changeBlock('将替换', ch.replaced, 'rep')}
        ${showKept ? changeBlock('将保留', ch.kept, 'keep') : ''}
        ${changeBlock('将移除', ch.removed, 'rm')}
      </div>
      <h4 class="ver-h">求解后矩形位置</h4>
      <ul class="tpl-pos">${posRows}</ul>
      <h4 class="ver-h">未满足项与冲突链</h4>
      ${unmet.length ? `<div class="tpl-unmet"><ul>${unmet.map((u) => `
        <li><b>${escapeHtml(u.label)}</b>（偏差 ${Math.abs(u.measure).toFixed(1)}）
          <ol class="tpl-chain">${(u.chain || []).map((x) => `<li>${escapeHtml(x)}</li>`).join('') || '<li>画布/拖动硬约束</li>'}</ol>
        </li>`).join('')}</ul></div>`
        : '<div class="tpl-ok">✓ 求解后所有模板约束均满足，无冲突。</div>'}
      ${(p.dropped || []).length ? `<div class="note">部分实例覆盖不适用于该版本（字段不再可覆盖/已移除），将被忽略：${p.dropped.map((d) => `${d.key}.${d.field}`).join('，')}</div>` : ''}
    `;
  }

  _submitApply() {
    const s = this.store;
    const { templateId, versionNo, instanceId, mapping, params } = this._applyCtx;
    if (instanceId) {
      // 重新应用 = 在同版本替换（沿用 upgradeInstance 的原子替换管线）
      const r = s.upgradeInstance(instanceId, versionNo, { params });
      if (!r.ok) { this.applyDlg.error.textContent = r.error; return; }
      this.applyDlg.close(); this.toast('实例已按预览更新（可撤销）');
      return;
    }
    const r = s.applyTemplate({ templateId, versionNo, mapping, params });
    if (!r.ok) { this.applyDlg.error.textContent = r.duplicate ? r.error : (r.errors?.[0]?.message || r.error); return; }
    this.applyDlg.close();
    this.toast(`已创建实例：新增 ${r.addedCids.length} 条模板约束（可撤销）`);
  }

  /* ---------------- 升级对话框（逐个实例差异） ---------------- */

  _renderUpgradeDialog() {
    const s = this.store;
    const { instanceId, targetNo } = this._upgradeCtx;
    const ins = s.instanceById(instanceId);
    const t = s.templateById(ins.templateId);
    const fromV = t.versions.find((v) => v.no === ins.versionNo);
    const toV = t.versions.find((v) => v.no === targetNo);
    const diff = diffTemplateVersions(fromV, toV);
    // 重新计算计划（含实例当前映射/参数迁移）
    const previews = s.upgradePreviewsForNewVersion(t.id, targetNo).filter((x) => x.instanceId === instanceId);
    const pv = previews[0];

    document.querySelector('#tpl-apply-title').textContent = `升级实例 ·「${t.name}」v${ins.versionNo} → v${targetNo}`;
    this.applyDlg.ok.textContent = `升级到 v${targetNo}`;
    document.querySelector('#tpl-apply-close').onclick = () => this.applyDlg.close();
    this.applyDlg.cancel.onclick = () => this.applyDlg.close();

    const diffHtml = renderTemplateDiff(diff);
    let body;
    if (!pv) {
      body = `<div class="tpl-prev-errors">无法为该实例生成升级预览（实例可能未链接到当前分支）。</div>`;
      this.applyDlg.ok.disabled = true;
    } else if (!pv.ok) {
      body = `${diffHtml}
        <div class="tpl-prev-errors"><b>升级将失败，已阻止（不会改动当前约束）：</b>
          <ul>${pv.errors.map((e) => `<li>${escapeHtml(e.message)}</li>`).join('')}</ul></div>`;
      this.applyDlg.ok.disabled = true;
    } else {
      // 复用计划预览渲染（新增/替换/保留 + 求解后位置 + 未满足 + 冲突链）
      const planLike = {
        versionNo: targetNo, constraints: pv.constraints || [],
        changes: pv.changes, model: pv.model, report: pv.report, dropped: pv.dropped,
      };
      body = `${diffHtml}${pv.pinned ? '<div class="note">该实例当前已固定在旧版本；升级将取消固定并应用新版本。</div>' : ''}` +
        this._planPreviewHtml(planLike, t, { showKept: true });
      this.applyDlg.ok.disabled = false;
    }
    this.applyDlg.body.innerHTML = body;
    this.applyDlg.error.innerHTML = '';
    this.applyDlg.ok.onclick = () => {
      const r = s.upgradeInstance(instanceId, targetNo);
      if (!r.ok) { this.applyDlg.error.textContent = r.error; this._renderUpgradeDialog(); return; }
      this.applyDlg.close();
      this.toast(`实例已升级到 v${targetNo}（原子替换，可撤销）`);
    };
    this.applyDlg.open();
  }

  /* ---------------- 模板详情 / 草稿编辑 / 发布 ---------------- */

  openEditor(templateId) {
    const t = this.store.templateById(templateId);
    if (!t) return;
    this._editId = templateId;
    document.querySelector('#tpl-edit-title').textContent = `模板「${t.name}」`;
    document.querySelector('#tpl-edit-close').onclick = () => this.editDlg.close();
    document.querySelector('#tpl-edit-done').onclick = () => this.editDlg.close();
    this.editDlg.error.innerHTML = '';
    this.editDlg.open();
    this._renderEditor();
  }

  _renderEditor() {
    const s = this.store;
    const t = s.templateById(this._editId);
    if (!t) { this.editDlg.close(); return; }
    this._editDraftBaseRev = t.draftRev;
    const versions = [...t.versions].sort((a, b) => b.no - a.no);
    const body = this.editDlg.body;
    body.innerHTML = `
      <div class="note">已发布版本只读、不可改写。修改草稿后点底部「发布为新版本」，已链接的实例不会被自动改动，可逐个预览升级。</div>
      <div class="tpl-version-tabs" id="tpl-vtabs"></div>
      <div id="tpl-version-detail"></div>`;
    const tabs = body.querySelector('#tpl-vtabs');
    tabs.innerHTML = [
      t.draft ? `<button class="mini" data-v="draft">草稿 (r${t.draftRev})</button>` : '',
      ...versions.map((v) => `<button class="mini" data-v="${v.no}">v${v.no}</button>`),
    ].join('');
    let active = this._editActiveVersion || (t.draft ? 'draft' : versions[0]?.no);
    if (active === 'draft' && !t.draft) active = versions[0]?.no;
    const renderTab = (sel) => {
      tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('primary', String(b.dataset.v) === String(sel)));
      this._renderVersionDetail(sel);
    };
    tabs.querySelectorAll('button').forEach((b) => b.onclick = () => { this._editActiveVersion = b.dataset.v === 'draft' ? 'draft' : Number(b.dataset.v); renderTab(this._editActiveVersion); });
    renderTab(active);
    document.querySelector('#tpl-edit-publish').style.display = t.draft ? '' : 'none';
  }

  _renderVersionDetail(sel) {
    const s = this.store;
    const t = s.templateById(this._editId);
    const host = this.editDlg.body.querySelector('#tpl-version-detail');
    const isDraft = sel === 'draft';
    const version = isDraft ? t.draft : t.versions.find((v) => v.no === sel);
    if (!version) { host.innerHTML = ''; return; }
    const slotName = (id) => version.slots.find((x) => x.id === id)?.label || id;
    host.innerHTML = `
      <div class="tpl-slots"><b>槽位（${version.slots.length}）：</b>
        ${version.slots.map((sl) => `<span class="slot-chip">${escapeHtml(sl.label)} <code>${escapeHtml(sl.id)}</code></span>`).join('')}
      </div>
      <div class="note">${isDraft ? '勾选参数的「可覆盖」以允许实例覆盖；修改即时保存为草稿（带乐观锁，另一页面已保存会提示冲突）。' : '只读版本。'}</div>
      <div id="tpl-edit-cons"></div>`;
    const consHost = host.querySelector('#tpl-edit-cons');
    for (const c of version.constraints) {
      const card = document.createElement('div');
      card.className = 'tpl-con-card';
      const ovRows = Object.entries(c.overrides || {}).map(([field, spec]) => `
        <label class="tpl-ov" title="${isDraft ? '允许实例覆盖此参数' : '已发布版本不可改写'}">
          <input type="checkbox" data-k="${c.key}" data-f="${field}" ${spec.overridable ? 'checked' : ''} ${isDraft ? '' : 'disabled'} />
          ${paramLabel(field)} <code>${escapeHtml(String(spec.value))}</code>
        </label>`).join('');
      card.innerHTML = `
        <div class="tpl-con-title">${escapeHtml(tplConstraintLabel(c, slotName))} <span class="vmeta">[${c.key}]</span></div>
        <div class="tpl-ov-row">${ovRows}</div>`;
      consHost.appendChild(card);
    }
    if (isDraft) {
      consHost.querySelectorAll('input[type=checkbox][data-k]').forEach((cb) => {
        cb.onchange = () => {
          const r = s.setTemplateOverridable(this._editId, cb.dataset.k, cb.dataset.f, cb.checked, this._editDraftBaseRev);
          if (!r.ok) {
            cb.checked = !cb.checked;
            if (r.conflict) { this.toast('模板草稿已在另一页面更新：本地草稿已保留，请处理顶部冲突', 'error'); this.editDlg.close(); this.render(); }
            else this.toast(r.error, 'error');
            return;
          }
          this._editDraftBaseRev = r.draftRev;
          this._renderEditor();
        };
      });
    }
  }

  _publishFromEditor() {
    const s = this.store;
    const t = s.templateById(this._editId);
    if (!t?.draft) return;
    const no = (t.publishedNo || t.versions.length) + 1;
    // 发布前先给出将影响哪些实例
    const res = s.publishTemplate(this._editId);
    if (!res.ok) { this.editDlg.error.textContent = res.error; return; }
    this.editDlg.error.textContent = '';
    this.toast(`已发布「${t.name}」v${no}（只读，旧版本与实例未被改写）。可在实例列表逐个预览升级。`);
    this._editActiveVersion = no;
    this._renderEditor();
    this.render();
  }
}

/* ---------------- 文案 / 渲染小工具 ---------------- */

function paramLabel(field) {
  return {
    gap: '间距/偏移', margin: '画布边距', w: '锁定宽', h: '锁定高',
    priority: '优先级', edge: '跟随边', otherEdge: '锚点边', side: '相对方向',
  }[field] || field;
}
function paramEnum(field) {
  if (field === 'edge' || field === 'otherEdge') return [['l', '左'], ['r', '右'], ['t', '顶'], ['b', '底'], ['mid', '中']];
  return [['left', '在…左侧'], ['right', '在…右侧'], ['above', '在…上方'], ['below', '在…下方']];
}

function changeText(it, allConstraints, slotName) {
  const c = it.to || allConstraints.find((x) => x.tpl?.key === it.key) || it;
  const base = `${kindWord(it.kind || c.kind)} · 槽位约束 ${it.key}`;
  if (it.fields?.length) {
    const fs = it.fields.map((f) => `${paramLabel(f.field)}：${fmtVal(f.from)} → ${fmtVal(f.to)}`).join('；');
    return `${base}（${fs}）`;
  }
  return base;
}
function kindWord(k) {
  return { snap: '贴齐', minGap: '最小间距', contain: '画布包含', lock: '锁定尺寸' }[k] || k;
}
function fmtVal(v) { return v === undefined || v === null ? '—' : String(v); }

function renderTemplateDiff(diff) {
  const line = (arr, word, cls) => arr.length ? `<li class="${cls}">${word}：${arr.map((x) => x.key).join('，')}</li>` : '';
  const changed = diff.changed.map((c) => {
    const fs = [...c.fields.map((f) => `${paramLabel(f.field)} ${fmtVal(f.from)}→${fmtVal(f.to)}`),
      ...c.overrides.map((o) => `可覆盖[${paramLabel(o.field)}]`)];
    return `<li class="rep">${c.key}：${fs.join('；') || '参数变化'}</li>`;
  }).join('');
  return `
    <h4 class="ver-h">模板版本差异 v${diff.fromNo} → v${diff.toNo}</h4>
    <ul class="tpl-diff">
      ${line(diff.added, '新增约束', 'add')}
      ${line(diff.removed, '移除约束', 'rm')}
      ${changed}
      ${diff.slots.added.length ? `<li class="add">新增槽位：${diff.slots.added.map((s) => s.id).join('，')}（升级时需补匹配矩形）</li>` : ''}
      ${diff.slots.removed.length ? `<li class="rm">移除槽位：${diff.slots.removed.map((s) => s.id).join('，')}</li>` : ''}
      ${diff.identical ? '<li>两个版本的模板定义完全相同。</li>' : ''}
    </ul>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
