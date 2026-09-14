#!/usr/bin/env python3
"""
矩形约束编辑器 —— 静态文件 + 单文档 JSON 持久化（含布局版本与乐观并发）。
仅使用 Python 标准库（http.server / threading），便于极小镜像部署。

  GET  /                 -> web/index.html
  GET  /api/doc          -> 当前文档（含审计事件流、分支、布局版本、rev）
  PUT  /api/doc          -> 保存（原子写 + 结构校验 + baseRev/baseHeads 乐观并发）
  POST /api/reset        -> 删除服务端存档（客户端随后会重建）

乐观并发：
- 文档带单调递增 rev，客户端必须携带 baseRev（文档级覆盖保护）；
- 同时携带 baseHeads = {分支 id: 所依据的 head 事件 id}（“所依据的事件序号”）。
  同一分支 head 已在另一页面前进 -> 409 {reason:"branch-advanced", headEventId}
  并拒绝覆盖；若过期提交落在另一个页面新建/编辑的*不同分支*上，则按
  _merge_docs 合流（审计事件不可变、按 id 并集），两边内容都保留。

数据文件由 DATA_PATH 环境变量决定（默认 /data/doc.json），
Docker 中挂载为卷；本地裸跑回退到 ./data/doc.json。
"""

import json
import os
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8080"))
DATA_PATH = Path(os.environ.get("DATA_PATH", "/data/doc.json"))
WEB_ROOT = Path(__file__).resolve().parent.parent / "web"
MAX_BODY = 8 * 1024 * 1024  # 8 MiB

_lock = threading.Lock()

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8",
    ".ico": "image/x-icon",
}


def _load_doc():
    if not DATA_PATH.exists():
        return None
    try:
        with DATA_PATH.open("r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        # 损坏文件不吞掉：备份后按无存档处理
        try:
            DATA_PATH.rename(DATA_PATH.with_suffix(".corrupt.json"))
        except OSError:
            pass
        return None


def _save_doc(doc):
    DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(DATA_PATH.parent), prefix=".doc-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, DATA_PATH)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def _valid_shape(doc):
    """轻量结构校验，重活在浏览器求解器/审计清洗里。"""
    if not isinstance(doc, dict):
        return False
    # 乐观并发：客户端必须声明自己基于的服务端版本号
    if not isinstance(doc.get("baseRev"), int) or isinstance(doc.get("baseRev"), bool) or doc["baseRev"] < 0:
        return False
    events = doc.get("events")
    branches = doc.get("branches")
    if isinstance(events, list) and isinstance(branches, list):
        # 新格式：审计事件流 + 分支
        if not events or not branches:
            return False
        for e in events:
            if not isinstance(e, dict) or not isinstance(e.get("id"), str):
                return False
            m = e.get("model")
            if not isinstance(m, dict) or not isinstance(m.get("rects"), list) or not isinstance(m.get("constraints"), list):
                return False
        for b in branches:
            if not isinstance(b, dict) or not isinstance(b.get("id"), str) or not isinstance(b.get("name"), str):
                return False
            if not isinstance(b.get("headEventId"), str) or not isinstance(b.get("rootEventId"), str):
                return False
        if not isinstance(doc.get("currentBranchId"), str):
            return False
    else:
        # 兼容旧格式（迁移由客户端完成）：基础 entries 校验
        entries = doc.get("entries")
        if not isinstance(entries, list) or not entries:
            return False
        idx = doc.get("idx")
        if not isinstance(idx, int) or not (0 <= idx < len(entries)):
            return False
        for e in entries:
            m = e.get("model")
            if not isinstance(m, dict) or not isinstance(m.get("rects"), list) or not isinstance(m.get("constraints"), list):
                return False
    # 布局版本：只读快照列表（可为空）
    versions = doc.get("versions", [])
    if not isinstance(versions, list):
        return False
    for v in versions:
        if not isinstance(v, dict):
            return False
        if not isinstance(v.get("id"), str) or not isinstance(v.get("name"), str):
            return False
        m = v.get("model")
        if not isinstance(m, dict) or not isinstance(m.get("rects"), list) or not isinstance(m.get("constraints"), list):
            return False
    # 布局方案实验（可为空）：只做轻量结构校验，指纹/损坏清洗在浏览器
    experiments = doc.get("experiments", [])
    if not isinstance(experiments, list):
        return False
    for x in experiments:
        if not isinstance(x, dict) or not isinstance(x.get("id"), str) or not isinstance(x.get("name"), str):
            return False
        bm = x.get("baseModel")
        if not isinstance(bm, dict) or not isinstance(bm.get("rects"), list) or not isinstance(bm.get("constraints"), list):
            return False
        vs2 = x.get("variants")
        if not isinstance(vs2, list) or not vs2:
            return False
        for vv in vs2:
            if not isinstance(vv, dict) or not isinstance(vv.get("id"), str):
                return False
            if vv.get("status") not in (None, "queued", "running", "done", "failed", "cancelled"):
                return False
    # 审阅会话（可为空）：只做轻量结构校验，指纹对账在浏览器纯函数里
    reviews = doc.get("reviewSessions", [])
    if not isinstance(reviews, list):
        return False
    for r in reviews:
        if not isinstance(r, dict) or not isinstance(r.get("id"), str) or not isinstance(r.get("name"), str):
            return False
        rn = r.get("nodes")
        if not isinstance(rn, list) or not rn:
            return False
        for n in rn:
            if not isinstance(n, dict) or not isinstance(n.get("key"), str):
                return False
            if n.get("decision") not in ("pending", "pass", "reject", "review"):
                return False
    # 审阅通知与升级中心（可为空）：轻量结构校验，对账 / 幂等在浏览器纯函数里
    if not _valid_notify_shape(doc):
        return False
    return True


def _valid_notify_shape(doc):
    events = doc.get("notifyEvents", [])
    if not isinstance(events, list):
        return False
    for e in events:
        if not isinstance(e, dict) or not isinstance(e.get("id"), str) or not isinstance(e.get("sessionId"), str):
            return False
        if e.get("type") not in (
            "decision", "signature", "node-confirmed", "conflict", "conflict-resolved",
            "session-completed", "session-reopened",
        ):
            return False
    rules = doc.get("notifyRules", [])
    if not isinstance(rules, list):
        return False
    for rr in rules:
        if not isinstance(rr, dict) or not isinstance(rr.get("id"), str) or not isinstance(rr.get("sessionId"), str):
            return False
        if not isinstance(rr.get("rev"), int) or isinstance(rr.get("rev"), bool):
            return False
        if not isinstance(rr.get("levels"), list):
            return False
    items = doc.get("notifications", [])
    if not isinstance(items, list):
        return False
    for n in items:
        if not isinstance(n, dict) or not isinstance(n.get("id"), str) or not isinstance(n.get("ruleId"), str):
            return False
        if not isinstance(n.get("eventId"), str) or not isinstance(n.get("recipient"), str):
            return False
        if n.get("status") not in (
            "scheduled", "deferred", "pending", "sent", "delivered", "acknowledged",
            "snoozed", "transferred", "failed", "cancelled",
        ):
            return False
    outbox = doc.get("notifyOutbox", [])
    if not isinstance(outbox, list):
        return False
    for o in outbox:
        if not isinstance(o, dict) or not isinstance(o.get("id"), str) or not isinstance(o.get("notifyId"), str):
            return False
    # 批量处理结果（append-only，可为空）：轻量结构校验
    batches = doc.get("notifyBatches", [])
    if not isinstance(batches, list):
        return False
    for b in batches:
        if not isinstance(b, dict) or not isinstance(b.get("id"), str):
            return False
        if b.get("action") not in ("ack", "snooze", "transfer"):
            return False
        if not isinstance(b.get("results", []), list):
            return False
    # 本地通知草稿（批量部分版本冲突保留，可为空）
    drafts = doc.get("notifyDrafts", [])
    if not isinstance(drafts, list):
        return False
    for d in drafts:
        if not isinstance(d, dict) or not isinstance(d.get("id"), str) or not isinstance(d.get("notifyId"), str):
            return False
        if d.get("action") not in ("ack", "snooze", "transfer"):
            return False
    return True


def _is_legacy(doc):
    return not (isinstance(doc.get("events"), list) and isinstance(doc.get("branches"), list))


def _assess_conflict(cur, doc):
    """返回 (可合流, 冲突信息 dict)。与 web/js/geom/audit.js assessConflict 同构。"""
    if not cur or _is_legacy(cur) or _is_legacy(doc):
        return True, None
    cur_events = {e["id"]: e for e in cur.get("events", []) if isinstance(e, dict)}
    cur_branches = {b["id"]: b for b in cur.get("branches", []) if isinstance(b, dict)}
    cur_id = doc.get("currentBranchId")
    base_heads = doc.get("baseHeads") or {}
    sb = cur_branches.get(cur_id)
    if sb is None:
        # 客户端新建的分支：其 fork 来源事件必须已在服务端。
        # fork-root 事件是本次提交新增的，要从【客户端提交体】里找它，
        # 再检查它 provenance 指向的来源事件是否已存在于服务端。
        nb = next((b for b in doc.get("branches", []) if isinstance(b, dict) and b.get("id") == cur_id), None)
        root = next((e for e in doc.get("events", []) if isinstance(e, dict) and e.get("id") == (nb or {}).get("rootEventId")), None)
        prov = root.get("provenance") if isinstance(root, dict) else None
        src_id = prov.get("eventId") if isinstance(prov, dict) else None
        if nb and src_id and src_id in cur_events:
            return True, None
        return False, {"reason": "branch-missing", "branchId": cur_id}
    if base_heads.get(cur_id) != sb.get("headEventId"):
        head = cur_events.get(sb.get("headEventId"), {})
        return False, {
            "reason": "branch-advanced",
            "branchId": cur_id,
            "branchName": sb.get("name", cur_id),
            "headEventId": sb.get("headEventId"),
            "headSeq": head.get("seq"),
        }
    return True, None


def _variant_rank(v):
    if v.get("corrupt"):
        return 0
    return {"queued": 0, "running": 1, "cancelled": 2, "failed": 3, "done": 4}.get(v.get("status"), 0)


def _merge_variant(a, b):
    """同 web/js/geom/experiments.js mergeVariant：走得更远的状态胜出，完成结果不降级。"""
    win = b if _variant_rank(b) > _variant_rank(a) else a
    out = dict(a)
    out["name"] = a.get("name")
    out["order"] = a.get("order", b.get("order"))
    out["changes"] = a.get("changes")
    out["status"] = win.get("status")
    out["error"] = win.get("error", a.get("error"))
    try:
        out["attempts"] = max(int(a.get("attempts") or 0), int(b.get("attempts") or 0))
    except (TypeError, ValueError):
        out["attempts"] = 0
    good_a = a.get("result") if not a.get("corrupt") else None
    good_b = b.get("result") if not b.get("corrupt") else None
    result = good_a or good_b or a.get("result") or b.get("result")
    out["result"] = result
    if not result and (a.get("corrupt") or b.get("corrupt")):
        out["corrupt"] = True
        out["corruptReason"] = a.get("corruptReason") or b.get("corruptReason") or "结果损坏"
    else:
        out.pop("corrupt", None)
        out.pop("corruptReason", None)
    return out


def _experiment_terminal_count(x):
    return sum(1 for v in x.get("variants", []) if v.get("status") in ("done", "failed", "cancelled"))


def _merge_one_experiment(s, c):
    """同 mergeOneExperiment：变体按 id 合并，完成数更多的一方决定实验级运行状态。"""
    sv = {v["id"]: v for v in s.get("variants", []) if isinstance(v, dict) and isinstance(v.get("id"), str)}
    order = [v["id"] for v in s.get("variants", []) if isinstance(v, dict) and isinstance(v.get("id"), str)]
    for cv in c.get("variants", []):
        if not isinstance(cv, dict) or not isinstance(cv.get("id"), str):
            continue
        cid = cv["id"]
        if cid not in sv:
            sv[cid] = cv
            order.append(cid)
        else:
            sv[cid] = _merge_variant(sv[cid], cv)
    variants = [sv[i] for i in order]
    winner = c if _experiment_terminal_count(c) > _experiment_terminal_count(s) else s
    has_running = any(v.get("status") == "running" for v in variants)
    has_queued = any(v.get("status") == "queued" for v in variants)
    has_cancelled = any(v.get("status") == "cancelled" for v in variants)
    rs = winner.get("runState")
    if has_running:
        state = "running"
    elif rs == "cancelled":
        state = "cancelled"
    elif has_queued:
        state = "paused" if rs in ("running", "paused") else "queued"
    else:
        state = "cancelled" if (has_cancelled or rs == "cancelled") else "done"
    merged = dict(s)
    merged["variants"] = variants
    try:
        merged["updatedAt"] = max(int(s.get("updatedAt") or 0), int(c.get("updatedAt") or 0))
    except (TypeError, ValueError):
        merged["updatedAt"] = s.get("updatedAt", 0)
    merged["runState"] = state
    if s.get("baseCorrupt") or c.get("baseCorrupt"):
        merged["baseCorrupt"] = True
    return merged


def _merge_experiments(server_list, client_list):
    """实验按 id 并集（与 web/js/geom/experiments.js mergeExperiments 同构）。"""
    by_id = {}
    order = []
    for x in list(server_list or []) + list(client_list or []):
        if not isinstance(x, dict) or not isinstance(x.get("id"), str):
            continue
        xid = x["id"]
        if xid not in by_id:
            by_id[xid] = x
            order.append(xid)
        else:
            # 后出现的是 client 侧
            by_id[xid] = _merge_one_experiment(by_id[xid], x)
    return [by_id[i] for i in order]


def _review_node_bad(node, events_by_id, branches_by_id, experiments):
    """审阅会话节点完整性（与 web/js/geom/reviews.js checkReviewNodeAgainstServer 同构）。"""
    key = str(node.get("key") or "")
    if key.startswith("event:"):
        eid = key[6:]
        ev = events_by_id.get(eid)
        if not ev:
            return "review-node-missing"
        fp = node.get("fingerprint")
        if isinstance(fp, str) and fp and isinstance(ev.get("hash"), str) and ev["hash"] != fp:
            return "review-fingerprint-changed"
        # root / fork-root 是各分支链顶，恒在链上
        if not ev.get("parentId"):
            return None
        bid = node.get("branchId") or ev.get("branch")
        b = branches_by_id.get(bid)
        if b:
            on_chain = False
            cur = events_by_id.get(b.get("headEventId"))
            guard = 0
            while cur and guard < 100000:
                guard += 1
                if cur.get("id") == eid:
                    on_chain = True
                    break
                cur = events_by_id.get(cur.get("parentId")) if cur.get("parentId") else None
            if not on_chain:
                return "review-branch-advanced"
        return None
    if key.startswith("variant:"):
        rest = key[8:]
        sep = rest.find(":")
        exp_id, vid = rest[:sep], rest[sep + 1:]
        exp = next((x for x in (experiments or []) if isinstance(x, dict) and x.get("id") == exp_id), None)
        v = next((vv for vv in (exp.get("variants") if exp else []) or [] if isinstance(vv, dict) and vv.get("id") == vid), None)
        if not exp or not v or v.get("status") != "done" or not isinstance(v.get("result"), dict):
            return "review-node-missing"
        fp = node.get("fingerprint")
        rh = v["result"].get("hash")
        if isinstance(fp, str) and fp and isinstance(rh, str) and rh != fp:
            return "review-fingerprint-changed"
        return None
    return None


def _effective_review_view(cur, doc):
    """服务端状态并上本次提交的不可变事件/新分支/实验（同包新事件是合法引用来源）。"""
    evs = {e["id"]: e for e in (cur or {}).get("events", []) if isinstance(e, dict) and isinstance(e.get("id"), str)}
    for e in doc.get("events", []) or []:
        if isinstance(e, dict) and isinstance(e.get("id"), str):
            evs.setdefault(e["id"], e)
    branches = {b["id"]: b for b in (cur or {}).get("branches", []) if isinstance(b, dict) and isinstance(b.get("id"), str)}
    cur_id = doc.get("currentBranchId")
    for b in doc.get("branches", []) or []:
        if isinstance(b, dict) and isinstance(b.get("id"), str):
            if b["id"] == cur_id:
                branches[b["id"]] = b
            else:
                branches.setdefault(b["id"], b)
    exps = {x["id"]: x for x in (cur or {}).get("experiments", []) if isinstance(x, dict) and isinstance(x.get("id"), str)}
    for x in doc.get("experiments", []) or []:
        if isinstance(x, dict) and isinstance(x.get("id"), str):
            exps.setdefault(x["id"], x)
    return evs, branches, list(exps.values())


def _review_signature_bad(session, server_session):
    """多人签名名单/重复有效签名的轻量校验（与浏览器 assessServerReviewConflict 同构）。"""
    policy = session.get("policy") if isinstance(session, dict) else None
    if not isinstance(policy, dict) or policy.get("mode") != "signoff":
        return None
    signers = {x for x in policy.get("signers", []) if isinstance(x, str)}
    try:
        required = int(policy.get("required") or 0)
    except (TypeError, ValueError):
        required = 0
    if not signers or required < 1 or required > len(signers):
        return {"reason": "review-policy-invalid"}
    old_nodes = {n.get("key"): n for n in (server_session or {}).get("nodes", []) if isinstance(n, dict)}
    for node in session.get("nodes", []) or []:
        if not isinstance(node, dict):
            continue
        old = old_nodes.get(node.get("key")) or {}
        old_sigs = {s.get("id"): s for s in old.get("signatures", []) if isinstance(s, dict)}
        seen = {s.get("by") for s in old.get("signatures", []) if isinstance(s, dict) and not s.get("invalid")}
        active = [s for s in old.get("signatures", []) if isinstance(s, dict) and not s.get("invalid")]
        for sg in node.get("signatures", []) or []:
            if not isinstance(sg, dict):
                continue
            old_sg = old_sigs.get(sg.get("id"))
            if old_sg:
                invalid_changed = bool(old_sg.get("invalid")) != bool(sg.get("invalid"))
                fields_changed = (
                    not old_sg.get("invalid") and not sg.get("invalid") and (
                        old_sg.get("by") != sg.get("by")
                        or old_sg.get("decision") != sg.get("decision")
                        or (old_sg.get("reason") or "") != (sg.get("reason") or "")
                    )
                )
                if invalid_changed or fields_changed:
                    return {"reason": "review-signature-history-changed", "nodeKey": node.get("key")}
                continue
            if sg.get("invalid"):
                continue
            by = sg.get("by")
            if by not in signers:
                return {"reason": "review-signer-not-allowed", "nodeKey": node.get("key")}
            if by in seen:
                return {"reason": "review-duplicate-signer", "nodeKey": node.get("key")}
            seen.add(by)
            active.append(sg)
        if session.get("status") == "completed":
            if len(active) < required:
                return {"reason": "review-signature-shortfall", "nodeKey": node.get("key")}
            if policy.get("completeRule") == "no-reject" and any(sg.get("decision") == "reject" for sg in active):
                return {"reason": "review-completion-has-reject", "nodeKey": node.get("key")}
    return None


def _assess_review_conflict(cur, doc):
    """
    审阅会话乐观并发（与 web/js/geom/reviews.js assessServerReviewConflict 同构）。
    只对本次推进了 rev 的会话核验：另一窗口已前进 / 节点指纹变化 / 节点缺失 /
    事件所在分支已推进 → 409（后提交者本地决定保留，逐项合并）。
    """
    base_revs = doc.get("baseReviewRevs")
    if not isinstance(base_revs, dict):
        return None
    if not isinstance(cur, dict):
        cur = {}
    cur_sessions = {s["id"]: s for s in cur.get("reviewSessions", []) if isinstance(s, dict) and isinstance(s.get("id"), str)}
    # 即将生效的权威视图（并上本次提交的不可变事件 / 新分支 / 实验）
    events_by_id, branches_by_id, experiments = _effective_review_view(cur, doc)
    for s in doc.get("reviewSessions", []) or []:
        if not isinstance(s, dict) or not isinstance(s.get("id"), str):
            continue
        sid = s["id"]
        base = base_revs.get(sid)
        if not isinstance(base, int) or isinstance(base, bool):
            continue
        try:
            srev = int(s.get("rev"))
        except (TypeError, ValueError):
            continue
        if srev <= base:
            continue  # 未推进该会话（与审阅无关的保存）：不拦截
        srv = cur_sessions.get(sid)
        if srv and srv.get("rev") != base:
            return {"reason": "review-advanced", "sessionId": sid, "serverRev": srv.get("rev", 1), "session": srv}
        sig_bad = _review_signature_bad(s, srv)
        if sig_bad:
            return {**sig_bad, "sessionId": sid, "serverRev": (srv or {}).get("rev", base), "session": srv}
        for n in s.get("nodes", []) or []:
            if not isinstance(n, dict):
                continue
            bad = _review_node_bad(n, events_by_id, branches_by_id, experiments)
            if bad:
                return {"reason": bad, "sessionId": sid, "nodeKey": n.get("key"),
                        "serverRev": (srv or {}).get("rev", base), "session": srv}
    return None


def _merge_review_sessions(server_list, client_list):
    """审阅会话按 id 并集；同 id 以 rev 更大者整体胜出，冲突记录按 id 并集。"""
    by_id = {}
    order = []
    for s in list(server_list or []):
        if isinstance(s, dict) and isinstance(s.get("id"), str):
            by_id[s["id"]] = s
            order.append(s["id"])
    for c in list(client_list or []):
        if not isinstance(c, dict) or not isinstance(c.get("id"), str):
            continue
        cid = c["id"]
        if cid not in by_id:
            by_id[cid] = c
            order.append(cid)
            continue
        s = by_id[cid]
        winner = c if int(c.get("rev") or 0) > int(s.get("rev") or 0) else s
        conflicts = {x.get("id"): x for x in winner.get("conflicts", []) if isinstance(x, dict) and x.get("id")}
        for x in list(s.get("conflicts", []) or []) + list(c.get("conflicts", []) or []):
            if not isinstance(x, dict) or not x.get("id"):
                continue
            ex = conflicts.get(x["id"])
            if not ex or (not ex.get("resolved") and x.get("resolved")):
                conflicts[x["id"]] = x
        merged = dict(winner)
        merged["conflicts"] = list(conflicts.values())
        by_id[cid] = merged
    return [by_id[i] for i in order]


def _notify_event_sort(e):
    rank = {
        "session-reopened": 0, "session-completed": 1, "conflict": 2,
        "conflict-resolved": 3, "decision": 4, "signature": 5, "node-confirmed": 6,
    }.get(e.get("type"), 9)
    return (int(e.get("at") or 0), rank, e.get("id") or "")


def _merge_notify_events(server_list, client_list):
    """通知事件 append-only，按 id 并集。"""
    by_id = {}
    for e in list(server_list or []) + list(client_list or []):
        if isinstance(e, dict) and isinstance(e.get("id"), str):
            by_id.setdefault(e["id"], e)
    return sorted(by_id.values(), key=_notify_event_sort)


def _merge_notify_rules(server_list, client_list):
    """规则按 id 并集；rev / 墓碑 deleteRev 更大者整体胜出，旧副本不能复活删除。"""
    by_id, order = {}, []
    for r in list(server_list or []) + list(client_list or []):
        if not isinstance(r, dict) or not isinstance(r.get("id"), str):
            continue
        rid = r["id"]
        if rid not in by_id:
            by_id[rid] = r
            order.append(rid)
            continue
        ex = by_id[rid]
        ex_rev = max(int(ex.get("rev") or 0), int(ex.get("deleteRev") or 0) if ex.get("deleteRev") else 0)
        new_rev = max(int(r.get("rev") or 0), int(r.get("deleteRev") or 0) if r.get("deleteRev") else 0)
        if new_rev > ex_rev:
            by_id[rid] = r
    out = [by_id[i] for i in order]
    out.sort(key=lambda r: (int(r.get("createdAt") or 0), r.get("id") or ""))
    return out


def _item_rank(n):
    return {
        "scheduled": 0, "deferred": 1, "cancelled": 1, "pending": 2, "snoozed": 2,
        "failed": 2, "sent": 3, "delivered": 4, "transferred": 5, "acknowledged": 6,
    }.get(n.get("status"), 0)


def _merge_notifications(server_list, client_list):
    """通知项按 id 并集；走得更远的状态胜出，操作历史按 (at,action,detail) 并集，attempts 取大。"""
    by_id = {}
    for n in list(server_list or []) + list(client_list or []):
        if not isinstance(n, dict) or not isinstance(n.get("id"), str):
            continue
        nid = n["id"]
        ex = by_id.get(nid)
        if ex is None:
            by_id[nid] = n
            continue
        win = n if _item_rank(n) > _item_rank(ex) else ex
        merged = dict(ex)
        merged.update(win)
        try:
            merged["attempts"] = max(int(ex.get("attempts") or 0), int(n.get("attempts") or 0))
        except (TypeError, ValueError):
            merged["attempts"] = ex.get("attempts", 0)
        # 物化原顺序序号取小（静音窗口结束后按原顺序发送）
        try:
            merged["seq"] = min(int(ex.get("seq") or 0), int(n.get("seq") or 0))
        except (TypeError, ValueError):
            pass
        # readyAt 取早（两方对静音顺延的一致估计）
        ra = [x for x in (ex.get("readyAt"), n.get("readyAt")) if isinstance(x, (int, float))]
        if ra:
            merged["readyAt"] = min(ra)
        hist = {}
        for h in list(ex.get("history") or []) + list(n.get("history") or []):
            if isinstance(h, dict):
                hist[f'{h.get("at")}|{h.get("action")}|{h.get("detail") or ""}'] = h
        merged["history"] = sorted(hist.values(), key=lambda h: (int(h.get("at") or 0), str(h.get("action"))))
        by_id[nid] = merged
    out = list(by_id.values())
    out.sort(key=lambda n: (int(n.get("dueAt") or 0), int(n.get("eventAt") or 0), int(n.get("level") or 0), n.get("id") or ""))
    return out


def _merge_appendonly(server_list, client_list, id_key="id", sort_key="at"):
    """批量结果 / 草稿：按稳定 id append-only 并集（同 id 字段更完整者胜出）。"""
    by_id = {}
    order = []
    for x in list(server_list or []) + list(client_list or []):
        if not isinstance(x, dict) or not isinstance(x.get(id_key), str):
            continue
        xid = x[id_key]
        ex = by_id.get(xid)
        if ex is None:
            by_id[xid] = x
            order.append(xid)
            continue
        # 同 id：results / 成功失败计数取更完整的一份（结果一旦写入不可变）
        if len(x.get("results") or []) > len(ex.get("results") or []):
            by_id[xid] = x
    out = [by_id[i] for i in order]
    out.sort(key=lambda b: (int(b.get(sort_key) or 0), b.get(id_key) or ""))
    return out


def _merge_batches(server_list, client_list):
    return _merge_appendonly(server_list, client_list, "id", "at")


def _merge_drafts(server_list, client_list):
    return _merge_appendonly(server_list, client_list, "id", "at")


def _tombstone_set(doc):
    """客户端已终结（送达/确认/转交/陈旧清理）的 outbox 条目 id。"""
    t = doc.get("notifyOutboxTombstones")
    if not isinstance(t, list):
        return set()
    return {x for x in t if isinstance(x, str)}


def _merge_outbox(server_list, client_list, tombstones=None):
    """
    发送队列按 notifyId 并集：入队时间取早、attempts 取大、下次尝试取早，保持 FIFO。
    tombstones 中是客户端已终结的 outbox 条目 id：即使服务端旧副本仍持有也必须删除，
    否则跨 rev 合并会把已送达 / 已确认项的旧队列条目复活。
    """
    dead = set(tombstones or ())
    by_notify = {}
    for o in list(server_list or []) + list(client_list or []):
        if not isinstance(o, dict) or not isinstance(o.get("notifyId"), str):
            continue
        if isinstance(o.get("id"), str) and o["id"] in dead:
            by_notify.pop(o["notifyId"], None)
            continue
        nid = o["notifyId"]
        ex = by_notify.get(nid)
        if ex is None:
            by_notify[nid] = o
            continue
        merged = dict(ex)
        merged.update(o)
        try:
            merged["attempts"] = max(int(ex.get("attempts") or 0), int(o.get("attempts") or 0))
        except (TypeError, ValueError):
            pass
        try:
            merged["seq"] = min(int(ex.get("seq") or 0), int(o.get("seq") or 0))
        except (TypeError, ValueError):
            pass
        t1, t2 = ex.get("enqueuedAt"), o.get("enqueuedAt")
        if isinstance(t1, (int, float)) and isinstance(t2, (int, float)):
            merged["enqueuedAt"] = min(t1, t2)
        nxt = [x for x in (ex.get("nextAttemptAt"), o.get("nextAttemptAt")) if isinstance(x, (int, float))]
        merged["nextAttemptAt"] = min(nxt) if nxt else (ex.get("nextAttemptAt") if ex.get("nextAttemptAt") is not None else o.get("nextAttemptAt"))
        by_notify[nid] = merged
    out = list(by_notify.values())
    out.sort(key=lambda o: (int(o.get("enqueuedAt") or 0), int(o.get("seq") or 0), o.get("id") or ""))
    return out


def _assess_notify_conflict(cur, doc):
    """
    通知中心乐观并发（与 web/js/geom/notifications.js assessServerNotifyConflict 同构）。
    - 规则被另一窗口前进 / 删除 -> notify-rule-advanced；引用会话缺失 -> notify-session-missing；
    - 通知项被另一窗口处理（状态 / 确认时间变化）-> notify-item-advanced；
    - 追加事件引用不存在的会话 -> notify-event-orphan。
    """
    base_rule_revs = doc.get("baseNotifyRuleRevs")
    base_item_revs = doc.get("baseNotifyItemRevs")
    if not isinstance(base_rule_revs, dict) and not isinstance(base_item_revs, dict):
        return None
    if not isinstance(cur, dict):
        cur = {}
    # 有效会话 = 服务端已有会话 ∪ 本次提交自带的新会话：同一次保存里新建的会话与其
    # 通知事件 / 规则是原子出现的，不能误判为孤儿引用。
    sessions = {s.get("id") for s in cur.get("reviewSessions", []) if isinstance(s, dict)}
    sessions |= {s.get("id") for s in doc.get("reviewSessions", []) or [] if isinstance(s, dict) and s.get("id")}
    server_rules = {r.get("id"): r for r in cur.get("notifyRules", []) if isinstance(r, dict)}
    server_items = {n.get("id"): n for n in cur.get("notifications", []) if isinstance(n, dict)}

    if isinstance(base_rule_revs, dict):
        for r in doc.get("notifyRules", []) or []:
            if not isinstance(r, dict) or not isinstance(r.get("id"), str):
                continue
            if r.get("sessionId") not in sessions:
                return {"reason": "notify-session-missing", "ruleId": r.get("id"), "sessionId": r.get("sessionId")}
            base = base_rule_revs.get(r.get("id"))
            if not isinstance(base, int) or isinstance(base, bool):
                continue
            try:
                client_rev = max(int(r.get("rev") or 0), int(r.get("deleteRev") or 0))
            except (TypeError, ValueError):
                continue
            if client_rev <= base:
                continue
            srv = server_rules.get(r.get("id"))
            srv_rev = 0
            if srv:
                srv_rev = max(int(srv.get("rev") or 0), int(srv.get("deleteRev") or 0) if srv.get("deleteRev") else 0)
            if srv_rev != base:
                return {"reason": "notify-rule-advanced", "ruleId": r.get("id"), "serverRev": srv_rev, "rule": srv}

    if isinstance(base_item_revs, dict):
        for n in doc.get("notifications", []) or []:
            if not isinstance(n, dict) or not isinstance(n.get("id"), str):
                continue
            base = base_item_revs.get(n.get("id"))
            if not isinstance(base, dict):
                continue
            srv = server_items.get(n.get("id"))
            if srv is None:
                if base.get("status") != "absent":
                    return {"reason": "notify-item-missing", "notifyId": n.get("id")}
                continue
            if srv.get("status") != base.get("status") or (srv.get("ackedAt") or None) != (base.get("ackedAt") or None):
                return {"reason": "notify-item-advanced", "notifyId": n.get("id"), "serverStatus": srv.get("status"), "item": srv}

    server_events = {e.get("id") for e in cur.get("notifyEvents", []) if isinstance(e, dict)}
    for e in doc.get("notifyEvents", []) or []:
        if not isinstance(e, dict) or not isinstance(e.get("id"), str):
            continue
        if e.get("id") in server_events:
            continue
        if e.get("sessionId") not in sessions:
            return {"reason": "notify-event-orphan", "eventId": e.get("id"), "sessionId": e.get("sessionId")}
    return None


def _merge_docs(server_doc, client_doc, outbox_tombstones=None):
    """跨分支并发合流。与 web/js/geom/audit.js mergeDocs 同构。"""
    evs = {e["id"]: e for e in server_doc.get("events", []) if isinstance(e, dict)}
    for e in client_doc.get("events", []):
        if isinstance(e, dict):
            evs.setdefault(e["id"], e)

    sb = {b["id"]: b for b in server_doc.get("branches", []) if isinstance(b, dict)}
    cb = {b["id"]: b for b in client_doc.get("branches", []) if isinstance(b, dict)}
    cur = client_doc.get("currentBranchId")
    out_branches = []
    for bid, b in sb.items():
        out_branches.append(cb.get(bid) if bid == cur and bid in cb else b)
    for bid, b in cb.items():
        if bid not in sb:
            out_branches.append(b)

    vs = {v["id"]: v for v in server_doc.get("versions", []) if isinstance(v, dict)}
    for v in client_doc.get("versions", []):
        if isinstance(v, dict):
            vs.setdefault(v["id"], v)

    experiments = _merge_experiments(server_doc.get("experiments", []), client_doc.get("experiments", []))
    review_sessions = _merge_review_sessions(server_doc.get("reviewSessions", []), client_doc.get("reviewSessions", []))

    # 通知中心：事件 append-only 并集；规则按 rev/墓碑；通知项远端状态胜出 + 历史并集；队列 FIFO 并集；
    # 批量结果 / 本地草稿按稳定 id append-only 并集（部分冲突失败项在刷新 / 重启后仍保留）
    notify_events = _merge_notify_events(server_doc.get("notifyEvents", []), client_doc.get("notifyEvents", []))
    notify_rules = _merge_notify_rules(server_doc.get("notifyRules", []), client_doc.get("notifyRules", []))
    notifications = _merge_notifications(server_doc.get("notifications", []), client_doc.get("notifications", []))
    notify_outbox = _merge_outbox(
        server_doc.get("notifyOutbox", []), client_doc.get("notifyOutbox", []), outbox_tombstones)
    notify_batches = _merge_batches(server_doc.get("notifyBatches", []), client_doc.get("notifyBatches", []))
    notify_drafts = _merge_drafts(server_doc.get("notifyDrafts", []), client_doc.get("notifyDrafts", []))

    merged = dict(server_doc)
    merged.update({
        "events": list(evs.values()),
        "branches": out_branches,
        "versions": list(vs.values()),
        "experiments": experiments,
        "reviewSessions": review_sessions,
        "notifyEvents": notify_events,
        "notifyRules": notify_rules,
        "notifications": notifications,
        "notifyOutbox": notify_outbox,
        "notifyBatches": notify_batches,
        "notifyDrafts": notify_drafts,
        "activeReviewId": server_doc.get("activeReviewId")
            or (client_doc.get("activeReviewId") if any(s.get("id") == client_doc.get("activeReviewId") for s in review_sessions) else None),
        "currentVersionId": server_doc.get("currentVersionId"),
        "compare": server_doc.get("compare", {"a": None, "b": None}),
        "branchCompare": server_doc.get("branchCompare", {"a": None, "b": None}),
        # 审计工作台视图状态（筛选/回放位置/前后面）：服务端为准，缺失时采用客户端
        "auditWorkbench": server_doc.get("auditWorkbench") or client_doc.get("auditWorkbench"),
        "currentBranchId": cur if cur in sb or cur in cb else server_doc.get("currentBranchId", "main"),
        "actor": client_doc.get("actor") or server_doc.get("actor", ""),
    })
    return merged


class Handler(BaseHTTPRequestHandler):
    server_version = "RectConstraints/1.0"

    def _send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path):
        if not path.is_file():
            self.send_error(404)
            return
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("content-type", CONTENT_TYPES.get(path.suffix, "application/octet-stream"))
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/doc":
            with _lock:
                doc = _load_doc()
            if doc is None:
                self._send_json(404, {"error": "no-document"})
            else:
                self._send_json(200, doc)
            return
        if path == "/healthz":
            self._send_json(200, {"ok": True})
            return
        # 静态文件（防路径穿越）
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        target = (WEB_ROOT / rel).resolve()
        if WEB_ROOT.resolve() not in target.parents and target != WEB_ROOT.resolve() / "index.html":
            self.send_error(403)
            return
        self._send_file(target)

    def do_PUT(self):
        if self.path.split("?", 1)[0] != "/api/doc":
            self.send_error(404)
            return
        length = int(self.headers.get("content-length", 0))
        if length <= 0 or length > MAX_BODY:
            self._send_json(413, {"error": "bad-size"})
            return
        raw = self.rfile.read(length)
        try:
            doc = json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._send_json(400, {"error": "bad-json"})
            return
        if not _valid_shape(doc):
            self._send_json(422, {"error": "invalid-document"})
            return
        with _lock:
            cur = _load_doc()
            cur_rev = cur.get("rev", 0) if isinstance(cur, dict) else 0
            if not isinstance(cur_rev, int) or isinstance(cur_rev, bool):
                cur_rev = 0
            # 本页已终结（送达/确认/转交/陈旧清理）的 outbox 条目：直存 / 合并都不得保留
            outbox_tombstones = _tombstone_set(doc)
            # 审阅会话乐观并发：会话 rev 前进 / 节点指纹变化 / 节点缺失 / 分支推进
            # → 409（即使文档 rev 相同、或该保存本来可以按分支合流，审阅冲突也优先拒绝）
            review_conflict = _assess_review_conflict(cur, doc)
            if review_conflict:
                self._send_json(409, {"error": "review-conflict", "rev": cur_rev, **review_conflict})
                return
            # 通知中心乐观并发：规则被前进 / 删除、通知项被另一窗口处理 → 409（本地未提交操作保留）
            notify_conflict = _assess_notify_conflict(cur, doc)
            if notify_conflict:
                self._send_json(409, {"error": "notify-conflict", "rev": cur_rev, **notify_conflict})
                return
            if doc["baseRev"] != cur_rev:
                # 文档已被其他页面前进：先判断是否可以按分支合流
                mergeable, info = _assess_conflict(cur, doc)
                if not mergeable:
                    self._send_json(409, {
                        "error": "revision-conflict",
                        "rev": cur_rev,
                        **(info or {}),
                    })
                    return
                if isinstance(cur, dict):
                    merged = _merge_docs(cur, doc, outbox_tombstones)
                    merged.pop("baseRev", None)
                    merged.pop("baseHeads", None)
                    merged.pop("baseReviewRevs", None)
                    merged.pop("baseNotifyRuleRevs", None)
                    merged.pop("baseNotifyItemRevs", None)
                    merged.pop("notifyOutboxTombstones", None)
                    merged["rev"] = cur_rev + 1
                    _save_doc(merged)
                    self._send_json(200, {"ok": True, "rev": merged["rev"], "merged": True, "doc": merged})
                    return
                # 服务端无文档（比如数据卷被清空）：按首次保存处理
                doc.pop("baseRev", None)
                doc.pop("baseHeads", None)
                doc.pop("baseReviewRevs", None)
                doc.pop("baseNotifyRuleRevs", None)
                doc.pop("baseNotifyItemRevs", None)
                doc.pop("notifyOutboxTombstones", None)
                doc["rev"] = 1
                _save_doc(doc)
                self._send_json(200, {"ok": True, "rev": 1})
                return
            # 同 rev 下再做一次分支头序号检查（防御并发到同一 rev 的极端情况）
            mergeable, info = _assess_conflict(cur, doc)
            if not mergeable:
                self._send_json(409, {"error": "revision-conflict", "rev": cur_rev, **(info or {})})
                return
            doc.pop("baseRev", None)
            doc.pop("baseHeads", None)
            doc.pop("baseReviewRevs", None)
            doc.pop("baseNotifyRuleRevs", None)
            doc.pop("baseNotifyItemRevs", None)
            doc.pop("notifyOutboxTombstones", None)
            # 直存：客户端文档即权威；仅按其墓碑兜底过滤可能残留的已终结队列条目
            if outbox_tombstones and isinstance(doc.get("notifyOutbox"), list):
                doc["notifyOutbox"] = [
                    o for o in doc["notifyOutbox"]
                    if not (isinstance(o, dict) and o.get("id") in outbox_tombstones)
                ]
            doc["rev"] = cur_rev + 1
            _save_doc(doc)
            self._send_json(200, {"ok": True, "rev": doc["rev"], "entries": len(doc.get("events", [])), "events": len(doc.get("events", []))})

    def do_POST(self):
        if self.path.split("?", 1)[0] == "/api/reset":
            with _lock:
                if DATA_PATH.exists():
                    DATA_PATH.unlink()
            self._send_json(200, {"ok": True})
            return
        self.send_error(404)

    def log_message(self, fmt, *args):
        # 简洁访问日志
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)


def main():
    DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"listening on http://{HOST}:{PORT}  data={DATA_PATH}  web={WEB_ROOT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
