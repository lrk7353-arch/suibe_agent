# Trade

进口成本教学应用，解析、会话状态、计算和导出分别实现。

仓库根目录运行 `npm run dev:trade`，访问 `http://127.0.0.1:18870`。默认规则解析。

## 模型参数提案

| 环境变量 | 含义 |
|---|---|
| `TRADE_DEMO_MODEL_URL` | 基础地址，如 `https://api.deepseek.com` |
| `TRADE_DEMO_MODEL` | 模型标识，如 `deepseek-flash` |
| `TRADE_DEMO_MODEL_KEY` | 服务端密钥 |
| `TRADE_DEMO_MODEL_TIMEOUT_MS` | 超时，默认 30000 ms |

模型提交意图与参数，程序校验后计算。真实模型层和规则层独立评测。

## 引擎

`src/engine/` 中：`parser.cjs` 规则解析；`model-adapter.cjs` 模型适配；`engine.cjs` 流程编排；`state.cjs` 方案状态；`tools.cjs` 校验与计算；`decimal.cjs` 十进制运算；`summarize.cjs` 摘要导出。

## 测试

运行 `npm run test:trade`。独立参考计算为 `tests/reference_calc.py`，结果写入忽略目录 `runs/`。`evidence/` 保存历史报告，`samples/` 提供导出示例。
