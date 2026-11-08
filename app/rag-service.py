"""Project-local, offline retrieval service. No network access is required."""
import json
import os
import sys
import threading
import time
import traceback
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    # The bundled embeddable Python uses a ._pth file and does not add the
    # script directory to sys.path automatically.
    sys.path.insert(0, str(ROOT))


def load_app_config():
    path = Path(os.environ.get("XIAOMAO_CONFIG", ROOT / "config/app.config.json"))
    with path.open(encoding="utf8") as handle:
        return json.loads(handle.read())


APP = load_app_config()
HOST = os.environ.get("XIAOMAO_HOST", APP.get("host", "127.0.0.1"))
PORT = int(os.environ.get("XIAOMAO_PORT_RAG", APP["ports"]["rag"]))
KB_VERSION = APP["kb"]["version"]
EXPECTED_CHUNKS = int(APP["kb"]["chunks"])
EXPECTED_DIM = int(APP["kb"].get("dim", 512))

os.environ.update(
    HF_HUB_OFFLINE="1",
    TRANSFORMERS_OFFLINE="1",
    HF_HOME=str(ROOT / "tmp/huggingface"),
    TOKENIZERS_PARALLELISM="false",
    PYTHONDONTWRITEBYTECODE="1",
)

from kb_store import Store  # noqa: E402
from rag_embedding import load_model, model_path  # noqa: E402
from retrieval import retrieve  # noqa: E402

STARTED = time.time()
_model_lock = threading.Lock()
model = load_model()
store = Store()

if len(store) != EXPECTED_CHUNKS:
    raise RuntimeError(
        "knowledge base chunk count %d does not match config %d; run doctor"
        % (len(store), EXPECTED_CHUNKS)
    )
if store.emb.shape[1] != EXPECTED_DIM:
    raise RuntimeError(
        "embedding dimension %d does not match config %d"
        % (store.emb.shape[1], EXPECTED_DIM)
    )


def summary():
    return {
        "status": "ok",
        "ready": True,
        "service": "rag",
        "version": KB_VERSION,
        "chunks": len(store),
        "dim": int(store.emb.shape[1]),
        "documents": len({c.get("doc_id") for c in store.chunks}),
        "collections": dict(Counter(c["collection"] for c in store.chunks)),
        "embedding": model_path().name,
        "pid": os.getpid(),
        "uptimeSec": round(time.time() - STARTED, 1),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "xiaomao-rag/1.0"

    def log_message(self, fmt, *args):
        print(json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%S"), "event": "http", "client": self.client_address[0], "message": fmt % args}, ensure_ascii=False), file=sys.stderr, flush=True)

    def _send(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ("/health", "/"):
            return self._send(200, summary())
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        started = time.time()
        try:
            length = int(self.headers.get("Content-Length", 0))
            if not 0 < length <= 8192:
                raise ValueError("invalid body size")
            data = json.loads(self.rfile.read(length))
            question = data.get("question")
            if not isinstance(question, str) or not 0 < len(question) <= 700:
                raise ValueError("invalid question")
            with _model_lock:
                hits = retrieve(question, model, store)
            elapsed = round((time.time() - started) * 1000)
            print(json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%S"), "event": "retrieve", "chars": len(question), "hits": len(hits), "ms": elapsed}, ensure_ascii=False), file=sys.stderr, flush=True)
            return self._send(200, {"hits": hits})
        except Exception as error:
            print(json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%S"), "event": "retrieve_failed", "error": type(error).__name__}, ensure_ascii=False), file=sys.stderr, flush=True)
            traceback.print_exc(file=sys.stderr)
            return self._send(400, {"error": "Retrieval failed"})


def main():
    print(json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%S"), "event": "rag_ready", **summary()}, ensure_ascii=False), file=sys.stderr, flush=True)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
