# 小贸：DeepSeek API 交付版

Node.js 24 + Python 检索服务；无需本地生成模型或 GPU。模型参数为 deepseek-flash，密钥只通过服务端 DEEPSEEK_API_KEY 环境变量读取。

本版保留 v1.3 知识库的本地向量检索，因此首次准备时仍需 BAAI/bge-small-zh-v1.5 小型嵌入模型。它不放进 GitHub。生成模型 Gemma 是可选离线版本，当前目录不包含它。

## 准备与启动
在非 C 盘项目目录准备 Node 24 和 Python。先将 TEMP、TMP、HF_HOME、PIP_CACHE_DIR 指向项目 tmp 子目录，再创建项目内 .venv 并安装 requirements.txt。使用 huggingface_hub.snapshot_download(repo_id="BAAI/bge-small-zh-v1.5",local_dir="models/bge-small-zh-v1.5") 准备检索模型。

设置 DEEPSEEK_API_KEY 环境变量后，在两个终端分别运行 `python -B rag-service.py` 与 `node assistant.cjs`，访问 http://127.0.0.1:18866/ 。端口独立，不与原交付测试冲突。停止时在相应终端 Ctrl+C。

首次下载后，本地检索无需联网；DeepSeek 生成需要联网。用户问题及检索片段会发送给 DeepSeek。未提供密钥时不宣称 API 可用。/health 仅检查密钥是否配置及检索服务状态，不代表远程 API 调用成功。

## 交付状态
这是独立 API 候选版；真实 API 计费调用尚待本地密钥配置后验证。演示流程与正确性验收仍在其他目录开发，本版未合入其未完成成果。数据正确率不得引用旧版运行测试冒充。

## GitHub 与模型
代码与必要知识库数据可作为源码交付。发布前复核知识库公开范围；不提交密钥、运行日志、原始学生名单、大模型和运行环境。无需重新上传他人模型：离线版本使用原 Hugging Face 仓库的固定 revision 与 SHA256（见完整包下载清单）。
