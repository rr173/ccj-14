#!/usr/bin/env python3
"""
矩形约束编辑器 —— 静态文件 + 单文档 JSON 持久化（含布局版本与乐观并发）。
仅使用 Python 标准库（http.server / threading），便于极小镜像部署。

  GET  /                 -> web/index.html
  GET  /api/doc          -> 当前文档（含 undo/redo 历史、布局版本、rev）
  PUT  /api/doc          -> 整体覆盖保存（原子写 + 结构校验 + baseRev 乐观并发检查）
  POST /api/reset        -> 删除服务端存档（客户端随后会重建）

乐观并发：文档带单调递增的 rev。客户端保存时必须携带自己基于的 baseRev；
与服务器当前 rev 不一致说明另一个页面已经保存过，返回 409 并拒绝覆盖，
由客户端提示“版本冲突，请重新加载”。

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
    """轻量结构校验，重活在浏览器求解器里。"""
    if not isinstance(doc, dict):
        return False
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
    # 乐观并发：客户端必须声明自己基于的服务端版本号
    if not isinstance(doc.get("baseRev"), int) or isinstance(doc.get("baseRev"), bool) or doc["baseRev"] < 0:
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
    return True


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
                # 旧页面提交：服务端已有更新的内容，拒绝覆盖，告知当前版本号
                self._send_json(409, {"error": "revision-conflict", "rev": cur_rev})
                return
            doc.pop("baseRev", None)
            doc["rev"] = cur_rev + 1
            _save_doc(doc)
            self._send_json(200, {"ok": True, "rev": doc["rev"], "entries": len(doc["entries"]), "idx": doc["idx"]})

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
