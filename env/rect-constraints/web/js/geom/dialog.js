/*
 * 添加约束对话框：构造 4 类约束草稿。
 * 提交时由 store.commit 统一做结构校验 + 环检测；
 * 若成环，对话框内红色展示环链并保持打开（不提交、不丢弃用户输入）。
 */

const KINDS = [
  { kind: 'snap', name: '贴齐', desc: '两边/中点对齐，可选偏移' },
  { kind: 'minGap', name: '最小间距', desc: '单向保持 ≥ N 的间隔' },
  { kind: 'contain', name: '包含在画布内', desc: '矩形不越出画布边界' },
  { kind: 'lock', name: '锁定尺寸', desc: '宽高固定，不可缩放' },
];

const EDGES_X = [['l', '左'], ['r', '右'], ['mid', '中']];
const EDGES_Y = [['t', '顶'], ['b', '底'], ['mid', '中']];
const SIDES = [['right', '在…右侧'], ['left', '在…左侧'], ['below', '在…下方'], ['above', '在…上方']];

export class ConstraintDialog {
  constructor(root, store) {
    this.root = root;
    this.store = store;
    this.kind = 'snap';
    this.draft = null;
    root.querySelector('#dlg-close').onclick = () => this.close();
    root.querySelector('#dlg-cancel').onclick = () => this.close();
    root.querySelector('#dlg-ok').onclick = () => this._submit();
  }

  open(preselectedIds) {
    const rects = this.store.model.rects;
    if (rects.length === 0) { alert('请先添加矩形'); return; }
    const sel = preselectedIds?.length ? preselectedIds : [rects[0].id];
    this.draft = {
      kind: 'snap',
      rect: sel[0],
      other: sel[1] || rects.find((r) => r.id !== sel[0])?.id,
      axis: 'x', edge: 'l', otherEdge: 'r', gap: 0,
      side: 'right', margin: 0, priority: 50,
    };
    this.root.classList.remove('hidden');
    this._setError('');
    this._render();
  }
  close() { this.root.classList.add('hidden'); }

  _setError(html) { this.root.querySelector('#dlg-error').innerHTML = html; }

  _render() {
    const d = this.draft;
    const rects = this.store.model.rects;
    const opts = (id) => rects.map((r) =>
      `<option value="${r.id}" ${r.id === id ? 'selected' : ''}>${escapeHtml(r.name || r.id.slice(-5))} · ${r.id.slice(-4)}</option>`).join('');

    const body = this.root.querySelector('#dlg-body');
    body.innerHTML = `
      <div class="kind-grid">
        ${KINDS.map((k) => `
          <button data-kind="${k.kind}" class="${d.kind === k.kind ? 'active' : ''}">
            <span class="kj">${k.name}</span><span class="kd">${k.desc}</span>
          </button>`).join('')}
      </div>
      <div id="dlg-fields"></div>
      <div class="field-row"><label>优先级</label>
        <input type="number" id="f-priority" value="${d.priority}" min="1" max="999" />
        <span style="font-size:11px;color:var(--muted)">数字越大越强；拖动为 ∞</span>
      </div>`;

    body.querySelectorAll('[data-kind]').forEach((b) =>
      b.onclick = () => {
        d.kind = b.dataset.kind;
        if (d.kind === 'contain') d.priority = 30;
        if (d.kind === 'minGap') d.priority = 40;
        if (d.kind === 'lock') d.priority = 60;
        this._setError('');
        this._renderFields();
        b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      });

    this._renderFields();
    this.root.querySelector('#f-priority').oninput = (e) => { d.priority = clampInt(e.target.value, 1, 999, d.priority); };
  }

  _renderFields() {
    const d = this.draft;
    const rects = this.store.model.rects;
    const opts = (id) => rects.map((r) =>
      `<option value="${r.id}" ${r.id === id ? 'selected' : ''}>${escapeHtml(r.name || r.id.slice(-5))}</option>`).join('');
    const box = this.root.querySelector('#dlg-fields');

    if (d.kind === 'snap') {
      const edges = d.axis === 'x' ? EDGES_X : EDGES_Y;
      const eOpts = (sel) => edges.map(([v, t]) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${t}</option>`).join('');
      box.innerHTML = `
        <div class="note">有向约束：<b>跟随矩形</b>会移动去贴齐 <b>锚点矩形</b>（拖动锚点时跟随者一起重解）。方向成环将被拒绝。</div>
        <div class="field-row"><label>跟随矩形</label><select id="f-rect">${opts(d.rect)}</select></div>
        <div class="field-row"><label>它的</label>
          <select id="f-axis" style="width:80px">
            <option value="x" ${d.axis === 'x' ? 'selected' : ''}>水平(x)</option>
            <option value="y" ${d.axis === 'y' ? 'selected' : ''}>垂直(y)</option>
          </select>
          <select id="f-edge">${eOpts(d.edge)}</select>
        </div>
        <div class="field-row"><label>贴齐矩形</label><select id="f-other">${opts(d.other)}</select></div>
        <div class="field-row"><label>对方的</label><select id="f-oedge">${eOpts(d.otherEdge)}</select></div>
        <div class="field-row"><label>偏移量</label><input type="number" id="f-gap" value="${d.gap}" step="1" /></div>`;
      const bind = () => {
        const edges2 = d.axis === 'x' ? EDGES_X : EDGES_Y;
        const okEdge = (e) => edges2.some(([v]) => v === e) ? e : edges2[0][0];
        d.edge = okEdge(d.edge); d.otherEdge = okEdge(d.otherEdge);
        this._renderFields();
      };
      box.querySelector('#f-rect').onchange = (e) => d.rect = e.target.value;
      box.querySelector('#f-other').onchange = (e) => d.other = e.target.value;
      box.querySelector('#f-axis').onchange = (e) => {
        d.axis = e.target.value;
        d.edge = d.otherEdge = d.axis === 'x' ? 'l' : 't';
        bind();
      };
      box.querySelector('#f-edge').onchange = (e) => d.edge = e.target.value;
      box.querySelector('#f-oedge').onchange = (e) => d.otherEdge = e.target.value;
      box.querySelector('#f-gap').oninput = (e) => d.gap = Number(e.target.value) || 0;
    } else if (d.kind === 'minGap') {
      box.innerHTML = `
        <div class="note">单向障碍：只在间距不足时把跟随矩形推开，满足后不会把它拉回来。</div>
        <div class="field-row"><label>跟随矩形</label><select id="f-rect">${opts(d.rect)}</select></div>
        <div class="field-row"><label>相对位置</label><select id="f-side">
          ${SIDES.map(([v, t]) => `<option value="${v}" ${v === d.side ? 'selected' : ''}>${t}</option>`).join('')}
        </select></div>
        <div class="field-row"><label>锚点矩形</label><select id="f-other">${opts(d.other)}</select></div>
        <div class="field-row"><label>最小间距</label><input type="number" id="f-gap" value="${d.gap}" min="0" /></div>`;
      box.querySelector('#f-rect').onchange = (e) => d.rect = e.target.value;
      box.querySelector('#f-other').onchange = (e) => d.other = e.target.value;
      box.querySelector('#f-side').onchange = (e) => d.side = e.target.value;
      box.querySelector('#f-gap').oninput = (e) => d.gap = Math.max(0, Number(e.target.value) || 0);
    } else if (d.kind === 'contain') {
      box.innerHTML = `
        <div class="note">矩形（含边距）始终被夹在画布内。矩形比画布还大时无法满足，会进入冲突面板而不是被静默丢弃。</div>
        <div class="field-row"><label>矩形</label><select id="f-rect">${opts(d.rect)}</select></div>
        <div class="field-row"><label>画布边距</label><input type="number" id="f-margin" value="${d.margin}" min="0" /></div>`;
      box.querySelector('#f-rect').onchange = (e) => d.rect = e.target.value;
      box.querySelector('#f-margin').oninput = (e) => d.margin = Math.max(0, Number(e.target.value) || 0);
    } else {
      const r = rects.find((x) => x.id === d.rect) || rects[0];
      box.innerHTML = `
        <div class="note">记录当前宽高为锁定值。锁定后矩形不能在画布上缩放；求解器任何时候都会把它恢复到该尺寸。</div>
        <div class="field-row"><label>矩形</label><select id="f-rect">${opts(d.rect)}</select></div>
        <div class="field-row"><label>锁定宽 × 高</label>
          <input type="number" id="f-w" value="${Math.round(r.w)}" min="1" />
          <span>×</span>
          <input type="number" id="f-h" value="${Math.round(r.h)}" min="1" />
        </div>`;
      box.querySelector('#f-rect').onchange = (e) => {
        d.rect = e.target.value;
        const rr = rects.find((x) => x.id === d.rect);
        box.querySelector('#f-w').value = Math.round(rr.w);
        box.querySelector('#f-h').value = Math.round(rr.h);
      };
      box.querySelector('#f-w').oninput = (e) => d.lockW = clampInt(e.target.value, 1, 100000, r.w);
      box.querySelector('#f-h').oninput = (e) => d.lockH = clampInt(e.target.value, 1, 100000, r.h);
      d.lockW = r.w; d.lockH = r.h;
    }
  }

  _submit() {
    const d = this.draft;
    d.priority = clampInt(this.root.querySelector('#f-priority').value, 1, 999, d.priority);

    const result = this.store.commit((m) => {
      const { newSnap, newMinGap, newContain, newLock } = this._factories();
      let c;
      if (d.kind === 'snap') {
        if (d.rect === d.other && d.edge === d.otherEdge) throw new FieldError('同一个矩形的同一条边贴齐自身无意义');
        c = newSnap(d.rect, d.other, d.axis, d.edge, d.otherEdge, d.gap, d.priority);
      } else if (d.kind === 'minGap') {
        if (d.rect === d.other) throw new FieldError('最小间距需要两个不同的矩形');
        c = newMinGap(d.rect, d.other, d.side, d.gap, d.priority);
      } else if (d.kind === 'contain') {
        c = newContain(d.rect, d.margin, d.priority);
      } else {
        const r = m.rects.find((x) => x.id === d.rect);
        c = newLock(d.rect, d.lockW || r.w, d.lockH || r.h, d.priority);
      }
      m.constraints.push(c);
    }, { label: `添加${KINDS.find((k) => k.kind === d.kind).name}约束` });

    if (result.ok) { this.close(); return; }
    if (result.errors.length) {
      this._setError(`<b>校验未通过，提交已阻止：</b><br>${result.errors.map(escapeHtml).join('<br>')}`);
      return;
    }
    if (result.cycle) {
      const names = result.cycle.nodeIds.map((id) => {
        const r = this.store.model.rects.find((x) => x.id === id);
        return escapeHtml(r?.name || id.slice(-5));
      });
      const cnames = result.cycle.cids.map((cid) => {
        const c = this.store.model.constraints.find((x) => x.id === cid);
        return cid.slice(-4) + (c ? `(${c.kind})` : '');
      });
      this._setError(`
        <div class="cyclebox">
          <div>⛔ <b>检测到循环依赖，已阻止提交。</b></div>
          <div style="margin-top:6px">环上的矩形：<span class="seq">${names.join(' → ')}</span></div>
          <div style="margin-top:4px">闭环约束：${cnames.map(escapeHtml).join('、')}</div>
          <div style="margin-top:4px;font-size:12px">请改跟随/锚点方向，或删除环上的一条约束后重试。</div>
        </div>`);
      this.hooks?.onCycle?.(result.cycle);
    }
  }

  _factories() {
    // 延迟 import 成本高，直接挂在 window 也可；这里由 app 注入
    return this.factoryFns;
  }
}

class FieldError extends Error {}

function clampInt(v, lo, hi, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
