/*
 * 差异结果渲染（版本比较 / 分支比较共用）。
 * 输入是 versions.compareVersions(a,b) 的确定性差异报告，输出 HTML 字符串。
 */

export const FIELD_NAME = {
  priority: '优先级', enabled: '启用', gap: '偏移/间距', edge: '边', otherEdge: '对方边',
  axis: '轴', side: '方向', margin: '边距', w: '宽', h: '高',
  rect: '跟随矩形', other: '锚点矩形', kind: '类型',
};

export function diffHtml(d) {
  const nRect = d.rects.added.length + d.rects.removed.length + d.rects.moved.length + d.rects.resized.length;
  const nCons = d.constraints.added.length + d.constraints.removed.length + d.constraints.changed.length;
  let html = `<div class="diff-sum ${d.identical ? 'same' : ''}">${
    d.identical
      ? '✓ 内容完全一致（矩形 / 约束 / 冲突均无差异）'
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

  html += `<div class="diff-group"><div class="dg-title">约束新增 / 删除 / 修改</div>`;
  const cItems = [
    ...d.constraints.added.map((x) => `<div class="diff-item add">＋ ${escapeHtml(x.label)}</div>`),
    ...d.constraints.removed.map((x) => `<div class="diff-item del">－ ${escapeHtml(x.label)}</div>`),
    ...d.constraints.changed.map((x) =>
      `<div class="diff-item mod">✎ ${escapeHtml(x.label)}<span class="diff-fields">${
        x.fields
          .filter((f) => f.field !== 'id')
          .map((f) => `${escapeHtml(FIELD_NAME[f.field] || f.field)}: ${escapeHtml(fmtVal(f.from))} → ${escapeHtml(fmtVal(f.to))}`).join('；')
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

export function fmtPos(p) { return `(${Math.round(p.x)}, ${Math.round(p.y)})`; }
export function fmtSize(p) { return `${Math.round(p.w)}×${Math.round(p.h)}`; }
export function fmtVal(v) {
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (v === undefined) return '—';
  return String(v);
}
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
