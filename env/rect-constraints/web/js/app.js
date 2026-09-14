import { Store } from './geom/store.js';
import { View } from './geom/view.js';
import { ConstraintDialog } from './geom/dialog.js';
import { VersionPanel } from './geom/versionpanel.js';
import { AuditPanel } from './geom/auditpanel.js';
import { ExperimentPanel } from './geom/experimentpanel.js';
import { WorkbenchPanel } from './geom/workbenchpanel.js';
import { ReleasePanel } from './geom/releasepanel.js';
import { NotifyPanel } from './geom/notifypanel.js';
import {
  newRect, newSnap, newMinGap, newContain, newLock,
} from './geom/model.js';
import { solve, constraintLabel } from './geom/solver.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const store = new Store();

// 调尺寸手势的活动状态：锁定矩形直接拒绝手势；非锁定矩形手势中实时重解预览，
// pointerup 时把最后一帧几何提交成一次历史。
let pendingResize = null;
let resizeWarned = false;

const view = new View($('#canvas'), store, {
  onSelect: () => renderPanels(),
  onDrag: (pinned, group) => store.previewDrag(pinned, group),
  onDragEnd: () => store.endDrag(),
  onDblClick: (id) => renameRect(id),
  onResize: (id, geo, { live, locked }) => {
    if (locked) {
      if (live && !resizeWarned) {
        toast('该矩形已锁定尺寸，不能缩放（操作被拒绝，不会静默改尺寸）', 'warn');
        resizeWarned = true;
        setTimeout(() => (resizeWarned = false), 900);
      }
      return;
    }
    if (live && geo) {
      pendingResize = geo;
      const draft = structuredClone(store.current.model);
      const r = draft.rects.find((x) => x.id === id);
      Object.assign(r, geo);
      store.dragPreview = solve(draft, null);
      view.render();
      updateChips();
    } else if (!live && pendingResize) {
      const finalGeo = pendingResize;
      pendingResize = null;
      store.commit((m) => {
        const r = m.rects.find((x) => x.id === id);
        if (r) Object.assign(r, finalGeo);
      }, { label: '调整尺寸' });
    }
  },
});

const dialog = new ConstraintDialog($('#dlg'), store);
dialog.factoryFns = { newSnap, newMinGap, newContain, newLock };
dialog.hooks = { onCycle: (cyc) => view.setCycleHighlight(cyc) };

const versionPanel = new VersionPanel(store, { toast });
const auditPanel = new AuditPanel(store, { toast });
const experimentPanel = new ExperimentPanel(store, { toast });
const workbenchPanel = new WorkbenchPanel(store, { toast });
const releasePanel = new ReleasePanel(store, { toast });
const notifyPanel = new NotifyPanel(store, { toast });

// 浏览器网络恢复：按 FIFO 原顺序重发通知队列（稳定 id，不重复）
window.addEventListener('online', () => store.notifyOnline());

let activeTab = 'constraints';

/* ---------- 顶栏 ---------- */

$('#btn-add-rect').onclick = () => {
  store.commit((m) => {
    const n = m.rects.length + 1;
    const r = newRect(60 + ((n * 37) % 500), 60 + ((n * 53) % 380), 140, 90, `矩形${n}`);
    m.rects.push(r);
  }, { label: '添加矩形' });
  view.setCycleHighlight(null);
};
$('#btn-undo').onclick = () => store.undo();
$('#btn-redo').onclick = () => store.redo();
$('#btn-snap').onclick = () => {
  view.setCycleHighlight(null);
  dialog.open([...view.selected]);
};
$('#btn-delete').onclick = () => {
  const ids = view.selected;
  if (!ids.size) return;
  store.commit((m) => {
    m.rects = m.rects.filter((r) => !ids.has(r.id));
    m.constraints = m.constraints.filter((c) => !ids.has(c.rect) && !ids.has(c.other));
  }, { label: '删除所选' });
  view.clearSelection();
};

/* ---------- tabs ---------- */

$$('.tab').forEach((b) => b.onclick = () => {
  activeTab = b.dataset.tab;
  $$('.tab').forEach((x) => x.classList.toggle('active', x === b));
  $$('.tab-body').forEach((x) => x.classList.toggle('hidden', x.dataset.body !== activeTab));
  renderPanels();
});

/* ---------- 快捷键 ---------- */

window.addEventListener('keydown', (e) => {
  const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || '');
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); store.undo(); }
  else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); store.redo(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && view.selected.size) { e.preventDefault(); $('#btn-delete').click(); }
  else if (e.key.toLowerCase() === 'a' && !typing && (e.ctrlKey || e.metaKey)) {
    e.preventDefault(); view.select(store.model.rects.map((r) => r.id));
  } else if (e.key === 'Escape') {
    dialog.close(); experimentPanel.closeEditor(); view.clearSelection(); view.setCycleHighlight(null);
  }
});

/* ---------- 面板渲染 ---------- */

store.addEventListener('change', (e) => {
  renderPanels(); updateChips(); updateButtons(); updateReplayBanner();
  if (e.detail?.conflicts?.length) {
    // 新冲突出现时轻提示，但不抢焦点
    if (activeTab !== 'conflicts') toast(`${e.detail.conflicts.length} 条约束未满足 —— 见「冲突」页`, 'warn');
  }
});
store.addEventListener('reject', (e) => {
  const { errors, cycle, label } = e.detail;
  if (cycle) {
    view.setCycleHighlight(cycle);
    toast('循环依赖，提交被阻止（环上矩形已标红）', 'error');
  } else {
    toast('校验失败：' + errors[0], 'error');
  }
});

/* ---------- 审计 / 分支 / 回放 / 保存状态事件 ---------- */

store.addEventListener('branch', (e) => {
  renderPanels(); updateChips(); updateReplayBanner();
  view.clearSelection();
  view.setCycleHighlight(null);
  if (e.detail?.type === 'fork') toast('已切换到新分支', '');
  else if (e.detail?.type === 'switch') toast(`已切换到分支「${store.branch.name}」`);
});
store.addEventListener('replay', () => {
  renderPanels(); updateButtons(); updateReplayBanner();
  view.clearSelection();
});
store.addEventListener('replayexit', () => {
  renderPanels(); updateButtons(); updateReplayBanner();
});
store.addEventListener('replayblocked', () => {
  toast('回放模式为只读：请「回到当前 head」退出，或把这一刻「另存为新分支」后再编辑', 'warn');
});
store.addEventListener('versions', (e) => {
  versionPanel.render();
  updateVersionChip();
  if (e.detail?.type === 'restore') view.clearSelection(); // 旧选择可能指向已不存在的矩形
});
store.addEventListener('persist', () => { $('#save-chip').textContent = '保存中…'; });
store.addEventListener('saved', (e) => {
  $('#save-chip').textContent = e.detail?.merged ? '已保存（分支已合流）' : '已保存';
});
store.addEventListener('saveerror', () => { $('#save-chip').textContent = '保存失败（已存本地）'; });
store.addEventListener('saveconflict', (e) => {
  // 同一分支已在另一页面前进：携带过期事件序号的提交被明确拒绝，绝不覆盖
  $('#save-chip').textContent = '版本冲突';
  const d = e.detail || {};
  if (d.reason === 'branch-advanced') {
    $('#conflict-text').innerHTML =
      `⚠ <b>分支已前进</b>：分支「${d.branchName || '当前分支'}」已在另一个页面提交到更新的事件${
        d.headSeq ? `（当前 #${d.headSeq}）` : ''}。本页修改基于更早的事件，<b>已被拒绝且未覆盖</b>对方内容——请重新加载后再继续。`;
    toast('分支已前进：另一个页面已提交新事件，当前页面的修改未保存。请重新加载。', 'error');
  } else {
    $('#conflict-text').innerHTML =
      '⚠ <b>版本冲突</b>：文档已被另一个页面更新。为避免覆盖对方数据，当前页面的修改<b>未保存</b>——请重新加载后再继续编辑。';
    toast('版本冲突：当前页面的修改未保存，请重新加载。', 'error');
  }
  $('#conflict-banner').classList.remove('hidden');
});
$('#btn-reload').onclick = () => location.reload();
$('#btn-replay-exit').onclick = () => store.exitReplay();
$('#btn-replay-fork').onclick = () => {
  const info = store.replayInfo;
  // 快照回放（求解前 / 实验基准）不是审计节点，不能直接另存为分支：回到事件后再操作
  if (!info || info.mode !== 'event') {
    toast('该快照不是审计事件：请在「审计台」对求解后事件或变体结果使用“另存编辑分支”', 'warn');
    return;
  }
  const ev = store.eventsById.get(store.replayEventId);
  const name = prompt('把这一刻另存为新分支，名称：', `回放 #${ev?.seq ?? ''} 分支`);
  if (name === null) return;
  const res = store.forkFromEvent(store.replayEventId, name);
  if (!res.ok) { toast(res.error, 'error'); return; }
  toast(`已另存为新分支「${name}」，可继续编辑；原事件与原分支未被改写`);
};
// 加载/静默重载（其他页面保存了更新内容，本页无未保存修改时自动跟随）后整体刷新
store.addEventListener('load', () => {
  renderPanels();
  $('#save-chip').textContent = '已保存';
  $('#conflict-banner').classList.add('hidden');
  updateChips(); updateButtons(); updateReplayBanner();
});

function renderPanels() {
  renderConstraintList();
  renderProps();
  renderConflicts();
  versionPanel.render();
  auditPanel.render();
  experimentPanel.render();
  workbenchPanel.render();
  updateButtons();
  updateChips();
}

function renderConstraintList() {
  const host = $('#constraint-list');
  const { model, report } = store;
  if (!model.constraints.length) {
    host.innerHTML = `<div class="empty" style="color:var(--muted);font-size:13px;margin-top:30px;text-align:center">
      还没有约束。<br>选中一个或两个矩形，点顶部「🔗 添加约束」。</div>`;
    return;
  }
  // 按优先级分组展示（强在前），同优先级按 id —— 与求解器打破并列的顺序一致
  const rows = model.constraints.map((c) => ({ c, st: report.constraints[c.id] }))
    .sort((a, b) => (b.c.priority - a.c.priority) || (a.c.id < b.c.id ? -1 : 1));

  host.innerHTML = '';
  for (const { c, st } of rows) {
    const div = document.createElement('div');
    div.className = 'citem' + (st?.satisfied ? '' : ' bad');
    div.dataset.cid = c.id;
    const involvedRects = [c.rect, c.other].filter(Boolean);
    div.onmouseenter = () => view.setConstraintHighlight([c.id]);
    div.onmouseleave = () => view.setConstraintHighlight([]);
    div.onclick = () => view.select(involvedRects);

    const conflict = report.conflicts.find((x) => x.cid === c.id);
    div.innerHTML = `
      <div class="row1">
        <span class="status-dot ${st?.disabled ? 'dot-off' : st?.satisfied ? 'dot-ok' : 'dot-bad'}"></span>
        <span class="kind kind-${c.kind}">${kindName(c.kind)}</span>
        <span class="desc">${escapeHtml(constraintLabel(c, new Map(model.rects.map((r) => [r.id, r]))))}</span>
      </div>
      <div class="meta">
        优先级
        <input class="prio" type="number" min="1" max="999" value="${c.priority}" data-act="prio" />
        <label style="display:flex;align-items:center;gap:3px;cursor:pointer">
          <input type="checkbox" data-act="en" ${c.enabled !== false ? 'checked' : ''}/> 启用
        </label>
        <span class="spacer"></span>
        <span class="actions">
          <button class="mini" data-act="dup" title="复制约束">复制</button>
          <button class="mini danger" data-act="del">删除</button>
        </span>
      </div>
      ${conflict ? `
        <div class="chain">
          <div class="chain-title">⛓ 冲突链（未满足，未丢弃）</div>
          <ol>${conflict.chain.map((x) => `<li>${escapeHtml(x)}</li>`).join('') || '<li>无可让步空间（画布硬边界/拖动）</li>'}</ol>
          <div class="verdict">
            采用：<b>${escapeHtml(conflict.chain[0] || '画布/拖动约束')}</b>；
            <span class="unmet">未满足：本约束（偏差 ${Math.abs(conflict.measure).toFixed(1)}）</span>
          </div>
        </div>` : ''}
    `;
    div.querySelector('[data-act=prio]').onchange = (e) => {
      const p = Math.min(999, Math.max(1, Math.round(Number(e.target.value) || c.priority)));
      commitConstraintEdit(c.id, (cc) => (cc.priority = p));
    };
    div.querySelector('[data-act=en]').onchange = (e) =>
      commitConstraintEdit(c.id, (cc) => (cc.enabled = e.target.checked));
    div.querySelector('[data-act=del]').onclick = (e) => { e.stopPropagation(); commitConstraintEdit(c.id, null); };
    div.querySelector('[data-act=dup]').onclick = (e) => {
      e.stopPropagation();
      store.commit((m) => {
        const src = m.constraints.find((x) => x.id === c.id);
        const copy = { ...src, id: 'c_' + Math.random().toString(36).slice(2, 10) };
        m.constraints.push(copy);
      }, { label: '复制约束' });
    };
    host.appendChild(div);
  }
}

function renderProps() {
  const host = $('#props-panel');
  const ids = [...view.selected];
  if (!ids.length) {
    host.innerHTML = `<div style="color:var(--muted);font-size:13px;margin-top:30px;text-align:center">在画布上选择一个或多个矩形。</div>`;
    return;
  }
  const { model, report } = store;
  host.innerHTML = '';
  for (const id of ids) {
    const r = model.rects.find((x) => x.id === id);
    if (!r) continue;
    const p = report.rects[id] || r;
    const sec = document.createElement('div');
    sec.innerHTML = `
      <h4 style="margin-top:4px">矩形</h4>
      <div class="field"><label>名称</label><input type="text" data-f="name" value="${escapeHtml(r.name)}"/></div>
      <div class="grp2">
        <div class="field"><label>X</label><input type="number" data-f="x" value="${Math.round(p.x)}"/></div>
        <div class="field"><label>Y</label><input type="number" data-f="y" value="${Math.round(p.y)}"/></div>
        <div class="field"><label>宽</label><input type="number" data-f="w" value="${Math.round(p.w)}" ${
          model.constraints.some((c) => c.kind === 'lock' && c.rect === id && c.enabled !== false) ? 'disabled' : ''}/></div>
        <div class="field"><label>高</label><input type="number" data-f="h" value="${Math.round(p.h)}" ${
          model.constraints.some((c) => c.kind === 'lock' && c.rect === id && c.enabled !== false) ? 'disabled' : ''}/></div>
      </div>
      <h4>本矩形参与的约束</h4>
      ${model.constraints.filter((c) => c.rect === id || c.other === id).map((c) => {
        const s = report.constraints[c.id];
        return `<div class="incoming"><span class="status-dot ${s?.satisfied ? 'dot-ok' : s?.disabled ? 'dot-off' : 'dot-bad'}"></span>
          ${c.rect === id ? '跟随' : '锚点'} · ${escapeHtml(constraintLabel(c, new Map(model.rects.map((rr) => [rr.id, rr]))))}</div>`;
      }).join('') || '<div class="incoming">无</div>'}
      <hr style="border:none;border-top:1px solid var(--line);margin:14px 0"/>
    `;
    sec.querySelectorAll('input[data-f]').forEach((inp) => {
      inp.onchange = () => {
        const f = inp.dataset.f;
        store.commit((m) => {
          const rr = m.rects.find((x) => x.id === id);
          if (f === 'name') rr.name = inp.value;
          else {
            const v = Math.max(1, Math.round(Number(inp.value) || 0));
            if (f === 'w' || f === 'h') {
              if (model.constraints.some((c) => c.kind === 'lock' && c.rect === id && c.enabled !== false)) return;
              rr[f] = v;
            } else rr[f] = v;
          }
        }, { label: '修改属性' });
      };
    });
    host.appendChild(sec);
  }
}

function renderConflicts() {
  const host = $('#conflict-panel');
  const { model, report } = store;
  const n = report.conflicts.length;
  const badge = $('#conflict-count');
  badge.textContent = n;
  badge.classList.toggle('zero', n === 0);

  if (!n) {
    host.innerHTML = `<div class="empty">✓ 当前所有启用的约束都已满足。<br><br>
      <span style="font-size:12px">提示：把两个矛盾约束调成相同或更高优先级并拖动矩形，即可在这里看到冲突链与采用/未满足裁决。</span></div>`;
    return;
  }
  host.innerHTML = '';
  for (const cf of report.conflicts) {
    const c = model.constraints.find((x) => x.id === cf.cid);
    const div = document.createElement('div');
    div.className = 'conflict-card';
    div.innerHTML = `
      <div class="h">未满足：${escapeHtml(cf.label)}</div>
      <div class="measure">偏差量：${Math.abs(cf.measure).toFixed(2)} 逻辑单位 · 优先级 ${cf.priority}</div>
      <div style="margin-top:8px;font-size:13px"><b>冲突链（自下而上让步）：</b></div>
      <ol style="margin:6px 0 0;padding-left:20px;font-size:13px">
        ${cf.chain.map((x) => `<li>${escapeHtml(x)}</li>`).join('') || '<li>画布硬边界或拖动定位，无进一步让步对象</li>'}
      </ol>
      <div style="margin-top:8px;font-size:13px">
        <span style="color:var(--ok)">✓ 采用：${escapeHtml(cf.chain[0] || '画布/拖动')}</span><br>
        <span style="color:var(--danger)">✗ 未满足：${escapeHtml(cf.label)}</span>
      </div>
      <div style="margin-top:8px;display:flex;gap:6px">
        <button class="mini" data-act="raise">提高本约束优先级</button>
        <button class="mini" data-act="locate">在画布上定位</button>
      </div>`;
    div.querySelector('[data-act=raise]').onclick = () =>
      commitConstraintEdit(cf.cid, (cc) => (cc.priority = Math.min(999, cc.priority + 10)));
    div.querySelector('[data-act=locate]').onclick = () => {
      view.select([c.rect]);
      view.setConstraintHighlight([cf.cid]);
      setTimeout(() => view.setConstraintHighlight([]), 2500);
    };
    host.appendChild(div);
  }
}

/* ---------- 小工具 ---------- */

function commitConstraintEdit(cid, mutator) {
  store.commit((m) => {
    const i = m.constraints.findIndex((c) => c.id === cid);
    if (i < 0) return;
    if (mutator === null) m.constraints.splice(i, 1);
    else mutator(m.constraints[i]);
  }, { label: '编辑约束' });
  view.setCycleHighlight(null);
}

function renameRect(id) {
  const r = store.model.rects.find((x) => x.id === id);
  const name = prompt('矩形名称：', r.name || '');
  if (name === null) return;
  store.commit((m) => { m.rects.find((x) => x.id === id).name = name; }, { label: '重命名' });
}

function kindName(k) {
  return { snap: '贴齐', minGap: '最小间距', contain: '画布包含', lock: '锁定尺寸' }[k] || k;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function updateButtons() {
  $('#btn-undo').disabled = !store.canUndo;
  $('#btn-redo').disabled = !store.canRedo;
  $('#btn-delete').disabled = view.selected.size === 0 || store.replaying;
  $('#btn-add-rect').disabled = store.replaying;
  $('#btn-snap').disabled = store.replaying;
}
function updateChips() {
  const rep = store.report;
  $('#hash-chip').textContent = 'hash ' + rep.hash.slice(0, 8);
  $('#hash-chip').title = `完整指纹 ${rep.hash}\n位置 + 每个约束的成败 + 冲突链`;
  updateVersionChip();
  updateBranchChip();
}

function updateBranchChip() {
  const chip = $('#branch-chip');
  const b = store.branch;
  if (!b) return;
  const head = store.eventsById.get(b.headEventId);
  const src = b.source ? store.branches.find((x) => x.id === b.source.branchId) : null;
  const expSrc = b.experimentSource ? store.experiments.find((x) => x.id === b.experimentSource.experimentId) : null;
  chip.textContent = `⎘ ${b.name} #${head?.seq ?? '?'}`;
  if (expSrc) {
    chip.title = `分支「${b.name}」来自实验「${expSrc.name}」的变体另存；实验结果与基准事件未被改写`;
  } else if (src) {
    chip.title = `分支「${b.name}」，来自「${src.name}」的历史事件；本分支提交不影响原分支`;
  } else {
    chip.title = `当前编辑分支「${b.name}」，审计事件 #${head?.seq ?? '?'}`;
  }
}

function updateReplayBanner() {
  const banner = $('#replay-banner');
  const info = store.replayInfo;
  if (!info) {
    banner.classList.add('hidden');
    $('#canvas-wrap').classList.remove('readonly');
    return;
  }
  const when = info.t ? new Date(info.t).toLocaleString() : '快照';
  const modeText = info.mode === 'variant-result' ? '实验变体结果'
    : info.mode === 'variant-baseline' ? '实验基准（求解前）'
    : info.mode === 'event-before' ? '求解前快照'
    : info.mode === 'snapshot' ? '历史快照' : '历史事件';
  $('#replay-text').innerHTML =
    `▶ 正在回放${modeText} <b>「${escapeHtml(info.label)}」</b>${info.actor ? ' · ' + escapeHtml(info.actor) : ''} · ${
      when} · 指纹 <code>${(info.hash || '').slice(0, 8)}</code> · 只读（审计数据不可修改）`;
  banner.classList.remove('hidden');
  $('#canvas-wrap').classList.add('readonly');
}

function updateVersionChip() {
  const chip = $('#version-chip');
  const v = store.currentVersion;
  if (!v) {
    chip.textContent = '未保存版本';
    chip.title = '当前编辑内容还没有保存为任何版本（在「版本」页保存）';
    return;
  }
  const dirty = store.current?.hash !== v.hash;
  chip.textContent = `版本:${v.name}${dirty ? '*' : ''}`;
  chip.title = dirty
    ? `基于版本「${v.name}」，已有修改（* 表示当前内容与该版本不同）`
    : `当前内容与版本「${v.name}」一致`;
}

function toast(text, level = '') {
  let host = document.querySelector('#toast-host');
  if (!host) { host = document.createElement('div'); host.id = 'toast-host'; document.body.appendChild(host); }
  const t = document.createElement('div');
  t.className = 'toast ' + level;
  t.textContent = text;
  host.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .4s'; }, 3600);
  setTimeout(() => t.remove(), 4100);
}

/* ---------- 启动 ---------- */

await store.load();
// 恢复工作台持久化的回放位置：位置保留、播放一律暂停；失效位置静默留在 head
if (store.auditWorkbench.cursorKey && !store.replaying) {
  const w = store.workbench();
  const n = w.byKey.get(store.auditWorkbench.cursorKey);
  if (n?.replayable) store.showWorkbenchNode(n, store.auditWorkbench.side || 'after');
}
updateButtons();
renderPanels();
view.render();
