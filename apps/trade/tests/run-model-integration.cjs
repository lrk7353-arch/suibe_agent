'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { handleTurn } = require('../src/engine/engine.cjs');
const { createState } = require('../src/engine/state.cjs');
const { fromEnv } = require('../src/engine/model-adapter.cjs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'runs', 'latest-model-integration.json');
const TURNS = [
  '帮我算一下这批进口商品的成本。',
  '100 件，每件 10 美元，FOB。',
  '运费 100 美元、保险 10 美元，汇率 7，关税 10%，增值税 13%。',
  '如果汇率涨到 7.2 呢？',
  '另一个供应商报 CIF 总价 1,080 美元，其他条件一样，哪个支出更低？',
  '把两种方案整理成一份摘要。'
];

async function main() {
  const model = fromEnv();
  const base = {
    generator: 'trade-demo-v1/run-model-integration.cjs',
    generatedAt: new Date().toISOString(),
    tier: 'model_integrated',
    turns: TURNS
  };
  if (!model) {
    const report = {
      ...base,
      status: 'NOT_RUN',
      reason: '未设置 TRADE_DEMO_MODEL_URL；本轮按协作边界使用模拟模型响应，未接入真实模型。',
      howToRun: [
        '设置 TRADE_DEMO_MODEL_URL（OpenAI 兼容的 /v1 基址）与 TRADE_DEMO_MODEL（模型名），可选 TRADE_DEMO_MODEL_KEY。',
        '运行 node tests/run-model-integration.cjs；结果写入 runs/latest-model-integration.json。',
        '真实模型只提交参数提案；金额仍由 calculate_import_outlay 计算，提案不合法时程序拒绝执行。'
      ],
      note: '该层级不能由工具与状态流程测试替代；接入模型后需重新运行本脚本并单独报告。'
    };
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
    console.log('model integration: NOT_RUN（未配置模型地址）');
    return;
  }
  let state = createState();
  const records = [];
  let failed = null;
  for (let i = 0; i < TURNS.length; i += 1) {
    const t0 = process.hrtime.bigint();
    const res = await handleTurn({ text: TURNS[i], state, sessionId: 'model-integration', model });
    const durationMs = Number(process.hrtime.bigint() - t0) / 1e6;
    state = res.state;
    records.push({
      turn: i + 1,
      text: TURNS[i],
      phase: res.phase,
      answer: res.answer,
      error: res.error?.code || null,
      stateVersion: state.version,
      outlay: res.cards?.result?.amounts?.outlay?.value || null,
      sensitivity: res.cards?.sensitivity?.points?.find(p => !p.isBaseline)?.outlay || null,
      comparison: res.cards?.comparison?.ok ? { cheaper: res.cards.comparison.cheaper?.id, diff: res.cards.comparison.differences?.[0]?.diffFromBaseline } : null,
      export: res.cards?.export?.primary?.filename || null,
      durationMs: Math.round(durationMs * 1000) / 1000
    });
    if (res.error?.code === 'model_unavailable') { failed = `第 ${i + 1} 轮模型不可用`; break; }
  }
  const expected = [null, null, '9658.11', '9658.11', '9397.08', '9397.08'];
  const checks = records.map((r, i) => {
    if (i === 2) return { turn: 3, name: 'outlay', pass: r.outlay === expected[2], detail: r.outlay };
    if (i === 4) return { turn: 5, name: 'outlay', pass: r.outlay === expected[4], detail: r.outlay };
    if (i === 3) return { turn: 4, name: 'sensitivity', pass: r.sensitivity === '9934.06', detail: r.sensitivity };
    if (i === 5) return { turn: 6, name: 'export', pass: Boolean(r.export), detail: r.export };
    return { turn: i + 1, name: 'phase', pass: i < 2 ? r.phase === 'collecting' : true, detail: r.phase };
  });
  const failedChecks = checks.filter(c => !c.pass);
  const report = {
    ...base,
    model: { name: model.name, mode: model.mode, endpoint: model.endpoint },
    status: failed || failedChecks.length ? 'FAIL' : 'PASS',
    checks: { total: checks.length, passed: checks.length - failedChecks.length, failed: failedChecks.length },
    failedChecks,
    records,
    note: '真实模型负责理解与参数提案；金额与状态由程序计算。该结果不能替代工具与状态流程测试。'
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
  console.log(`model integration: ${report.status} (${report.checks.passed}/${report.checks.total})`);
  if (report.status === 'FAIL') process.exitCode = 1;
}

main().catch(err => {
  const report = {
    generator: 'trade-demo-v1/run-model-integration.cjs',
    generatedAt: new Date().toISOString(),
    tier: 'model_integrated',
    status: 'FAIL',
    error: String(err.message || err)
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
  console.error(err.stack || err.message);
  process.exit(1);
});
