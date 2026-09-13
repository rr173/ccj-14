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


def _merge_docs(server_doc, client_doc):
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

    merged = dict(server_doc)
    merged.update({
        "events": list(evs.values()),
        "branches": out_branches,
        "versions": list(vs.values()),
        "experiments": experiments,
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
                    merged = _merge_docs(cur, doc)
                    merged.pop("baseRev", None)
                    merged.pop("baseHeads", None)
                    merged["rev"] = cur_rev + 1
                    _save_doc(merged)
                    self._send_json(200, {"ok": True, "rev": merged["rev"], "merged": True, "doc": merged})
                    return
                # 服务端无文档（比如数据卷被清空）：按首次保存处理
                doc.pop("baseRev", None)
                doc.pop("baseHeads", None)
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
