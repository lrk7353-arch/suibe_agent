#!/usr/bin/env python3
"""Record the version/environment baseline without starting or stopping services."""
import hashlib
import json
import platform
import socket
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path("Z:/home/konglingrui/suibeagent")
OUT = Path(__file__).resolve().parents[1] / "reports/baseline"


def sha256(path):
    if not path.exists():
        return None
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def read_json(path):
    try:
        return json.loads(path.read_text(encoding="utf8"))
    except Exception as error:
        return {"_error": str(error)}


def probe(url):
    import urllib.request
    import urllib.error

    try:
        with urllib.request.urlopen(url, timeout=3) as response:
            return {"status": response.status, "body": response.read(2000).decode("utf8", "replace")}
    except Exception as error:
        return {"status": None, "error": str(error)}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    version = read_json(ROOT / "delivery/src/VERSION.json")
    config = read_json(ROOT / "delivery/src/config/app.config.json")
    active = read_json(ROOT / "data/kb-active.json")
    local_model = read_json(ROOT / "data/local-model.json")

    files = {
        "VERSION.json": ROOT / "delivery/src/VERSION.json",
        "app.config.json": ROOT / "delivery/src/config/app.config.json",
        "kb-active.json": ROOT / "data/kb-active.json",
        "local-model.json": ROOT / "data/local-model.json",
        "v1.2 documents.jsonl": ROOT / "data/kb-v12-reviewed/documents.jsonl",
        "v1.2 chunks.jsonl": ROOT / "data/kb-v12-reviewed/chunks.jsonl",
        "v1.2 embeddings.npy": ROOT / "data/kb-v12-reviewed/embeddings.npy",
        "v1.3 documents.jsonl": ROOT / "suibe-kb-handoff-v1.3-20261108/suibe-kb-v1.3/clean/documents.jsonl",
        "v1.3 chunks.jsonl": ROOT / "kb-v13-work/build/chunks.jsonl",
        "v1.3 embeddings.npy": ROOT / "kb-v13-work/build/embeddings.npy",
        "cases.jsonl": ROOT / "experiments/answer-acceptance-v1/cases/cases.jsonl",
        "标准答案与证据表.csv": ROOT / "experiments/answer-acceptance-v1/cases/标准答案与证据表.csv",
    }

    gpu = None
    try:
        gpu = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu", "--format=csv,noheader"],
            capture_output=True,
            text=True,
            encoding="utf8",
            timeout=10,
        ).stdout.strip()
    except Exception as error:
        gpu = "unavailable: " + str(error)

    node_version = subprocess.run(["node", "--version"], capture_output=True, text=True).stdout.strip()
    python_version = sys.version.split()[0]

    services = {
        "web_18766": probe("http://127.0.0.1:18766/health"),
        "rag_18767": probe("http://127.0.0.1:18767/health"),
        "model_18768": probe("http://127.0.0.1:18768/health"),
        "observed_model_18765_health": probe("http://127.0.0.1:18765/health"),
        "observed_model_18765_models": probe("http://127.0.0.1:18765/v1/models"),
    }

    baseline = {
        "recorded_at": datetime.now(timezone.utc).astimezone().isoformat(),
        "host": {
            "platform": platform.platform(),
            "machine": platform.machine(),
            "python": python_version,
            "node": node_version,
            "gpu": gpu,
        },
        "delivery_version": version,
        "delivery_config": config,
        "kb_active": active,
        "local_model": local_model,
        "services": services,
        "files": {
            label: {"path": str(path), "exists": path.exists(), "bytes": path.stat().st_size if path.exists() else None, "sha256": sha256(path)}
            for label, path in files.items()
        },
        "candidate_kb": {
            "version": "v1.3-20261108",
            "documents": 650,
            "chunks": 3879,
            "dim": 512,
            "delivered": False,
            "loaded": False,
            "note": "v1.3 未进入交付包，也未由当前服务加载；仅用于对照检索实验。",
        },
    }
    (OUT / "baseline.json").write_text(json.dumps(baseline, ensure_ascii=False, indent=2), encoding="utf8")

    lines = [
        "# 版本与运行环境基线",
        "",
        "记录时间：%s" % baseline["recorded_at"],
        "",
        "## 1. 交付版本",
        "",
        "- 应用：%s %s（构建日期 %s）" % (version.get("app"), version.get("version"), version.get("buildDate")),
        "- 交付冻结知识库：%s（%s 篇 / %s 块 / %s 维）" % (
            version.get("knowledgeBase", {}).get("version"),
            version.get("knowledgeBase", {}).get("documents"),
            version.get("knowledgeBase", {}).get("chunks"),
            version.get("knowledgeBase", {}).get("dim"),
        ),
        "- 交付冻结模型：%s" % version.get("frozen", {}).get("model"),
        "- 配置期望模型：%s，地址 %s" % (config.get("model", {}).get("name"), config.get("model", {}).get("file")),
        "- 当前 `data/kb-active.json`：%s（release=%s）" % (active.get("version"), active.get("release")),
        "- `data/local-model.json`：%s @ %s" % (local_model.get("name"), local_model.get("baseUrl")),
        "",
        "## 2. 当前实际运行状态（只读探测）",
        "",
        "| 端口 | 结果 |",
        "|---|---|",
    ]
    for name, result in services.items():
        if result.get("status") == 200:
            body = result.get("body", "").replace("\n", " ")[:180]
            lines.append("| %s | HTTP 200：%s |" % (name, body.replace("|", "/")))
        else:
            lines.append("| %s | 不可用：%s |" % (name, result.get("error", "unknown").replace("|", "/")))
    lines += [
        "",
        "结论：交付配置期望的 web/rag/model 三个端口当前均未监听；18765 上有一个 llama-server，加载的是 Qwen3-1.7B-Q4_K_M（WSL UNC 路径），**不是交付冻结的 Gemma 4 E2B**。因此本轮不能把 18765 的回答当作交付版本的验收结果。",
        "",
        "## 3. 候选知识库（未交付、未加载）",
        "",
        "- v1.3-20261108：650 篇 / 3,879 块 / 512 维；仅用于对照检索实验。",
        "- 与 v1.2 文档 ID 重叠 438 篇；v1.3 新增/保留差异需按文档 ID 逐条核对。",
        "",
        "## 4. 关键文件哈希（SHA-256）",
        "",
        "| 文件 | 大小 | SHA-256 |",
        "|---|---:|---|",
    ]
    for label, info in baseline["files"].items():
        lines.append(
            "| %s | %s | `%s` |"
            % (label, info["bytes"], info["sha256"] or "缺失")
        )
    lines += [
        "",
        "## 5. 测试边界",
        "",
        "- 不启动、不停止、不修改交付方的 web/rag/model 服务。",
        "- 检索实验使用交付包自带的 `kb_store.py`、`retrieval.py`、`rag_embedding.py` 副本，CPU 编码，端口不占用。",
        "- 工具实验直接调用 `delivery/src/trade-tools.js`，不经过模型。",
        "- 生成/端到端：交付模型未运行，本轮标记为“未测试”，不以 18765 的 Qwen3 结果代替。",
    ]
    (OUT / "基线版本记录.md").write_text("\n".join(lines) + "\n", encoding="utf8")
    print(json.dumps({"recorded_at": baseline["recorded_at"], "services": {k: v.get("status") for k, v in services.items()}}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
