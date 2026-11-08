# Evaluation

校园评测基线：105 条基础用例和 10 条等义改写。

| 目录 | 内容 |
|---|---|
| `cases/` | 问题、预期行为、事实与来源 |
| `scripts/` | 静态、检索、工具、生成、端到端评测 |
| `reports/` | 历史版本结果 |
| `docs/` | 评分规则与问题分析 |

历史报告针对 v1.2/v1.3 全量数据。公开样例无法复现全量指标。部分资料准备脚本保留历史环境默认值，运行前用参数指定本地数据路径，见 [脚本说明](scripts/README.md)。

已归档测试覆盖静态检查、检索与工具层；真实模型生成评测尚未完成。AI 辅助检查与人工签字分别记录。

工具层复测（仓库根目录）：

```sh
python evaluation/scripts/tool_eval.py --cases evaluation/cases/cases.jsonl --tool-js apps/campus/trade-tools.js --run-dir evaluation/runs/tools --node node
```

历史快照见 [BASELINE-v0.1.md](BASELINE-v0.1.md)。
