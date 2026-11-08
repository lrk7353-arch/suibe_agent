# 评测脚本使用说明

## 目录

```text
scripts/
  build_cases.py        # 从 cases_*.py 生成 cases.jsonl / CSV
  cases_common.py       # 用例构建与来源解析
  cases_a_b.py          # A 高频事实 + B 办事流程
  cases_c_d.py          # C 歧义多轮 + D 时效范围
  cases_e_f_p.py        # E 缺失干扰 + F 经贸工具 + P 改写定义
  validate_cases.py     # 静态校验（字段/分类/来源/引文/改写）
  retrieve_eval.py      # 检索层评测（复用交付 Store/retrieval）
  tool_eval.py          # 工具层评测（直接调用交付 trade-tools.js）
  tool_runner.cjs       # Node 工具调用包装
  generation_eval.py    # 生成层评测（证据注入，需模型服务）
  e2e_eval.py           # 端到端 /ask 评测（需 web 服务）
  score_eval.py         # 规则初评分（自动初评，非人工结论）
  compare_runs.py       # 两次运行逐 case 对比
  coverage_report.py    # 版本覆盖表
  record_baseline.py    # 版本/环境/哈希基线
  harness/              # 交付检索代码的只读副本 + 可切换 kb-active.json
```

## 0. 环境

- Python：交付便携 Python 或项目 `.venv-rag`，需 `numpy`、`sentence_transformers`。
- Node：用于工具层，需能 `require` 交付 `trade-tools.js`。
- 不启动、不停止、不修改交付服务；检索层用 CPU 编码，不占端口。

## 1. 重新生成用例

```bash
cd experiments/answer-acceptance-v1/scripts
python build_cases.py
```

输出：

- `cases/cases.jsonl`
- `cases/cases-review.csv`
- `cases/标准答案与证据表.csv`
- `cases/cases-stats.json`

## 2. 静态校验

```bash
cd experiments/answer-acceptance-v1
python -I scripts/validate_cases.py \
  --cases cases/cases.jsonl \
  --out reports/static-validation/validation.json
```

退出码 0 表示无错误；警告会列出“某条引文在某个知识库中找不到”。本轮的引文都用全文档正文核对，不依赖检索片段。

## 3. 检索层

```bash
cd experiments/answer-acceptance-v1
PY=Z:/home/konglingrui/suibeagent/delivery/dist/xiaomao-suite-v1.2.0/runtime/python/python.exe

$PY -I scripts/retrieve_eval.py --kb v12 --cases cases/cases.jsonl --run-dir runs/<id> --k 8
$PY -I scripts/retrieve_eval.py --kb v13 --cases cases/cases.jsonl --run-dir runs/<id> --k 8
```

- `--kb v12`：交付/当前配置的 v1.2 索引。
- `--kb v13`：候选 v1.3 索引（未交付、未加载）。
- `--k`：报告必须写明；默认 8，与应用实际返回条数一致。
- `--case` / `--category` / `--limit`：单条、分类、限量运行。

输出：

- `raw-retrieval-v12.jsonl` / `raw-retrieval-v13.jsonl`：逐条 top docs、标题、分数、引文命中、耗时。
- `summary-retrieval-v12.json/csv/md`。
- 失败表可用 `retrieval-failures-*.csv` 生成脚本（见报告）。

指标口径：

- `doc_any_at_k`：任一预期文档进前 K。
- `doc_all_at_k`：全部预期文档进前 K（严格）。
- `quote_all_at_k`：全部标准引文在前 K 证据文本中逐字出现。
- `key_phrase_any_at_k`：至少一个关键值出现。
- `cross_campus_contamination_cases`：前 K 含 `cross_campus` 的用例数。

## 4. 工具层

```bash
python -I scripts/tool_eval.py --cases cases/cases.jsonl --run-dir runs/<id>
```

直接调用 `delivery/src/trade-tools.js`，不经过模型。校验：

- 有效参数 → 结果在容差内；
- 缺参/负值/税率 >100 → 预期错误；
- `invalid_args` → 预期错误。

## 5. 生成层（需交付模型）

```bash
python -I scripts/generation_eval.py \
  --cases cases/cases.jsonl \
  --endpoint http://127.0.0.1:18768 \
  --run-dir runs/<id>
```

- 默认按 v1.3 的标准来源注入证据；只用于“模型看到正确证据时是否答对”。
- 先确认 `/v1/models` 返回的是交付冻结模型，不要把 Qwen3/其他模型的结果当交付验收。
- `--dry-run` 只构造 prompt，不调用模型；用于检查证据拼接。
- 规则检查只做初筛；关键事实、否决项需人工复核。

## 6. 端到端（需 web/rag/model）

```bash
python -I scripts/e2e_eval.py \
  --cases cases/cases.jsonl \
  --base-url http://127.0.0.1:18766 \
  --run-dir runs/<id>
```

- 先做 `/health`；web 不可用时写 `e2e-blocked.json` 并以退出码 2 结束。
- 不自动启动服务；不把其他端口/模型当交付版本。
- 记录原始请求、响应、来源、耗时；多轮用 `context.ragQuestion` 传递。

## 7. 评分与对比

```bash
# 规则初评（自动，不是最终结论）
python -I scripts/score_eval.py --raw runs/<id>/raw-e2e.jsonl --out runs/<id>/scored.jsonl

# 两次运行逐 case 对比
python -I scripts/compare_runs.py \
  --a runs/<id>/raw-retrieval-v12.jsonl \
  --b runs/<id>/raw-retrieval-v13.jsonl \
  --field doc_any_at_k --label-a v1.2 --label-b v1.3 \
  --out runs/<id>/compare.csv
```

## 8. 版本切换

检索层的 `harness/data/kb-active.json` 由 `retrieve_eval.py` 自动写入，不要手工改交付目录。切换知识库必须：

1. 更新 `KB_CONFIG` 的 release 路径；
2. 重跑静态覆盖 + 检索 + 生成/端到端；
3. 重新冻结版本号与哈希；
4. 报告中分开列分子分母，不得混算。

## 9. 注意

- `harness/` 是交付代码的副本，只用于评测；不要修改 `delivery/src`。
- 工具层直接 `require` 交付 `trade-tools.js`，不要复制一份改逻辑，否则测的不是交付实现。
- 生成层/端到端的规则判定不能替代人工复核；报告必须标注“自动初评”。
