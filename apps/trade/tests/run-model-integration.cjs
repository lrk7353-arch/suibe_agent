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
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
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
      reason: '未配置模型连接；本次未执行真实 API 测试。',
      howToRun: [
        '设置 DEEPSEEK_API_KEY；或设置 TRADE_DEMO_MODEL_URL、TRADE_DEMO_MODEL 与 TRADE_DEMO_MODEL_KEY。',
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
      errorDetail: res.error || null,
      stateVersion: state.version,
      outlay: res.cards?.result?.amounts?.outlay?.value || null,
      sensitivity: res.cards?.sensitivity?.points?.find(p => !p.isBaseline)?.outlay || null,
      comparison: res.cards?.comparison?.ok ? { cheaper: res.cards.comparison.cheaper?.id, diff: res.cards.comparison.differences?.[0]?.diffFromBaseline } : null,
      export: res.cards?.export?.primary?.filename || null,
      durationMs: Math.round(durationMs * 1000) / 1000
    });
    if (res.error?.code === 'model_unavailable') {
      failed = `第 ${i + 1} 轮模型不可用：${res.error.message || 'unknown'}`;
      break;
    }
  }

  let state2 = createState();
  const modifyRecords = [];
  let modifyFailed = null;
  const MODIFY_TURNS = [
    '帮我算一下这批进口商品的成本。100 件，每件 10 美元，FOB，运费 100 美元，保险 10 美元，汇率 7，关税 10%，增值税 13%。',
    '如果汇率涨到 7.2 呢？',
    '把汇率改成 7.2',
    '另一个供应商报 CIF 总价 1,080 美元，其他条件一样，哪个支出更低？'
  ];
  for (let i = 0; i < MODIFY_TURNS.length; i += 1) {
    const res = await handleTurn({ text: MODIFY_TURNS[i], state: state2, sessionId: 'model-modify-check', model });
    state2 = res.state;
    modifyRecords.push({
      turn: i + 1,
      text: MODIFY_TURNS[i],
      phase: res.phase,
      answer: res.answer,
      error: res.error?.code || null,
      outlay: res.cards?.result?.amounts?.outlay?.value || null,
      sensitivity: res.cards?.sensitivity?.points?.find(p => !p.isBaseline)?.outlay || null,
      comparison: res.cards?.comparison?.ok ? { cheaper: res.cards.comparison.cheaper?.id, diff: res.cards.comparison.differences?.[0]?.diffFromBaseline } : null,
      scenarios: state2.scenarios.map(x => ({ id: x.id, priceTerm: x.priceTerm, fx: x.input.fx, freight: x.input.freight, insurance: x.input.insurance, totalPrice: x.input.totalPrice }))
    });
    if (res.error?.code === 'model_unavailable') { modifyFailed = `对照流程第 ${i + 1} 轮模型不可用：${res.error.message || 'unknown'}`; break; }
  }
  const scAt = (record, id, key) => record?.scenarios?.find(x => x.id === id)?.[key];
  const fxEq = (actual, expected) => { try { return Number(actual) === Number(expected); } catch { return false; } };
  const modifyChecks = modifyRecords.length === 4 ? [
    { name: 'hypothetical.baseOutlay', pass: modifyRecords[0].outlay === '9658.11' && fxEq(scAt(modifyRecords[0], 'A', 'fx'), 7), detail: `${modifyRecords[0].outlay} / ${scAt(modifyRecords[0], 'A', 'fx')}` },
    { name: 'hypothetical.keepsBase', pass: modifyRecords[1].outlay === '9658.11' && fxEq(scAt(modifyRecords[1], 'A', 'fx'), 7) && modifyRecords[1].sensitivity === '9934.06', detail: `${modifyRecords[1].outlay} / ${scAt(modifyRecords[1], 'A', 'fx')} / ${modifyRecords[1].sensitivity}` },
    { name: 'commit.changesBase', pass: modifyRecords[2].outlay === '9934.06' && fxEq(scAt(modifyRecords[2], 'A', 'fx'), 7.2), detail: `${modifyRecords[2].outlay} / ${scAt(modifyRecords[2], 'A', 'fx')}` },
    { name: 'cif.inheritsCommittedFx', pass: fxEq(scAt(modifyRecords[3], 'A', 'fx'), 7.2) && fxEq(scAt(modifyRecords[3], 'B', 'fx'), 7.2), detail: `${scAt(modifyRecords[3], 'A', 'fx')} / ${scAt(modifyRecords[3], 'B', 'fx')}` },
    { name: 'cif.noDoubleFreightInsurance', pass: scAt(modifyRecords[3], 'B', 'freight') === undefined && scAt(modifyRecords[3], 'B', 'insurance') === undefined, detail: JSON.stringify(modifyRecords.at(-1)?.scenarios) },
    { name: 'cif.outlay', pass: modifyRecords[3].outlay === '9665.57', detail: modifyRecords[3].outlay },
    { name: 'cif.compare', pass: modifyRecords[3].comparison?.cheaper === 'B' && modifyRecords[3].comparison?.diff === '-268.49', detail: JSON.stringify(modifyRecords[3].comparison) }
  ] : [{ name: 'modify.flowComplete', pass: false, detail: `only ${modifyRecords.length} turns` }];

  const expected = [null, null, '9658.11', '9658.11', '9397.08', '9397.08'];
  const checks = records.map((r, i) => {
    if (i === 2) return { turn: 3, name: 'outlay', pass: r.outlay === expected[2], detail: r.outlay };
    if (i === 4) return { turn: 5, name: 'outlay', pass: r.outlay === expected[4], detail: r.outlay };
    if (i === 3) return { turn: 4, name: 'sensitivity', pass: r.sensitivity === '9934.06', detail: r.sensitivity };
    if (i === 5) return { turn: 6, name: 'export', pass: Boolean(r.export), detail: r.export };
    return { turn: i + 1, name: 'phase', pass: i < 2 ? r.phase === 'collecting' : true, detail: r.phase };
  });
  const allChecks = [...checks, ...modifyChecks];
  const failedChecks = allChecks.filter(c => !c.pass);
  const report = {
    ...base,
    model: { name: model.name, mode: model.mode, endpoint: model.endpoint },
    status: failed || modifyFailed || failedChecks.length ? 'FAIL' : 'PASS',
    blocked: Boolean(records.some(r => r.errorDetail?.providerStatus === 402)),
    failure: failed || modifyFailed,
    checks: { total: allChecks.length, passed: allChecks.length - failedChecks.length, failed: failedChecks.length },
    failedChecks,
    records,
    modify: { turns: MODIFY_TURNS, records: modifyRecords, checks: modifyChecks },
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
