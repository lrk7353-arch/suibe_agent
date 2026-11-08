# Campus

Node.js 网页服务 + Python 检索服务 + DeepSeek Flash。

## 环境

Node.js 24、Python 3.14；依赖见 `requirements.txt`。以下命令在本目录执行。

```sh
python -m venv .venv
# 激活环境后：
python -m pip install -r requirements.txt
python -c "from huggingface_hub import snapshot_download; snapshot_download(repo_id='BAAI/bge-small-zh-v1.5', local_dir='models/bge-small-zh-v1.5')"
```

Linux/macOS 使用 `source .venv/bin/activate`；Windows PowerShell 使用 `.venv\Scripts\Activate.ps1`。下载前可将 `HF_HOME`、`PIP_CACHE_DIR`、`TEMP`、`TMP` 指向项目内缓存目录。

## 启动

在启动 Node 服务的终端配置 `DEEPSEEK_API_KEY`。`.env.example` 是变量说明，不会自动加载。

```sh
# 终端一，已激活 Python 环境
python -B rag-service.py
# 终端二
node assistant.cjs
```

网页 `http://127.0.0.1:18866`；检索端口 `18867`。Ctrl+C 停止服务。

## 配置与代码

| 入口 | 用途 |
|---|---|
| `config/app.config.json` | 端口、知识库数量、模型配置 |
| `data/kb-active.json` | 数据目录与版本 |
| `assistant.cjs` | HTTP 与会话入口 |
| `campus-tools.cjs` | 固定服务流程 |
| `rag.cjs` / `providers.cjs` | 检索编排与生成接口 |
| `rag-service.py` | 检索 HTTP 服务 |
| `kb_store.py` / `retrieval.py` | 候选检索与排序 |

公开数据为服务页样例。`/health` 检查检索就绪和密钥配置；远程 API 可用性由实际请求验证。真实 API 端到端评测尚未完成。
