'use strict';
// 本地 OpenAI 兼容假端点：验证 HTTP 适配器、JSON 解析、提案校验与主流程。
// 这不是 DeepSeek 真实调用，输出只用于证明“模型→提案→程序校验→工具计算”的链路。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { handleTurn } = require('../src/engine/engine.cjs');
const { createState } = require('../src/engine/state.cjs');
const { createHttpModel } = require('../src/engine/model-adapter.cjs');
const P = require('../src/engine/parser.cjs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'runs', 'latest-adapter-e2e.json');
const PORT = 18870;

function extractUserText(body) {
  const content = body?.messages?.find(m => m.role === 'user')?.content || '';
  const m = content.match(/用户这句话：([\s\S]*?)\n只输出 JSON/);
  return (m ? m[1] : content).trim();
}

function startFake() {
  return new Promise(resolve => {
    const server = http.createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      let body = {};
      try { body = JSON.parse(raw); } catch { /* 忽略 */ }
      const text = extractUserText(body);
      const proposal = P.extractTradeProposal(text, {});
      const payload = { choices: [{ message: { content: JSON.stringify(proposal) } }] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

async function runFlow(model, turns) {
  let state = createState();
  const records = [];
  for (const text of turns) {
    const res = await handleTurn({ text, state, sessionId: 'adapter-e2e', model });
    state = res.state;
    records.push({
      text,
      phase: res.phase,
      parser: res.parser,
      answer: res.answer,
      outlay: res.cards?.result?.amounts?.outlay?.value || null,
      sensitivity: res.cards?.sensitivity?.points?.find(p => !p.isBaseline)?.outlay || null,
      comparison: res.cards?.comparison?.ok ? { cheaper: res.cards.comparison.cheaper?.id, diff: res.cards.comparison.differences?.[0]?.diffFromBaseline } : null,
      export: res.cards?.export?.primary?.filename || null,
      stateVersion: state.version,
      scenarioFx: state.scenarios.map(s => `${s.id}:${s.input.fx}`),
      scenarioOffer: state.scenarios.map(s => ({ id: s.id, term: s.priceTerm, freight: s.input.freight, insurance: s.input.insurance, totalPrice: s.input.totalPrice }))
    });
  }
  return { state, records };
}

(async () => {
  const server = await startFake();
  const model = createHttpModel({ baseUrl: `http://127.0.0.1:${PORT}`, model: 'fake-deepseek', apiKey: 'test', name: 'local-fake', mode: 'http' });
  const mainTurns = [
    '帮我算一下这批进口商品的成本。',
    '100 件，每件 10 美元，FOB。',
    '运费 100 美元、保险 10 美元，汇率 7，关税 10%，增值税 13%。',
    '如果汇率涨到 7.2 呢？',
    '另一个供应商报 CIF 总价 1,080 美元，其他条件一样，哪个支出更低？',
    '把两种方案整理成一份摘要。'
  ];
  const main = await runFlow(model, mainTurns);
  const expected = [null, null, '9658.11', '9658.11', '9397.08', '9397.08'];
  const mainChecks = main.records.map((r, i) => ({
    turn: i + 1,
    expected: expected[i] || (i === 3 ? 9934.06 : 'export'),
    actual: r.outlay,
    pass: i < 2 ? r.phase === 'collecting'
      : i === 3 ? (r.outlay === '9658.11' && r.sensitivity === '9934.06')
      : i === 5 ? Boolean(r.export) && r.export.endsWith('.md')
      : r.outlay === expected[i]
  }));
  const mainFxUntouched = main.records[3].scenarioFx[0] === 'A:7.0000';
  const bNoDouble = main.records[4].scenarioOffer.find(s => s.id === 'B')?.freight === undefined
    && main.records[4].scenarioOffer.find(s => s.id === 'B')?.insurance === undefined;
  const parserConsistent = main.records.every(r => r.parser?.mode === 'http' && r.parser?.name === 'local-fake');

  const modify = await runFlow(model, [
    '100 件，每件 10 美元，FOB，运费 100 美元，保险 10 美元，汇率 7，关税 10%，增值税 13%。',
    '如果汇率涨到 7.2 呢？',
    '把汇率改成 7.2',
    '另一个供应商报 CIF 总价 1,080 美元，其他条件一样，哪个支出更低？'
  ]);
  const modifyChecks = [
    { name: 'hypothetical.keepsBaseFx', pass: modify.records[1].scenarioFx[0] === 'A:7.0000', detail: modify.records[1].scenarioFx.join(',') },
    { name: 'hypothetical.showsTarget', pass: modify.records[1].sensitivity === '9934.06', detail: modify.records[1].sensitivity },
    { name: 'commit.changesFx', pass: modify.records[2].scenarioFx[0] === 'A:7.2000' && modify.records[2].outlay === '9934.06', detail: `${modify.records[2].scenarioFx.join(',')} / ${modify.records[2].outlay}` },
    { name: 'cif.inheritsCommittedFx', pass: modify.records[3].scenarioFx.includes('B:7.2000'), detail: modify.records[3].scenarioFx.join(',') },
    { name: 'cif.noDoubleFreightInsurance', pass: modify.records[3].scenarioOffer.find(s => s.id === 'B')?.freight === undefined && modify.records[3].scenarioOffer.find(s => s.id === 'B')?.insurance === undefined, detail: JSON.stringify(modify.records[3].scenarioOffer.find(s => s.id === 'B')) },
    { name: 'cif.outlayAndCompare', pass: modify.records[3].outlay === '9665.57' && modify.records[3].comparison?.diff === '-268.49', detail: `${modify.records[3].outlay} / ${modify.records[3].comparison?.diff}` }
  ];

  const checks = [
    ...mainChecks.map(c => ({ scope: 'main', name: `turn${c.turn}`, pass: c.pass, detail: `${c.actual}` })),
    { scope: 'main', name: 'hypothetical.keepsBaseFx', pass: mainFxUntouched, detail: main.records[3].scenarioFx.join(',') },
    { scope: 'main', name: 'cif.noDoubleFreightInsurance', pass: bNoDouble, detail: JSON.stringify(main.records[4].scenarioOffer.find(s => s.id === 'B')) },
    { scope: 'main', name: 'parser.modeConsistent', pass: parserConsistent, detail: JSON.stringify(main.records.map(r => r.parser)) },
    ...modifyChecks
  ];
  const failed = checks.filter(c => !c.pass);
  const report = {
    generator: 'trade-demo-v1/run-adapter-e2e.cjs',
    generatedAt: new Date().toISOString(),
    tier: 'adapter_http_fake_endpoint',
    note: '本地 OpenAI 兼容假端点，验证 HTTP 适配器与主流程；不是 DeepSeek 真实调用，不代表真实模型生成质量。',
    endpoint: `http://127.0.0.1:${PORT}`,
    main,
    modify,
    checks: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    failed,
    status: failed.length ? 'FAIL' : 'PASS'
  };
  server.close();
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
  console.log(`adapter e2e: ${report.status} (${report.checks.passed}/${report.checks.total})`);
  if (failed.length) for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  if (failed.length) process.exitCode = 1;
})().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
