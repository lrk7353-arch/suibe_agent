> 历史评测基线：结果对应当时的 v1.2 / v1.3 全量数据，不代表本仓库公开样例或 API 版已验收。部分脚本默认路径来自原开发机；运行时请用命令行参数指定本地数据。

# 回答正确性验收基线 v0.1

本目录是“上经贸大小贸校园智能体”回答正确性验收的独立工作区。它不修改、不启动、不停止 `delivery/` 下的交付代码与服务。

## 先看什么

1. **基线冻结快照**：`BASELINE-v0.1.md`（先看这个）
2. **规范**：`正确性验收规范-v1.0.md`
3. **本轮报告**：`reports/验收报告-v1.0-20261108.md`
4. **问题清单**：`docs/问题清单.md`
5. **知识缺口**：`docs/待核验资料与知识缺口.md`
6. **测试集**：`cases/cases.jsonl`（105 基础 + 10 改写）
7. **标准答案与证据**：`cases/标准答案与证据表.csv`
8. **脚本说明**：`scripts/README.md`
9. **版本基线**：`reports/baseline/基线版本记录.md`

## 本轮结论（一句话）

验收标准、115 条用例、标准答案与证据表、检索/工具/静态评测脚本已建立；工具层 11/11 通过，但 v1.2 知识库缺少 2026-2027 高频事实（60/105 静态缺口），检索严格引文召回仅 63.6%/42.3%，且交付模型未启动，生成/端到端未测试。**不能判定交付版本通过回答正确性验收。**

## 目录

```text
answer-acceptance-v1/
  README.md
  正确性验收规范-v1.0.md
  cases/
    cases.jsonl
    cases-review.csv
    标准答案与证据表.csv
    cases-stats.json
  docs/
    待核验资料与知识缺口.md
    问题清单.md
    验收报告模板.md
  reports/
    baseline/
    验收报告-v1.0-20261108.md
    static-validation/
    coverage/
  runs/
    run-20261108-v1/
  scripts/
  sources/
```

## 复现（最小）

```bash
cd experiments/answer-acceptance-v1

# 1. 静态校验
python -I scripts/validate_cases.py --cases cases/cases.jsonl --out reports/static-validation/validation.json

# 2. 检索层（CPU，不占服务端口）
PY=Z:/home/konglingrui/suibeagent/delivery/dist/xiaomao-suite-v1.2.0/runtime/python/python.exe
$PY -I scripts/retrieve_eval.py --kb v12 --cases cases/cases.jsonl --run-dir runs/run-20261108-v1 --k 8
$PY -I scripts/retrieve_eval.py --kb v13 --cases cases/cases.jsonl --run-dir runs/run-20261108-v1 --k 8

# 3. 工具层
python -I scripts/tool_eval.py --cases cases/cases.jsonl --run-dir runs/run-20261108-v1
```

## 边界

- 不修改 `delivery/src`、`delivery/dist`。
- 不终止/重启交付方进程；本轮 18766/18767/18768 未监听，18765 的 Qwen3 不是交付模型。
- v1.3 未交付、未加载，只用于检索对照；不能把 v1.3 的结果写成“线上已支持”。
- 生成/端到端需交付方启动 Gemma 4 后复跑；脚本已提供，本轮未执行。
- 所有“零例”只代表本次样本范围；生成层未跑，不能宣称“关键政策捏造零例”。

## 下一轮建议

1. 接入 v1.3 的 2026-2027 收费/奖助/生活/办事文档，先修元数据（标题-正文、`applies_to`、`collection`、附件正文）。
2. 修检索排序：最新学年、新生/老生、研究生、辅修、外校硬过滤或加权；把权威文档送进前 8。
3. 启动交付 Gemma 4，跑 `generation_eval.py` 与 `e2e_eval.py`，补 P95、超时、回退、UI 引用。
4. 人工复核所有 critical 用例，签字后再把 `review_status` 改为“已人工复核”。
5. 建立保留测试集，20 条核心用例重复 3 次，保留所有失败。
