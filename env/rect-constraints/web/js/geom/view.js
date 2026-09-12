/*
 * View：SVG 渲染 + 指针交互。逻辑坐标(画布 1000×700)与像素的换算全部经过
 * SVG 的 getScreenCTM，因此窗口任意缩放、面板折叠都不改变模型关系。
 */

import { EPS } from './solver.js';

const SVGNS = 'http://www.w3.org/2000/svg';

const EDGE_LABEL = { l: '左', r: '右', t: '顶', b: '底', mid: '中' };
const SIDE_LABEL = { left: '左侧', right: '右侧', above: '上方', below: '下方' };

export class View {
  constructor(svg, store, hooks) {
    this.svg = svg;
    this.store = store;
    this.hooks = hooks; // {onSelect, onDrag, onDragEnd, onDragCancel, onDblClick, onResize}
    this.rectLayer = svg.querySelector('#rect-layer');
    this.edgeLayer = svg.querySelector('#edge-layer');
    this.overlayLayer = svg.querySelector('#overlay-layer');
    this.bg = svg.querySelector('#canvas-bg');

    this.selected = new Set();
    this.highlight = new Set(); // 约束/冲突联动高亮
    this.cycle = null;         // 被拒绝提交的环，用于红色动画高亮
    this.marquee = null;
    this.gesture = null;       // 进行中的指针手势（drag/resize/marquee）

    this._bindGestures();
    store.addEventListener('change', () => this.render());
    store.addEventListener('load', () => this.render());
    store.addEventListener('drag', () => this.render());
  }

  setCanvasSize(w, h) {
    this.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    this.bg.setAttribute('width', w);
    this.bg.setAttribute('height', h);
  }

  /* ---------- 坐标换算 ---------- */

  toLogical(clientX, clientY) {
    const ctm = this.svg.getScreenCTM();
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }

  /* ---------- 选择 ---------- */

  select(ids, additive = false) {
    if (!additive) this.selected = new Set(ids);
    else for (const id of ids) this.selected.add(id);
    this.render();
    this.hooks.onSelect?.(this.selected);
  }
  clearSelection() {
    this.selected.clear();
    this.render();
    this.hooks.onSelect?.(this.selected);
  }
  setCycleHighlight(cycle) {
    this.cycle = cycle;
    this.render();
  }
  setConstraintHighlight(cids) {
    this.highlight = new Set(cids);
    this.render();
  }

  /* ---------- 矩形：手势在 SVG 根上统一处理 ----------
   * 渲染会重建矩形 DOM，因此进行中的 move/up 不能挂在矩形节点上；
   * 一律在构造时挂到 svg 根，通过 gesture 状态区分拖动 / 调尺寸 / 框选。 */

  _hitRect(ev) {
    const t = ev.target;
    if (!(t instanceof Element)) return null;
    const g = t.closest?.('[data-rect]');
    return g ? g.getAttribute('data-rect') : null;
  }
  _isResizeHandle(ev) {
    return ev.target?.classList?.contains('handle') ? ev.target.closest('[data-rect]')?.getAttribute('data-rect') : null;
  }

  _bindGestures() {
    const svg = this.svg;
    svg.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      const resizeId = this._isResizeHandle(ev);
      const rectId = this._hitRect(ev);

      if (resizeId) {
        ev.preventDefault();
        const r = this.store.model.rects.find((x) => x.id === resizeId);
        const locked = this.store.model.constraints.some((c) => c.kind === 'lock' && c.rect === resizeId && c.enabled !== false);
        this.gesture = { type: 'resize', id: resizeId, start: this.toLogical(ev.clientX, ev.clientY), base: { ...r }, locked, moved: false };
        svg.setPointerCapture(ev.pointerId);
        return;
      }

      if (rectId) {
        ev.preventDefault();
        const additive = ev.shiftKey;
        if (!this.selected.has(rectId)) this.select([rectId], additive);
        else if (additive) { this.selected.delete(rectId); this.render(); this.hooks.onSelect?.(this.selected); return; }
        const group = [...this.selected];
        this.gesture = {
          type: 'drag', lead: rectId, group,
          r0: Object.fromEntries(this.store.model.rects.map((r) => [r.id, { ...r }])),
          start: this.toLogical(ev.clientX, ev.clientY), moved: false,
        };
        svg.setPointerCapture(ev.pointerId);
        return;
      }

      // 空白：准备框选
      if (ev.target === this.bg || ev.target?.classList?.contains('marquee-shape')) {
        if (!ev.shiftKey) this.clearSelection();
        this.gesture = { type: 'marquee', start: this.toLogical(ev.clientX, ev.clientY), additive: ev.shiftKey, moved: false };
        svg.setPointerCapture(ev.pointerId);
      }
    });

    svg.addEventListener('pointermove', (ev) => {
      const g = this.gesture;
      if (!g) return;
      const p = this.toLogical(ev.clientX, ev.clientY);
      const dx = p.x - g.start.x, dy = p.y - g.start.y;

      if (g.type === 'marquee') {
        if (Math.hypot(dx, dy) < 2) return;
        g.moved = true;
        this._drawMarquee(g.start, p);
        return;
      }
      if (g.type === 'drag') {
        if (!g.moved && Math.hypot(dx, dy) < 2) return;
        g.moved = true;
        const lead = g.r0[g.lead];
        this.hooks.onDrag?.({ [g.lead]: { x: lead.x + dx, y: lead.y + dy } }, g.group);
        return;
      }
      if (g.type === 'resize') {
        if (Math.hypot(dx, dy) < 2) return;
        g.moved = true;
        const MIN = 24, b = g.base;
        let x = b.x, y = b.y, w = b.w, h = b.h;
        // 仅右下角手柄（se）
        w = Math.max(MIN, b.w + dx);
        h = Math.max(MIN, b.h + dy);
        this.hooks.onResize?.(g.id, { x, y, w, h }, { live: true, locked: g.locked });
      }
    });

    const finish = (ev) => {
      const g = this.gesture;
      if (!g) return;
      this.gesture = null;
      if (g.type === 'marquee') {
        if (g.moved) {
          const p = this.toLogical(ev.clientX, ev.clientY);
          const x1 = Math.min(g.start.x, p.x), y1 = Math.min(g.start.y, p.y);
          const x2 = Math.max(g.start.x, p.x), y2 = Math.max(g.start.y, p.y);
          const ids = this.store.model.rects
            .filter((r) => r.x < x2 && r.x + r.w > x1 && r.y < y2 && r.y + r.h > y1)
            .map((r) => r.id);
          if (ids.length) this.select(ids, g.additive);
        }
        this._clearMarquee();
      } else if (g.type === 'drag') {
        if (g.moved) this.hooks.onDragEnd?.();
      } else if (g.type === 'resize') {
        if (g.moved) this.hooks.onResize?.(g.id, null, { live: false, locked: g.locked });
      }
    };
    svg.addEventListener('pointerup', finish);
    svg.addEventListener('pointercancel', () => { this.gesture = null; this._clearMarquee(); this.hooks.onDragCancel?.(); });

    svg.addEventListener('dblclick', (ev) => {
      const id = this._hitRect(ev);
      if (id) this.hooks.onDblClick?.(id);
    });
  }

  _drawMarquee(a, b) {
    if (!this.marquee) {
      this.marquee = document.createElementNS(SVGNS, 'rect');
      this.marquee.setAttribute('class', 'marquee-shape');
      this.marquee.setAttribute('fill', 'rgba(47,111,237,.08)');
      this.marquee.setAttribute('stroke', '#2f6fed');
      this.marquee.setAttribute('stroke-dasharray', '4 3');
      this.bg.parentNode.appendChild(this.marquee);
    }
    this.marquee.setAttribute('x', Math.min(a.x, b.x));
    this.marquee.setAttribute('y', Math.min(a.y, b.y));
    this.marquee.setAttribute('width', Math.abs(a.x - b.x));
    this.marquee.setAttribute('height', Math.abs(a.y - b.y));
  }
  _clearMarquee() { this.marquee?.remove(); this.marquee = null; }

  /* ---------- 渲染 ---------- */

  render() {
    const { model, report } = this.store;
    this.setCanvasSize(model.canvas.w, model.canvas.h);
    this._renderRects(model, report);
    this._renderEdges(model, report);
  }

  _rectRects() {
    const { model, report } = this.store;
    this.rectLayer.replaceChildren();
    const bad = new Set(report.conflicts.map((c) => {
      const cdef = model.constraints.find((x) => x.id === c.cid);
      return cdef?.rect;
    }).filter(Boolean));
    const lockedIds = new Set(model.constraints.filter((c) => c.kind === 'lock' && c.enabled !== false).map((c) => c.rect));

    for (const r of model.rects) {
      const p = report.rects[r.id] || r;
      const g = document.createElementNS(SVGNS, 'g');
      g.setAttribute('data-rect', r.id);
      g.setAttribute('class', 'rect-g' +
        (this.selected.has(r.id) ? ' selected' : '') +
        (bad.has(r.id) ? ' conflict' : ''));

      const shape = document.createElementNS(SVGNS, 'rect');
      const cls = ['rect-shape'];
      if (lockedIds.has(r.id)) cls.push('locked');
      if (this.selected.size > 1 && this.selected.has(r.id)) cls.push('ingroup');
      if (this.gesture?.type === 'drag' && this.gesture.group.includes(r.id)) cls.push('dragging');
      shape.setAttribute('class', cls.join(' '));
      shape.setAttribute('x', p.x); shape.setAttribute('y', p.y);
      shape.setAttribute('width', p.w); shape.setAttribute('height', p.h);
      shape.setAttribute('rx', 7);
      g.appendChild(shape);

      const name = document.createElementNS(SVGNS, 'text');
      name.setAttribute('class', 'rect-label');
      name.setAttribute('x', p.x + 10); name.setAttribute('y', p.y + 21);
      name.textContent = r.name || r.id.slice(-5);
      g.appendChild(name);

      const size = document.createElementNS(SVGNS, 'text');
      size.setAttribute('class', 'rect-size');
      size.setAttribute('x', p.x + 10); size.setAttribute('y', p.y + p.h - 9);
      size.textContent = `${Math.round(p.w)} × ${Math.round(p.h)}`;
      g.appendChild(size);

      if (lockedIds.has(r.id)) {
        const lock = document.createElementNS(SVGNS, 'text');
        lock.setAttribute('class', 'lock-glyph');
        lock.setAttribute('x', p.x + p.w - 18); lock.setAttribute('y', p.y + 21);
        lock.textContent = '🔒';
        g.appendChild(lock);
      }

      // 缩放手柄（选中且未锁定尺寸时）
      if (this.selected.has(r.id) && !lockedIds.has(r.id)) {
        const h = document.createElementNS(SVGNS, 'rect');
        h.setAttribute('class', 'handle');
        h.setAttribute('x', p.x + p.w - 6); h.setAttribute('y', p.y + p.h - 6);
        h.setAttribute('width', 11); h.setAttribute('height', 11); h.setAttribute('rx', 2);
        g.appendChild(h);
      }

      this.rectLayer.appendChild(g);
    }
  }

  _renderRects() { this._rectRects(); }

  _renderEdges(model, report) {
    this.edgeLayer.replaceChildren();
    const pos = (id) => report.rects[id] || model.rects.find((r) => r.id === id);

    for (const c of model.constraints) {
      if (c.enabled === false) continue;
      const st = report.constraints[c.id];
      const bad = st && !st.satisfied;
      const hl = this.highlight.has(c.id);

      if (c.kind === 'snap') this._drawSnap(c, pos, bad, hl);
      else if (c.kind === 'minGap') this._drawGap(c, pos, bad, hl);
      else if (c.kind === 'contain') this._drawContain(c, pos, bad, hl);
      // lock 用矩形虚线边框表达，不画线
    }

    // 环高亮
    if (this.cycle) this._drawCycle(this.cycle, pos);
  }

  _center(id, pos) { const r = pos(id); return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; }
  _edgePoint(id, edge, pos) {
    const r = pos(id);
    switch (edge) {
      case 'l': return { x: r.x, y: r.y + r.h / 2 };
      case 'r': return { x: r.x + r.w, y: r.y + r.h / 2 };
      case 't': return { x: r.x + r.w / 2, y: r.y };
      case 'b': return { x: r.x + r.w / 2, y: r.y + r.h };
      default: return this._center(id, pos);
    }
  }

  _tag(text, x, y, cls = '') {
    const t = document.createElementNS(SVGNS, 'text');
    t.setAttribute('class', `edge-tag ${cls}`);
    t.setAttribute('x', x); t.setAttribute('y', y);
    t.setAttribute('text-anchor', 'middle');
    t.textContent = text;
    this.edgeLayer.appendChild(t);
  }

  _drawSnap(c, pos, bad, hl) {
    const p1 = this._edgePoint(c.rect, c.edge, pos);
    const p2 = this._edgePoint(c.other, c.otherEdge, pos);
    const line = document.createElementNS(SVGNS, 'line');
    line.setAttribute('x1', p1.x); line.setAttribute('y1', p1.y);
    line.setAttribute('x2', p2.x); line.setAttribute('y2', p2.y);
    line.setAttribute('class', 'edge-snap' + (bad ? ' edge-bad' : '') + (hl ? ' edge-hl' : ''));
    if (hl) line.setAttribute('stroke-width', 3);
    this.edgeLayer.appendChild(line);
    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
    this._tag(`贴齐 ${EDGE_LABEL[c.edge]}–${EDGE_LABEL[c.otherEdge]}${c.gap ? ` ±${c.gap}` : ''}`, mx, my - 5, bad ? 'edge-bad' : '');
  }

  _drawGap(c, pos, bad, hl) {
    const a = pos(c.other), r = pos(c.rect);
    let x1, y1, x2, y2, mx, my;
    if (c.side === 'right' || c.side === 'left') {
      const left = c.side === 'right' ? a : r, right = c.side === 'right' ? r : a;
      x1 = left.x + left.w; x2 = right.x;
      y1 = y2 = Math.max(left.y, right.y) + Math.min(left.h, right.h) / 2;
      mx = (x1 + x2) / 2; my = y1 - 6;
    } else {
      const top = c.side === 'below' ? a : r, bot = c.side === 'below' ? r : a;
      y1 = top.y + top.h; y2 = bot.y;
      x1 = x2 = Math.max(top.x, bot.x) + Math.min(top.w, bot.w) / 2;
      mx = x1 + 6; my = (y1 + y2) / 2;
    }
    const l = document.createElementNS(SVGNS, 'line');
    l.setAttribute('x1', x1); l.setAttribute('y1', y1); l.setAttribute('x2', x2); l.setAttribute('y2', y2);
    l.setAttribute('class', 'edge-gap' + (bad ? ' edge-bad' : '') + (hl ? ' edge-hl' : ''));
    if (hl) l.setAttribute('stroke-width', 3);
    l.setAttribute('marker-start', 'url(#arrow)'); l.setAttribute('marker-end', 'url(#arrow)');
    this.edgeLayer.appendChild(l);
    this._tag(`≥${c.gap}`, mx, my, bad ? 'edge-bad' : '');
  }

  _drawContain(c, pos, bad) {
    const r = pos(c.rect), m = c.margin || 0;
    const q = document.createElementNS(SVGNS, 'rect');
    q.setAttribute('x', r.x - 6); q.setAttribute('y', r.y - 6);
    q.setAttribute('width', r.w + 12); q.setAttribute('height', r.h + 12); q.setAttribute('rx', 10);
    q.setAttribute('class', 'edge-contain' + (bad ? ' edge-bad' : ''));
    this.edgeLayer.appendChild(q);
    if (bad) this._tag('超出画布', r.x + r.w / 2, r.y - 12, 'edge-bad');
  }

  _drawCycle(cycle, pos) {
    const pts = cycle.nodeIds.map((id) => this._center(id, pos));
    const poly = document.createElementNS(SVGNS, 'polygon');
    poly.setAttribute('points', pts.map((p) => `${p.x},${p.y}`).join(' '));
    poly.setAttribute('class', 'cycle-hit');
    poly.setAttribute('fill', 'rgba(214,69,69,.06)');
    this.edgeLayer.appendChild(poly);
  }
}
