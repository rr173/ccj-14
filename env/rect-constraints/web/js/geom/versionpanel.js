/*
 * 版本面板：保存只读版本 / 版本列表（恢复·发布·删除）/ 两版本差异比较。
 * 所有数据操作都走 Store（持久化 + 并发检查在那里统一处理），
 * 这里只负责渲染和把用户操作翻译成 Store 调用。
 */

import { compareVersions } from './versions.js';

const FIELD_NAME = {
  priority: '优先级', enabled: '启用', gap: '偏移/间距', edge: '边', otherEdge: '对方边',
  axis: '轴', side: '方向', margin: '边距', w: '宽', h: '高',
  rect: '跟随矩形', other: '锚点矩形', kind: '类型',
};

export class VersionPanel {
  constructor(store, hooks) {
    this.store = store;
    this.hooks = hooks; // { toast(text, level) }
    this.$name = document.querySelector('#ver-name');
    this.$list = document.querySelector('#version-list');
    this.$cmpA = document.querySelector('#cmp-a');
    this.$cmpB = document.querySelector('#cmp-b');
    this.$result = document.querySelector('#compare-result');
    this.$count = document.querySelector('#version-count');

    document.querySelector('#btn-save-version').onclick = () => this._save();
    this.$name.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._save(); });
    this.$cmpA.onchange = () => this.store.setCompare(this.$cmpA.value || null, this.$cmpB.value || null);
    this.$cmpB.onchange = () => this.store.setCompare(this.$cmpA.value || null, this.$cmpB.value || null);
  }

  _save() {
    const res = this.store.saveVersion(this.$name.value);
    if (!res.ok) { this.hooks.toast(res.error, 'warn'); return; }
    this.$name.value = '';
    this.hooks.toast(`已保存只读版本「${res.version.name}」（矩形 + 约束 + 求解结果 + 冲突报告）`);
  }

  render() {
    this.$count.textContent = this.store.versions.length;
    this._renderList();
    this._renderCompare();
  }

  /* ---------- 版本列表 ---------- */

  _renderList() {
    const { versions, currentVersionId } = this.store;
    if (!versions.length) {
      this.$list.innerHTML = `<div class="empty-note">还没有版本。<br>把当前布局保存成带名称的只读快照，<br>之后可以在版本间比较或恢复。</div>`;
      return;
    }
    this.$list.innerHTML = '';
    const sorted = [...versions].sort((x, y) => y.createdAt - x.createdAt || (x.id < y.id ? -1 : 1));
    for (const v of sorted) {
      const isCurrent = v.id === currentVersionId;
      const nConf = v.report?.conflicts?.length ?? 0;
      const delWhy = isCurrent ? '当前版本不能删除' : v.published ? '已发布版本不能删除' : '';
      const item = document.createElement('div');
      item.className = 'ver-item' + (isCurrent ? ' current' : '');
      item.innerHTML = `
        <div class="vrow1">
          <span class="vname" title="${escapeHtml(v.name)}">${escapeHtml(v.name)}</span>
          ${isCurrent ? '<span class="vtag tag-current">当前</span>' : ''}
          ${v.published ? '<span class="vtag tag-pub">已发布</span>' : ''}
        </div>
        <div class="vmeta">${fmtTime(v.createdAt)} · hash ${escapeHtml(String(v.hash || '—').slice(0, 8))}<br>
          矩形 ${v.model.rects.length} · 约束 ${v.model.constraints.length} · 冲突 ${nConf}</div>
        <div class="vactions">
          <button class="mini" data-act="restore" title="把该版本内容恢复为新的当前编辑版本（可撤销），原版本保持只读">恢复为当前</button>
          <button class="mini" data-act="pub" title="已发布的版本不能删除">${v.published ? '★ 取消发布' : '☆ 标记发布'}</button>
          <button class="mini danger" data-act="del" ${delWhy ? `disabled title="${delWhy}"` : ''}>删除</button>
        </div>`;
      item.querySelector('[data-act=restore]').onclick = () => this._restore(v);
      item.querySelector('[data-act=pub]').onclick = () => {
        const target = !v.published;
        const res = this.store.setPublished(v.id, target);
        if (!res.ok) this.hooks.toast(res.error, 'warn');
        else this.hooks.toast(target ? `「${v.name}」已标记为发布（不可删除）` : `已取消「${v.name}」的发布标记`);
      };
      if (!delWhy) {
        item.querySelector('[data-act=del]').onclick = () => this._delete(v);
      }
      this.$list.appendChild(item);
    }
  }

  _restore(v) {
    if (!confirm(
      `恢复版本「${v.name}」？\n\n` +
      `当前编辑内容会被替换为该版本的快照，成为新的当前编辑版本（可用 Ctrl+Z 撤销）。\n` +
      `原版本保持只读，不会被修改。`
    )) return;
    const res = this.store.restoreVersion(v.id);
    if (!res.ok) { this.hooks.toast(res.error, 'error'); return; }
    this.hooks.toast(`已把版本「${v.name}」恢复为当前编辑版本`);
  }

  _delete(v) {
    if (!confirm(`删除版本「${v.name}」？该操作不可撤销。`)) return;
    const res = this.store.deleteVersion(v.id);
    if (!res.ok) { this.hooks.toast(res.error, 'warn'); return; }
    this.hooks.toast(`已删除版本「${v.name}」`);
  }

  /* ---------- 版本比较 ---------- */

  _renderCompare() {
    const { versions, compare } = this.store;
    const opts = (sel) => `<option value="">（选择版本）</option>` +
      [...versions]
        .sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : 1))
        .map((v) => `<option value="${v.id}" ${v.id === sel ? 'selected' : ''}>${escapeHtml(v.name)}</option>`)
        .join('');
    this.$cmpA.innerHTML = opts(compare.a);
    this.$cmpB.innerHTML = opts(compare.b);

    const a = versions.find((v) => v.id === compare.a);
    const b = versions.find((v) => v.id === compare.b);
    if (!a || !b) {
      this.$result.innerHTML = `<div class="empty-note">选择两个版本后，这里会显示矩形位置/尺寸、<br>约束增删与冲突变化的差异。比较选择随文档保存，<br>刷新后结果保持一致。</div>`;
      return;
    }
    this.$result.innerHTML = this._diffHtml(compareVersions(a, b));
  }

  _diffHtml(d) {
    const nRect = d.rects.added.length + d.rects.removed.length + d.rects.moved.length + d.rects.resized.length;
    const nCons = d.constraints.added.length + d.constraints.removed.length + d.constraints.changed.length;
    let html = `<div class="diff-sum ${d.identical ? 'same' : ''}">${
      d.identical
        ? '✓ 两个版本内容完全一致'
        : `矩形变化 ${nRect} · 约束变化 ${nCons} · 冲突 ${d.conflicts.before} → ${d.conflicts.after}`
    }</div>`;

    html += `<div class="diff-group"><div class="dg-title">矩形位置 / 尺寸</div>`;
    const rItems = [
      ...d.rects.added.map((x) => `<div class="diff-item add">＋ 新增「${escapeHtml(x.name)}」</div>`),
      ...d.rects.removed.map((x) => `<div class="diff-item del">－ 删除「${escapeHtml(x.name)}」</div>`),
      ...d.rects.moved.map((x) => `<div class="diff-item mod">↔ 「${escapeHtml(x.name)}」位置 ${fmtPos(x.from)} → ${fmtPos(x.to)}</div>`),
      ...d.rects.resized.map((x) => `<div class="diff-item mod">⤢ 「${escapeHtml(x.name)}」尺寸 ${fmtSize(x.from)} → ${fmtSize(x.to)}</div>`),
    ];
    html += rItems.join('') || `<div class="diff-none">无变化</div>`;
    html += `</div>`;

    html += `<div class="diff-group"><div class="dg-title">约束新增 / 删除</div>`;
    const cItems = [
      ...d.constraints.added.map((x) => `<div class="diff-item add">＋ ${escapeHtml(x.label)}</div>`),
      ...d.constraints.removed.map((x) => `<div class="diff-item del">－ ${escapeHtml(x.label)}</div>`),
      ...d.constraints.changed.map((x) =>
        `<div class="diff-item mod">✎ ${escapeHtml(x.label)}<span class="diff-fields">${
          x.fields.map((f) => `${escapeHtml(FIELD_NAME[f.field] || f.field)}: ${escapeHtml(fmtVal(f.from))} → ${escapeHtml(fmtVal(f.to))}`).join('；')
        }</span></div>`),
    ];
    html += cItems.join('') || `<div class="diff-none">无变化</div>`;
    html += `</div>`;

    const trend = d.conflicts.after > d.conflicts.before ? 'del' : d.conflicts.after < d.conflicts.before ? 'add' : 'mod';
    html += `<div class="diff-group"><div class="dg-title">冲突</div>
      <div class="diff-item ${trend}">未满足数量：${d.conflicts.before} → ${d.conflicts.after}</div>
      ${d.conflicts.newUnmet.map((x) => `<div class="diff-item del">✗ 新增未满足：${escapeHtml(x.label)}</div>`).join('')}
      ${d.conflicts.resolved.map((x) => `<div class="diff-item add">✓ 已解决：${escapeHtml(x.label)}</div>`).join('')}
      ${!d.conflicts.newUnmet.length && !d.conflicts.resolved.length && d.conflicts.before === d.conflicts.after ? '<div class="diff-none">未满足项无变化</div>' : ''}
    </div>`;
    return html;
  }
}

function fmtTime(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtPos(p) { return `(${Math.round(p.x)}, ${Math.round(p.y)})`; }
function fmtSize(p) { return `${Math.round(p.w)}×${Math.round(p.h)}`; }
function fmtVal(v) {
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (v === undefined) return '—';
  return String(v);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
