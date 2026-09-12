/*
 * 几何约束求解器（确定性 / 可重复）
 *
 * 设计要点：
 * 1. 约束是有向边：follower(rect) -> anchor(other)。anchor 先定位，follower 后定位，
 *    因此整条依赖链在一次拓扑序遍历中完成，无迭代、无浮点收敛差异 —— 结果只取决于
 *    模型本身（矩形/约束 id 排序打破并列），同输入永远同输出。
 * 2. 每个矩形在同一轴上按“优先级升序”施加约束，使高优先级约束最后生效（覆盖弱约束）；
 *    同优先级按约束 id 排序，确定性地决定谁让步。被覆盖的约束不会被静默丢弃：
 *    evaluate() 阶段会逐条复验，未满足者连同冲突链一起上报。
 * 3. 拖动中的矩形是“硬钉住(pinned)”的伪约束（优先级 +Infinity）。
 * 4. 尺寸锁定在定位前恢复 w/h（求解器不改变尺寸）。
 * 5. 不允许有环：findCycle() 在提交前检查，命中即阻止提交并定位环上的矩形与约束。
 */

export const EPS = 0.01; // 判定“满足”的容差（逻辑坐标单位）

const CANVAS_NODE = '$canvas';
const DRAG_PREFIX = '#drag:';

/* ---------- 基础几何 ---------- */

function edgeCoord(r, axis, edge) {
  if (axis === 'x') {
    if (edge === 'l') return r.x;
    if (edge === 'r') return r.x + r.w;
    if (edge === 'mid') return r.x + r.w / 2;
  } else {
    if (edge === 't') return r.y;
    if (edge === 'b') return r.y + r.h;
    if (edge === 'mid') return r.y + r.h / 2;
  }
  throw new Error(`非法边: ${axis}/${edge}`);
}

function setAxisPos(r, axis, edge, coord) {
  // 移动矩形，使指定边/中点到达 coord
  if (axis === 'x') {
    if (edge === 'l') r.x = coord;
    else if (edge === 'r') r.x = coord - r.w;
    else r.x = coord - r.w / 2;
  } else {
    if (edge === 't') r.y = coord;
    else if (edge === 'b') r.y = coord - r.h;
    else r.y = coord - r.h / 2;
  }
}

export function constraintAxis(c) {
  if (c.kind === 'minGap') return c.side === 'left' || c.side === 'right' ? 'x' : 'y';
  return c.axis; // snap 自带 axis；contain/lock 不走轴向边
}

/* ---------- 依赖图 / 环检测 ---------- */

export function buildGraph(constraints) {
  const adj = new Map();
  const ensure = (n) => {
    if (!adj.has(n)) adj.set(n, []);
    return adj.get(n);
  };
  for (const c of constraints) {
    if (c.enabled === false) continue;
    if (c.kind === 'snap' || c.kind === 'minGap') {
      ensure(c.rect);
      ensure(c.other);
      adj.get(c.rect).push({ to: c.other, cid: c.id });
    }
    // contain -> 画布（画布恒定，不构成矩形间环）；lock -> 自环不产生定位依赖
  }
  return adj;
}

/**
 * 确定性 DFS 找环。返回 {nodeIds:[...闭合(首尾同id)], cids:[对应边]} 或 null。
 */
export function findCycle(constraints) {
  const adj = buildGraph(constraints);
  const nodes = [...adj.keys()].sort();
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(nodes.map((n) => [n, WHITE]));

  const dfs = (u, stackNodes, stackCids) => {
    color.set(u, GRAY);
    const outs = (adj.get(u) || []).slice().sort((a, b) =>
      a.to === b.to ? (a.cid < b.cid ? -1 : 1) : a.to < b.to ? -1 : 1
    );
    for (const { to, cid } of outs) {
      if (color.get(to) === GRAY) {
        const i = stackNodes.indexOf(to);
        return { nodeIds: [...stackNodes.slice(i), to], cids: [...stackCids.slice(i), cid] };
      }
      if (color.get(to) === WHITE) {
        stackNodes.push(to);
        stackCids.push(cid);
        const hit = dfs(to, stackNodes, stackCids);
        if (hit) return hit;
        stackNodes.pop();
        stackCids.pop();
      }
    }
    color.set(u, BLACK);
    return null;
  };

  for (const start of nodes) {
    if (color.get(start) === WHITE) {
      const hit = dfs(start, [start], []);
      if (hit) return hit;
    }
  }
  return null;
}

/* ---------- 拓扑序 ---------- */

function topoOrder(rectIds, constraints, axis) {
  // 仅统计该轴上生效的 follower->anchor 边（contain 指向画布根）
  const indeg = new Map();
  const outs = new Map();
  const nodes = new Set(rectIds);
  nodes.add(CANVAS_NODE);
  for (const id of nodes) { indeg.set(id, 0); outs.set(id, []); }

  for (const c of constraints) {
    if (c.enabled === false) continue;
    if (c.kind === 'contain') {
      outs.get(CANVAS_NODE).push({ to: c.rect, cid: c.id });
      indeg.set(c.rect, (indeg.get(c.rect) || 0) + 1);
    } else if (c.kind === 'snap' || c.kind === 'minGap') {
      if (constraintAxis(c) !== axis) continue;
      // 边 follower(rect) -> anchor(other)：anchor 必须先落位，
      // 故 Kahn 图里 anchor -> follower，follower 入度 +1
      outs.get(c.other).push({ to: c.rect, cid: c.id });
      indeg.set(c.rect, (indeg.get(c.rect) || 0) + 1);
    }
  }

  // Kahn：每次取入度为 0 中 id 最小者，保证顺序确定
  const ready = [...nodes].filter((n) => indeg.get(n) === 0).sort();
  const order = [];
  while (ready.length) {
    ready.sort();
    const n = ready.shift();
    order.push(n);
    for (const e of outs.get(n)) {
      indeg.set(e.to, indeg.get(e.to) - 1);
      if (indeg.get(e.to) === 0) ready.push(e.to);
    }
  }
  if (order.length !== nodes.size) {
    // 理论上不可达：提交时已拦环；防御性处理
    const rest = [...nodes].filter((n) => !order.includes(n)).sort();
    order.push(...rest);
  }
  return order;
}

/* ---------- 约束施加（1D 投影） ---------- */

function applyConstraint(c, axis, cur, canvas) {
  const r = cur.get(c.rect);
  const gap = Number(c.gap) || 0;

  if (c.kind === 'snap') {
    const a = cur.get(c.other);
    const target = edgeCoord(a, axis, c.otherEdge) + gap;
    setAxisPos(r, axis, c.edge, target);
  } else if (c.kind === 'minGap') {
    const a = cur.get(c.other);
    const g = Number(c.gap) || 0;
    if (axis === 'x') {
      if (c.side === 'left') {
        if (a.x - (r.x + r.w) < g) r.x = a.x - g - r.w;  // 仅在违反时推开
      } else {
        if (r.x - (a.x + a.w) < g) r.x = a.x + a.w + g;
      }
    } else {
      if (c.side === 'above') {
        if (a.y - (r.y + r.h) < g) r.y = a.y - g - r.h;
      } else {
        if (r.y - (a.y + a.h) < g) r.y = a.y + a.h + g;
      }
    }
  } else if (c.kind === 'contain') {
    const m = Number(c.margin) || 0;
    if (axis === 'x') {
      const lo = m, hi = canvas.w - m - r.w;
      if (lo <= hi + EPS) r.x = Math.min(hi, Math.max(lo, r.x));
    } else {
      const lo = m, hi = canvas.h - m - r.h;
      if (lo <= hi + EPS) r.y = Math.min(hi, Math.max(lo, r.y));
    }
  }
}

/* ---------- 约束复验 ---------- */

function evalConstraint(c, cur, canvas) {
  const r = cur.get(c.rect);
  const tol = EPS;

  if (c.kind === 'snap') {
    const a = cur.get(c.other);
    const diff = edgeCoord(r, c.axis, c.edge) - (edgeCoord(a, c.axis, c.otherEdge) + (Number(c.gap) || 0));
    return { satisfied: Math.abs(diff) <= tol, measure: diff };
  }
  if (c.kind === 'minGap') {
    const a = cur.get(c.other);
    const g = Number(c.gap) || 0;
    let slack;
    if (c.side === 'left') slack = a.x - (r.x + r.w) - g;
    else if (c.side === 'right') slack = r.x - (a.x + a.w) - g;
    else if (c.side === 'above') slack = a.y - (r.y + r.h) - g;
    else slack = r.y - (a.y + a.h) - g; // below
    return { satisfied: slack >= -tol, measure: slack };
  }
  if (c.kind === 'contain') {
    const m = Number(c.margin) || 0;
    const overX = r.w + 2 * m - canvas.w;
    const overY = r.h + 2 * m - canvas.h;
    if (overX > tol || overY > tol) {
      return { satisfied: false, measure: Math.max(overX, overY), reason: '矩形尺寸超过画布可容纳区域' };
    }
    const vx = r.x >= m - tol && r.x + r.w <= canvas.w - m + tol;
    const vy = r.y >= m - tol && r.y + r.h <= canvas.h - m + tol;
    return { satisfied: vx && vy, measure: vx && vy ? 0 : Math.min(r.x - m, canvas.w - m - (r.x + r.w), r.y - m, canvas.h - m - (r.y + r.h)) };
  }
  if (c.kind === 'lock') return null; // 尺寸锁定在 solve() 中单独评估
  return { satisfied: true, measure: 0 };
}

/* ---------- 主求解入口 ---------- */

/**
 * @param model {canvas:{w,h}, rects:[{id,name,x,y,w,h}], constraints:[...]}
 * @param drag  null 或 { pinned: { rectId: {x,y} }, group: [ids...] }
 *   group 中除被钉住的主矩形外，其余成员保持组内相对刚性平移（作为软钉住，仍可被
 *   更高优先级约束链解释为冲突来源）。
 * @returns 确定性结果对象
 */
export function solve(model, drag = null) {
  const canvas = { ...model.canvas };
  const orig = new Map(model.rects.map((r) => [r.id, { ...r }]));
  const cur = new Map(model.rects.map((r) => [r.id, { ...r }]));

  const pinXY = new Map(); // id -> {x,y}
  const groupOff = new Map();
  if (drag) {
    for (const [id, p] of Object.entries(drag.pinned || {})) {
      pinXY.set(id, { ...p });
      const r = cur.get(id);
      groupOff.set(id, { dx: p.x - r.x, dy: p.y - r.y });
    }
    for (const id of drag.group || []) {
      if (pinXY.has(id)) continue;
      const lead = Object.keys(drag.pinned || {})[0];
      const off = groupOff.get(lead);
      if (off) groupOff.set(id, { ...off }); // 组内同平移量
    }
  }

  const enabled = model.constraints.filter((c) => c.enabled !== false);

  // 0) 尺寸锁定：先恢复所有 locked 尺寸（求解器只移动、不缩放）
  for (const c of enabled) {
    if (c.kind === 'lock') {
      const r = cur.get(c.rect);
      r.w = Number(c.w);
      r.h = Number(c.h);
    }
  }

  const applied = [];

  const runAxis = (axis) => {
    const order = topoOrder([...cur.keys()], enabled, axis);
    for (const node of order) {
      if (node === CANVAS_NODE) continue;
      const r = cur.get(node);

      // 硬钉住（拖动主体）与组刚性平移优先落位
      const pin = pinXY.get(node);
      const grp = groupOff.get(node);
      if (pin) {
        if (axis === 'x') r.x = pin.x; else r.y = pin.y;
        continue;
      }
      if (grp) {
        const o = orig.get(node);
        if (axis === 'x') r.x = o.x + grp.dx;
        else r.y = o.y + grp.dy;
        continue;
      }

      // 该矩形在该轴上的出边约束：弱 -> 强，强者最后落位
      const mine = enabled
        .filter((c) => c.rect === node && (c.kind === 'contain' || ((c.kind === 'snap' || c.kind === 'minGap') && constraintAxis(c) === axis)))
        .slice()
        .sort((a, b) => (a.priority === b.priority ? (a.id < b.id ? -1 : 1) : a.priority - b.priority));
      for (const c of mine) {
        const before = axis === 'x' ? r.x : r.y;
        applyConstraint(c, axis, cur, canvas);
        const after = axis === 'x' ? r.x : r.y;
        applied.push({ cid: c.id, axis, moved: Math.abs(after - before) > EPS });
      }
    }
  };

  runAxis('x');
  runAxis('y');

  // 1) 逐条复验
  const cstatus = {};
  for (const c of model.constraints) {
    if (c.enabled === false) { cstatus[c.id] = { satisfied: false, disabled: true, measure: 0, blockers: [] }; continue; }
    if (c.kind === 'lock') {
      const r = cur.get(c.rect);
      cstatus[c.id] = {
        satisfied: Math.abs(r.w - Number(c.w)) <= EPS && Math.abs(r.h - Number(c.h)) <= EPS,
        measure: Math.max(Math.abs(r.w - Number(c.w)), Math.abs(r.h - Number(c.h))),
        blockers: [],
      };
      continue;
    }
    const ev = evalConstraint(c, cur, canvas);
    cstatus[c.id] = { satisfied: ev.satisfied, measure: ev.measure || 0, reason: ev.reason || null, blockers: [] };
  }

  // 2) 为未满足约束构造冲突链（不静默丢弃）
  const blockersFor = (c) => {
    const out = [];
    const isContain = c.kind === 'contain';
    if (pinXY.has(c.rect)) {
      out.push({ id: DRAG_PREFIX + c.rect, kind: 'drag', rect: c.rect, label: `拖动定位（${orig.get(c.rect).name || c.rect}）` });
    }
    if (groupOff.has(c.rect) && !pinXY.has(c.rect)) {
      out.push({ id: '#group', kind: 'group', rect: c.rect, label: `组整体拖动（${orig.get(c.rect).name || c.rect}）` });
    }
    const axis = isContain ? null : constraintAxis(c);
    for (const d of enabled) {
      if (d.id === c.id || d.rect !== c.rect) continue;
      if (d.kind === 'contain') {
        if (cstatus[d.id].satisfied) {
          out.push({ id: d.id, kind: d.kind, priority: d.priority, label: constraintLabel(d, orig) });
        }
        continue;
      }
      // contain 的让步方可来自任意轴；普通约束只看同轴
      if (!isContain && constraintAxis(d) !== axis) continue;
      // 同矩形、不低于本约束优先级且当前成立的约束 = 让本约束让步的一方
      if (d.priority >= c.priority && cstatus[d.id].satisfied) {
        out.push({ id: d.id, kind: d.kind, priority: d.priority, label: constraintLabel(d, orig) });
        // 该约束的 anchor 正在被拖动/整组移动 → 冲突根源继续追到拖动
        if ((d.kind === 'snap' || d.kind === 'minGap') && pinXY.has(d.other)) {
          out.push({ id: DRAG_PREFIX + d.other, kind: 'drag', rect: d.other, label: `拖动定位（${orig.get(d.other).name || d.other}）` });
        }
      }
    }
    return out;
  };

  const conflicts = [];
  for (const c of model.constraints) {
    const st = cstatus[c.id];
    if (st.satisfied) continue;
    if (st.disabled) continue;
    st.blockers = blockersFor(c);
    conflicts.push({
      cid: c.id,
      kind: c.kind,
      priority: c.priority,
      label: constraintLabel(c, orig),
      reason: st.reason || defaultReason(c),
      measure: st.measure,
      chain: st.blockers.map((b) => b.label),
      blockerIds: st.blockers.map((b) => b.id),
    });
  }

  // 3) 输出（四舍五入到 0.001，消除浮点噪声）
  const rectsOut = {};
  for (const [id, r] of cur) {
    rectsOut[id] = {
      x: round3(r.x), y: round3(r.y), w: round3(r.w), h: round3(r.h),
    };
  }

  const report = {
    rects: rectsOut,
    constraints: Object.fromEntries(Object.entries(cstatus).map(([id, s]) => [id, { satisfied: !!s.satisfied, disabled: !!s.disabled, measure: round3(s.measure || 0) }])),
    conflicts,
    applied,
    canvas: { w: round3(canvas.w), h: round3(canvas.h) },
  };
  report.hash = fingerprint(report);
  return report;
}

/* ---------- 文案 / 工具 ---------- */

export function constraintLabel(c, rects) {
  const name = (id) => (rects.get(id)?.name) || id;
  switch (c.kind) {
    case 'snap':
      return `贴齐 ${name(c.rect)}.${edgeName(c.axis, c.edge)} ↔ ${name(c.other)}.${edgeName(c.axis, c.otherEdge)}${c.gap ? ` (偏移 ${c.gap})` : ''}`;
    case 'minGap':
      return `最小间距 ${name(c.rect)} ${sideWord(c.side)} ${name(c.other)} ≥ ${c.gap}`;
    case 'contain':
      return `画布包含 ${name(c.rect)}（边距 ${c.margin || 0}）`;
    case 'lock':
      return `锁定尺寸 ${name(c.rect)} (${c.w}×${c.h})`;
    default:
      return c.id;
  }
}

function edgeName(axis, e) {
  if (e === 'mid') return '中';
  return { x: { l: '左', r: '右' }, y: { t: '顶', b: '底' } }[axis][e];
}
function sideWord(s) {
  return { left: '在…左侧', right: '在…右侧', above: '在…上方', below: '在…下方' }[s];
}
function defaultReason(c) {
  return { snap: '贴齐未达成（位置已被更高优先级约束/拖动占据）', minGap: '最小间距未达成（已为更高优先级约束让位）', contain: '矩形超出画布边界', lock: '尺寸与锁定值不一致' }[c.kind];
}

function round3(v) {
  return Math.round((v + Number.EPSILON) * 1000) / 1000;
}

/** 规范化指纹：同样的位置+约束成败 => 同样的 hash（FNV-1a, 32bit） */
export function fingerprint(report) {
  const canonical = JSON.stringify({
    canvas: report.canvas,
    rects: Object.keys(report.rects).sort().map((id) => [id, report.rects[id]]),
    constraints: Object.keys(report.constraints).sort().map((id) => [id, report.constraints[id].satisfied, report.constraints[id].disabled]),
    conflicts: report.conflicts.map((c) => [c.cid, c.blockerIds.slice().sort()]),
  });
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
