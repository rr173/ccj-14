/*
 * 旧版布局批量迁移工作台面板：
 * - 多文件选择：识别格式 + 逐文件迁移预览（矩形/约束/分支/版本映射、隔离项、未知字段）；
 * - 确认后批次隔离执行：逐文件独立成功/失败，批次进度与每份文件转换结果实时显示；
 * - 暂停 / 继续 / 取消；服务中断恢复后自动从已完成文件之后续跑；
 * - 成功文件导入为新编辑分支（显示导入后差异摘要）；失败文件保留原始输入/错误位置/修复建议/重试；
 * - 导出迁移报告（源摘要 + 映射表 + 隔离项 + 错误 + 最终分支标识）。
 */

import { diffHtml } from './diff.js';

const BATCH_LABEL = { queued: '排队中', running: '运行中', paused: '已暂停', done: '已结束', cancelled: '已取消' };
const FILE_LABEL = { queued: '排队', running: '转换中', done: '成功', failed: '失败', cancelled: '已取消' };
const FORMAT_LABEL = {
  current: '当前规范模型',
  'legacy-doc': '旧审计文档 entries/idx',
  'v2017-flat': '2017 boxes/links',
  'v2015-tables': '2015 RC-TABLES',
  unknown: '无法识别',
};

export class MigrationPanel {
  constructor(store, hooks) {
    this.store = store;
    this.hooks = hooks; // { toast }
    this.$count = document.querySelector('#mig-count');
    this.$list = document.querySelector('#migration-list');
    this.$preview = document.querySelector('#mig-preview');
    this.$warnings = document.querySelector('#mig-warnings');
    this.$files = document.querySelector('#mig-files');
    this.$auto = document.querySelector('#mig-auto-import');
    this.$btnReport = document.querySelector('#btn-mig-report');
    this.$btnPick = document.querySelector('#btn-mig-pick');

    this.pending = null; // {files:[ingest 草稿], autoImport}
    this.expanded = new Set();   // 展开详情的 key: batchId/fileId
    this.diffOpen = new Set();   // 展开导入差异

    document.querySelector('#btn-mig-pick').onclick = () => this.$files.click();
    this.$files.onchange = () => this.onPick();
    this.$btnReport.onclick = () => this.exportReport();

    store.addEventListener('migrations', () => this.render());
    store.addEventListener('branch', () => this.render());
  }

  /* ---------------- 选择文件 / 预览 ---------------- */

  async onPick() {
    const picked = [...this.$files.files];
    this.$files.value = '';
    if (!picked.length) return;
    const files = [];
    for (const file of picked) {
      const text = await file.text().catch(() => '');
      files.push({ name: file.name, text, size: file.size });
    }
    const drafts = this.store.previewMigrations(files);
    this.pending = { files: drafts, autoImport: this.$auto.checked };
    this.render();
    const okN = drafts.filter((d) => d.preview?.ok && !d.duplicateOf).length;
    this.hooks.toast(`已识别 ${drafts.length} 份文件：${okN} 份可迁移，请确认预览后开始正式迁移`);
  }

  clearPending() { this.pending = null; this.render(); }

  startBatch() {
    if (!this.pending) return;
    const uniqueFiles = this.pending.files
      .filter((f) => !f.duplicateOf)
      .map((f) => ({ name: f.name, text: f.raw, size: f.size }));
    const res = this.store.createMigrationBatch(uniqueFiles, { autoImport: this.pending.autoImport });
    if (!res.ok) { this.hooks.toast(res.error, 'error'); return; }
    this.pending = null;
    if (res.reused?.length) {
      this.hooks.toast(`批次已开始：${res.reused.length} 份文件与历史迁移相同，已复用既有结果（不产生重复布局）`, 'warn');
    } else {
      this.hooks.toast(`迁移批次已开始，共 ${res.batch.files.length} 份文件`);
    }
    this.render();
  }

  /* ---------------- 渲染 ---------------- */

  render() {
    const s = this.store;
    this.$count.textContent = s.migrations.length;
    this.$count.classList.toggle('zero', s.migrations.length === 0);
    this.$btnReport.disabled = !s.migrations.length;
    this._renderWarnings();
    this._renderPending();
    this.$list.innerHTML = '';
    if (s.migrations.length) {
      for (const b of [...s.migrations].sort((a, b2) => b2.createdAt - a.createdAt || (a.id < b2.id ? -1 : 1))) {
        this.$list.appendChild(this._batchCard(b));
      }
    } else if (!this.pending) {
      this.$list.innerHTML = `<div class="empty-note">还没有迁移批次。<br>选择多份历史布局文件，查看格式识别与<br>引用映射预览后，按批次隔离迁移。</div>`;
    }
  }

  _renderWarnings() {
    const ws = this.store.migrationWarnings || [];
    if (!ws.length) { this.$warnings.innerHTML = ''; this.$warnings.classList.add('hidden'); return; }
    this.$warnings.classList.remove('hidden');
    this.$warnings.innerHTML = `<div class="aw-title">⚠ 迁移数据健康检查（${ws.length}）</div>` +
      ws.slice(-6).map((w) => `<div class="aw-item">${escapeHtml(w.text)}</div>`).join('');
  }

  _renderPending() {
    const host = this.$preview;
    if (!this.pending) { host.innerHTML = ''; return; }
    const drafts = this.pending.files;
    const importable = drafts.filter((d) => d.preview?.ok && !d.duplicateOf).length;
    host.innerHTML = `
      <div class="mp-head">
        <b>迁移预览（${drafts.length} 份）</b>
        <span class="spacer"></span>
        <label class="mig-auto"><input type="checkbox" id="mp-auto" ${this.pending.autoImport ? 'checked' : ''}/> 成功后自动导入</label>
        <button class="mini" id="mp-cancel">取消</button>
        <button class="primary" id="mp-start" ${importable ? '' : 'disabled'}>开始正式迁移（${importable} 份）</button>
      </div>
      <div class="mp-files">${drafts.map((d) => this._pendingFile(d)).join('')}</div>`;
    host.querySelector('#mp-start').onclick = () => this.startBatch();
    host.querySelector('#mp-cancel').onclick = () => this.clearPending();
    host.querySelector('#mp-auto').onchange = (e) => { this.pending.autoImport = e.target.checked; };
  }

  _pendingFile(d) {
    const p = d.preview;
    if (d.duplicateOf) {
      return `<div class="mp-file dup">
        <span class="mf-badge dup">重复源</span>
        <span class="mf-name">${escapeHtml(d.name)}</span>
        <span class="mf-note">与另一份选择文件内容完全相同，不会重复导入</span>
      </div>`;
    }
    if (!p.ok) {
      return `<div class="mp-file bad">
        <span class="mf-badge bad">无法识别</span>
        <span class="mf-name">${escapeHtml(d.name)}</span>
        <span class="mf-note">✗ ${escapeHtml(p.error?.message || '无法识别格式')}${fmtPos(p.error)}</span>
        <div class="mf-suggest">💡 ${escapeHtml(p.error?.suggestion || '')}</div>
      </div>`;
    }
    const qn = p.quarantined.length;
    const un = (p.unknownFields || []).length;
    return `<div class="mp-file ok">
      <div class="mpf-row">
        <span class="mf-badge ok">可迁移</span>
        <span class="mf-name">${escapeHtml(d.name)}</span>
        <span class="mf-fmt">${FORMAT_LABEL[p.format] || p.format} · 置信度 ${Math.round((p.confidence || 0) * 100)}%</span>
        <span class="mf-stats">矩形 ${p.counts.rects} · 约束 ${p.counts.constraints}</span>
        <span class="mf-hash"><code>${(p.hash || '').slice(0, 8)}</code></span>
      </div>
      <div class="mpf-flags">
        ${qn ? `<span class="flag flag-q">会隔离 ${qn} 项</span>` : '<span class="flag flag-ok">无隔离</span>'}
        ${un ? `<span class="flag flag-u">无法识别字段 ${un}</span>` : '<span class="flag flag-ok">无未知字段</span>'}
        ${this._renamedSummary(p.mapping)}
      </div>
      <details class="mpf-detail">
        <summary>查看引用映射 / 隔离项 / 未知字段明细</summary>
        ${this._mappingDetail(p.mapping)}
        ${this._quarantineDetail(p.quarantined)}
        ${this._unknownDetail(p.unknownFields || [])}
        ${this._warningsDetail(p.warnings || [])}
      </details>
    </div>`;
  }

  _renamedSummary(mapping) {
    const rn = (mapping?.rects || []).filter((m) => m.renamed).length;
    const cn = (mapping?.constraints || []).filter((m) => m.renamed).length;
    if (!rn && !cn) return '<span class="flag flag-ok">标识无冲突</span>';
    return `<span class="flag flag-rn">稳定重命名 矩形${rn ? '×' + rn : ''} 约束${cn ? '×' + cn : ''}</span>`;
  }

  _mappingDetail(mapping) {
    const rectRows = (mapping?.rects || []).map((m) => {
      const arrow = m.renamed
        ? `<span class="map-from">${escapeHtml(m.sourceId)}</span> → <b>${escapeHtml(m.newId)}</b> <span class="map-why">（${escapeHtml(m.reason || 'id 冲突/非法，稳定重命名')}）</span>`
        : `<b>${escapeHtml(m.newId)}</b>`;
      return `<li>${arrow}${m.adjusted ? ` <span class="map-adj">位置夹回 ${m.adjusted.from.x},${m.adjusted.from.y} → ${m.adjusted.to.x},${m.adjusted.to.y}</span>` : ''}</li>`;
    }).join('');
    const consRows = (mapping?.constraints || []).map((m) => {
      const arrow = m.renamed
        ? `<span class="map-from">${escapeHtml(m.sourceId)}</span> → <b>${escapeHtml(m.newId)}</b>`
        : `<b>${escapeHtml(m.newId)}</b>`;
      return `<li>${arrow}</li>`;
    }).join('');
    const branchRows = (mapping?.branches || []).map((b) =>
      `<li>${escapeHtml(b.sourceName || b.sourceId)} → 建议分支名 <b>${escapeHtml(b.newName)}</b>${b.current ? '（当前）' : ''} <span class="map-why">${escapeHtml(b.note || '')}</span></li>`).join('');
    const verRows = (mapping?.versions || []).map((v) =>
      `<li>${escapeHtml(v.sourceName || v.sourceId)} <code>${(v.hashRef || '').slice(0, 8)}</code> · ${v.status === 'current' ? '当前布局' : '历史版本引用'} <span class="map-why">${escapeHtml(v.note || '')}</span></li>`).join('');
    return `
      <div class="map-sec"><h5>矩形标识（重命名后约束引用随之重写）</h5>${rectRows ? `<ul>${rectRows}</ul>` : '<div class="map-empty">无</div>'}</div>
      <div class="map-sec"><h5>约束标识</h5>${consRows ? `<ul>${consRows}</ul>` : '<div class="map-empty">无</div>'}</div>
      <div class="map-sec"><h5>分支引用变化</h5>${branchRows ? `<ul>${branchRows}</ul>` : '<div class="map-empty">无</div>'}</div>
      <div class="map-sec"><h5>版本引用变化</h5>${verRows ? `<ul>${verRows}</ul>` : '<div class="map-empty">无</div>'}</div>`;
  }

  _quarantineDetail(quarantined) {
    if (!quarantined.length) return '<div class="map-sec"><h5>会被隔离的数据</h5><div class="map-empty">无</div></div>';
    const rows = quarantined.map((q) => `
      <li class="q-li q-${q.kind}">
        <span class="q-kind">${q.kind === 'rect' ? '矩形' : '约束'}</span>
        <b>${escapeHtml(q.name || q.sourceId)}</b>
        <div class="q-reason">✗ ${escapeHtml(q.reason)}</div>
        <div class="q-suggest">💡 ${escapeHtml(q.suggestion)}</div>
      </li>`).join('');
    return `<div class="map-sec"><h5>会被隔离的数据（不进入当前布局）</h5><ul class="q-list">${rows}</ul></div>`;
  }

  _unknownDetail(unknownFields) {
    if (!unknownFields.length) return '<div class="map-sec"><h5>无法识别的字段</h5><div class="map-empty">无</div></div>';
    const rows = unknownFields.map((u) =>
      `<li><code>${escapeHtml(u.path)}.${escapeHtml(u.field)}</code>${u.occurrences > 1 ? ` ×${u.occurrences}` : ''} · <span class="map-why">${escapeHtml(u.sample)}</span></li>`).join('');
    return `<div class="map-sec"><h5>无法识别的字段（忽略，不进入模型）</h5><ul>${rows}</ul></div>`;
  }

  _warningsDetail(warnings) {
    const ws = warnings.filter((w) => w.level === 'warn');
    if (!ws.length) return '';
    return `<div class="map-sec"><h5>位置调整提示</h5><ul>${ws.map((w) => `<li>${escapeHtml(w.text)}</li>`).join('')}</ul></div>`;
  }

  /* ---------------- 批次卡片 ---------------- */

  _batchCard(batch) {
    const s = this.store;
    const c = s.migrationCounters(batch);
    const pct = Math.round(c.progress * 100);
    const card = document.createElement('div');
    card.className = 'mig-card st-' + batch.runState;
    card.innerHTML = `
      <div class="mc-row1">
        <span class="mc-state">${BATCH_LABEL[batch.runState] || batch.runState}</span>
        <span class="mc-name" title="${escapeHtml(batch.name)}">${escapeHtml(batch.name)}</span>
        <span class="spacer"></span>
        <span class="mc-meta">${fmtTime(batch.createdAt)} · ${escapeHtml(batch.actor)}</span>
      </div>
      <div class="mc-progress">
        <div class="mc-bar" style="width:${pct}%"></div>
      </div>
      <div class="mc-counts">
        <span class="mc-total">${c.terminal}/${c.total}</span>
        <span class="mc-c ok">成功 ${c.done}</span>
        <span class="mc-c bad">失败 ${c.failed}</span>
        <span class="mc-c">取消 ${c.cancelled}</span>
        <span class="mc-c">排队 ${c.queued}</span>
        ${c.imported ? `<span class="mc-c imp">已导入 ${c.imported}</span>` : ''}
        ${batch.skippedDuplicates?.length ? `<span class="mc-c dup">重复源跳过 ${batch.skippedDuplicates.length}</span>` : ''}
      </div>
      <div class="mc-actions">
        <button class="mini" data-act="pause" ${batch.runState === 'running' ? '' : 'disabled'}>⏸ 暂停</button>
        <button class="mini" data-act="resume" ${(batch.runState === 'paused' || batch.runState === 'queued') && c.queued ? '' : 'disabled'}>▶ 继续</button>
        <button class="mini danger" data-act="cancel" ${['running', 'paused', 'queued'].includes(batch.runState) && c.queued ? '' : 'disabled'}>取消剩余</button>
        <span class="spacer"></span>
        <button class="mini" data-act="report">⬇ 导出报告</button>
      </div>
      <div class="mc-files"></div>`;
    const host = card.querySelector('.mc-files');
    batch.files.forEach((f) => host.appendChild(this._fileRow(batch, f)));
    card.querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = () => {
        const act = btn.dataset.act;
        let res;
        if (act === 'pause') res = s.pauseMigration(batch.id);
        else if (act === 'resume') res = s.resumeMigration(batch.id);
        else if (act === 'report') { this.exportReport(batch.id); return; }
        else if (act === 'cancel') {
          if (!confirm('取消该批次尚未完成的文件？\n成功 / 失败结果保留，排队文件进入已取消。')) return;
          res = s.cancelMigration(batch.id);
        }
        if (res && !res.ok) this.hooks.toast(res.error, 'warn');
      };
    });
    return card;
  }

  _fileRow(batch, f) {
    const key = batch.id + '/' + f.id;
    const row = document.createElement('div');
    row.className = 'mc-file st-' + f.status;
    const fmt = FORMAT_LABEL[f.detected] || f.detected || (f.preview ? FORMAT_LABEL[f.preview.format] : '—');
    const r = f.result;
    const qn = r ? r.quarantined.length : (f.preview?.quarantined?.length || 0);
    const canImport = f.status === 'done' && r;
    const bid = canImport ? `b_mig_${f.sourceHash}` : null;
    const already = bid && this.store.branches.some((b) => b.id === bid);
    row.innerHTML = `
      <div class="mcf-head">
        <span class="mcf-status">${FILE_LABEL[f.status] || f.status}</span>
        <span class="mcf-name">${escapeHtml(f.name)}</span>
        <span class="mcf-fmt">${escapeHtml(fmt)}</span>
        ${r ? `<code class="mcf-hash">${r.hash.slice(0, 8)}</code>` : ''}
        ${qn ? `<span class="flag flag-q">隔离 ${qn}</span>` : ''}
        ${f.reusedFrom ? '<span class="flag flag-rn">复用历史结果</span>' : ''}
      </div>
      ${f.status === 'failed' && f.error ? `
        <div class="mcf-err">
          ✗ ${escapeHtml(f.error.message || '迁移失败')}
          ${fmtPos(f.error)}
          <div class="q-suggest">💡 ${escapeHtml(f.error.suggestion || '')}</div>
        </div>` : ''}
      <div class="mcf-actions">
        <button class="mini" data-act="detail">${this.expanded.has(key) ? '收起明细' : '映射/隔离明细'}</button>
        <button class="mini primary" data-act="import" ${canImport ? '' : 'disabled'}>
          ${already || f.imported ? '⎘ 已导入（幂等，重新进入）' : '⎇ 导入为新分支'}
        </button>
        ${f.status === 'failed' ? '<button class="mini" data-act="retry">↻ 修正后重试</button>' : ''}
        ${f.status === 'failed' ? '<button class="mini" data-act="copyraw">复制原始输入</button>' : ''}
      </div>
      <div class="mcf-detail" ${this.expanded.has(key) ? '' : 'style="display:none"'}></div>
      ${f.imported ? `<div class="mcf-imported">
        <span class="imp-line">已导入分支 <b>${escapeHtml(f.imported.branchName)}</b>（${escapeHtml(f.imported.branchId)}）${f.imported.idempotent ? ' · 幂等未新建' : ''}</span>
        <button class="mini" data-act="diff">${this.diffOpen.has(key) ? '收起差异摘要' : '查看导入后差异摘要'}</button>
        <div class="mcf-diff" ${this.diffOpen.has(key) ? '' : 'style="display:none"'}></div>
      </div>` : ''}`;

    const $detail = row.querySelector('.mcf-detail');
    const fillDetail = () => {
      const source = r ? { mapping: r.mapping, quarantined: r.quarantined, warnings: r.warnings, unknownFields: [] }
        : (f.preview || {});
      if (!source) return;
      $detail.innerHTML = this._mappingDetail(source.mapping) +
        this._quarantineDetail(source.quarantined || []) +
        this._warningsDetail(source.warnings || []);
    };
    row.querySelector('[data-act=detail]').onclick = () => {
      if (this.expanded.has(key)) { this.expanded.delete(key); $detail.style.display = 'none'; }
      else { this.expanded.add(key); fillDetail(); $detail.style.display = ''; }
    };
    row.querySelector('[data-act=import]').onclick = () => {
      const res = this.store.importMigrationFile(batch.id, f.id, { switchTo: true });
      if (!res.ok) { this.hooks.toast(res.error, 'error'); return; }
      if (res.idempotent) this.hooks.toast('该源文件已导入过（幂等）：进入既有分支，未产生重复布局', 'warn');
      else this.hooks.toast(`已导入为新编辑分支「${res.branch.name}」`);
      this.render();
    };
    const retryBtn = row.querySelector('[data-act=retry]');
    if (retryBtn) retryBtn.onclick = () => {
      this.hooks.toast('请先在源文件中修正问题后重新提交为新批次；或确认原始输入无误后重试', '');
      const res = this.store.retryMigrationFile(batch.id, f.id);
      if (!res.ok) this.hooks.toast(res.error, 'warn');
      else this.render();
    };
    const copyBtn = row.querySelector('[data-act=copyraw]');
    if (copyBtn) copyBtn.onclick = () => {
      try {
        navigator.clipboard.writeText(f.raw || '');
        this.hooks.toast('已复制失败文件的原始输入（可修正后重新提交）');
      } catch { this.hooks.toast('复制失败，请从原始文件重新选择', 'warn'); }
    };
    const $diff = row.querySelector('.mcf-diff');
    const diffBtn = row.querySelector('[data-act=diff]');
    if (diffBtn) diffBtn.onclick = () => {
      if (this.diffOpen.has(key)) { this.diffOpen.delete(key); $diff.style.display = 'none'; }
      else {
        this.diffOpen.add(key);
        $diff.innerHTML = diffHtml(f.imported.diff);
        $diff.style.display = '';
      }
    };
    return row;
  }

  /* ---------------- 报告导出 ---------------- */

  exportReport(batchId = null) {
    const s = this.store;
    let batch = batchId ? s.migrationById(batchId) : (s.migrations[0] || null);
    if (!batch) { this.hooks.toast('没有可导出的迁移批次', 'warn'); return; }
    const report = s.migrationReport(batch.id);
    downloadJson(`migration-report-${batch.id}.json`, report);
    this.hooks.toast(`已导出迁移报告（${report.files.length} 份文件，校验和 ${report.checksum}）`);
  }
}

/* ---------------- 工具 ---------------- */

/** 格式化解析错误位置：第 L 行第 C 列（偏移 O）；三者皆缺时返回空串。 */
function fmtPos(err) {
  if (!err) return '';
  const hasLC = Number.isFinite(err.line) && Number.isFinite(err.column);
  const hasOff = Number.isFinite(err.offset);
  if (!hasLC && !hasOff) return '';
  let s = '（';
  if (hasLC) s += `第 ${err.line} 行第 ${err.column} 列`;
  if (hasOff) s += `${hasLC ? '，' : ''}字符偏移 ${err.offset}`;
  return s + '）';
}

function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fmtTime(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return '时间未知';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
