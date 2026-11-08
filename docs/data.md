# 数据与模型

公开数据为官方借阅服务页的 6 个检索分块与独立校园网工具资料，保留来源 URL。目录名 `kb-v13-reviewed` 沿用格式版本，当前配置标识为 `v1.3-public-sample`。

完整 v1.3 基线为 650 文档、3,879 分块，不随仓库分发。历史全量指标不适用于公开样例覆盖率。

更新时同步替换 `documents.jsonl`、`chunks.jsonl`、`embeddings.npy`，保证向量行与分块对应，并更新校园应用的 `data/kb-active.json` 和 `config/app.config.json`。

BGE 权重首次下载到应用内 `models/`。生成服务默认 DeepSeek Flash，Gemma 本地版独立维护。权重、原始附件、日志及密钥不进入版本控制。
