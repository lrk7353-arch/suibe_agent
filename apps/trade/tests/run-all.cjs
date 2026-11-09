'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const OUT_DIR = path.join(ROOT, 'runs', `acceptance-${stamp}`);

function run(script) {
  const started = Date.now();
  const res = spawnSync(NODE, [path.join(__dirname, script)], { encoding: 'utf8', timeout: 240000 });
  return {
    script,
    status: res.status,
    durationMs: Date.now() - started,
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || '').trim()
  };
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const executions = [run('run-cases.cjs'), run('run-core-flow.cjs'), run('run-adapter-e2e.cjs'), run('run-model-integration.cjs')];
  for (const e of executions) {
    const log = `$ ${path.basename(process.execPath)} tests/${e.script}
status=${e.status}

--- stdout ---
${e.stdout}

--- stderr ---
${e.stderr}
`;
    fs.writeFileSync(path.join(OUT_DIR, `${e.script}.log`), log, 'utf8');
  }
  const cases = readJson(path.join(ROOT, 'runs', 'latest-cases.json'));
  const core = readJson(path.join(ROOT, 'runs', 'latest-core-flow.json'));
  const model = readJson(path.join(ROOT, 'runs', 'latest-model-integration.json'));
  const adapter = readJson(path.join(ROOT, 'runs', 'latest-adapter-e2e.json'));
  const human = readJson(path.join(ROOT, 'tests', 'human-review.json'));

  const toolStatePass = Boolean(cases && cases.failed === 0 && cases.vetoCount === 0 && core && core.failed.length === 0 && core.deterministic);
  const humanCovered = (human?.items || []).filter(i => i.result !== 'NOT_COVERED');
  const humanPass = humanCovered.length > 0 && humanCovered.every(i => i.result === 'PASS');
  const modelStatus = model?.status || 'NOT_RUN';

  const summary = {
    generator: 'trade-demo-v1/run-all.cjs',
    generatedAt: new Date().toISOString(),
    executions,
    tiers: {
      tool_state: {
        status: toolStatePass ? 'PASS' : 'FAIL',
        cases: cases ? { total: cases.total, passed: cases.passed, failed: cases.failed, veto: cases.vetoCount, byCategory: cases.byCategory } : null,
        coreFlow: core ? { runs: core.runs.length, checks: core.checks, deterministic: core.deterministic } : null
      },
      adapter_http: adapter ? { status: adapter.status, checks: adapter.checks, note: adapter.note } : { status: 'NOT_RUN' },
      model_integrated: model ? { status: modelStatus, reason: model.reason || model.failure || null, blocked: Boolean(model.blocked), checks: model.checks || null } : { status: 'NOT_RUN' },
      human_fact: {
        status: humanPass ? (human.items.some(i => i.result === 'NOT_COVERED') ? 'PASS_WITH_NOT_COVERED' : 'PASS') : 'FAIL',
        reviewedAt: human?.reviewedAt || null,
        reviewer: human?.reviewer || null,
        items: (human?.items || []).map(i => ({ id: i.id, claim: i.claim, result: i.result })),
        notCovered: human?.notCovered || []
      }
    },
    overall: {
      readyForToolStateDemo: toolStatePass,
      readyForModelIntegratedDemo: modelStatus === 'PASS',
      statement: toolStatePass
        ? (modelStatus === 'PASS'
          ? '工具与状态流程通过，DeepSeek 真实调用通过，可进行模型接入后的现场演示。'
          : `工具与状态流程、HTTP 适配器链路通过；DeepSeek 真实调用未通过（${model?.failure || model?.reason || '未执行'}），真实模型能力未验证。现场演示应使用模拟解析或预录结果，并在画面和口播中明确标注。`)
        : '工具与状态流程仍未通过，不宜进入现场演示。'
    }
  };

  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  fs.writeFileSync(path.join(ROOT, 'runs', 'latest-acceptance.json'), JSON.stringify(summary, null, 2), 'utf8');

  const lines = [];
  lines.push('# 经贸演示 · 回答正确性验收报告');
  lines.push('');
  lines.push(`生成时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（Asia/Shanghai）`);
  lines.push('');
  lines.push('## 总览');
  lines.push('');
  lines.push('| 层级 | 状态 | 说明 |');
  lines.push('|---|---|---|');
  lines.push(`| 工具与状态流程 | ${toolStatePass ? '通过' : '未通过'} | 模拟模型响应；${cases?.passed}/${cases?.total} 条用例通过；核心流程 3 次${core?.deterministic ? '一致' : '不一致'} |`);
  lines.push(`| HTTP 适配器链路 | ${adapter?.status === 'PASS' ? '通过' : adapter?.status || '未执行'} | 本地 OpenAI 兼容假端点；${adapter?.checks?.passed || 0}/${adapter?.checks?.total || 0} 项检查 |`);
  lines.push(`| DeepSeek 真实模型 | ${modelStatus === 'PASS' ? '通过' : modelStatus === 'NOT_RUN' ? '未执行' : '未通过'} | ${model?.failure || model?.reason || (modelStatus === 'PASS' ? `真实模型参数提案通过（${model.checks?.passed}/${model.checks?.total}）` : '待复测')} |`);
  lines.push(`| 人工事实复核 | ${humanPass ? '范围内通过' : '未通过'} | ${humanCovered.length} 项已复核通过；${(human?.items || []).filter(i => i.result === 'NOT_COVERED').length} 项未覆盖 |`);
  lines.push('');
  lines.push('> 三层分别报告，不互相替代。工具与状态通过不等于真实模型接入后通过。');
  lines.push('');
  lines.push('## 一、工具与状态流程');
  lines.push('');
  if (cases) {
    lines.push(`用例总数 **${cases.total}**，通过 **${cases.passed}**，失败 **${cases.failed}**，否决 **${cases.vetoCount}**。`);
    lines.push('');
    lines.push('| 类型 | 用例数 | 通过 | 最低要求 | 是否达到 |');
    lines.push('|---|---:|---:|---:|---|');
    for (const [category, count] of Object.entries(cases.byCategory)) {
      const min = cases.categoryMinimums?.[category] ?? 0;
      lines.push(`| ${category} | ${count.total} | ${count.pass} | ${min} | ${count.total >= min ? '是' : '否'} |`);
    }
    lines.push('');
  }
  if (core) {
    lines.push(`核心演示流程重复运行 **${core.runs.length} 次**：${core.checks.passed}/${core.checks.total} 项断言通过；三次运行的阶段、金额、对比与导出${core.deterministic ? '完全一致' : '存在差异'}。`);
    lines.push('');
    lines.push('| 轮次 | 第 3 轮支出 | 第 4 轮试算 | 第 5 轮更低方案 | 差额 | 导出 | 状态版本 |');
    lines.push('|---|---:|---:|---|---:|---|---|');
    for (const r of core.runs) {
      lines.push(`| 第 ${r.run} 次 | ${r.turns[2].result?.outlay} | ${r.turns[3].sensitivity?.outlay} | ${r.turns[4].comparison?.cheaperId} | ${r.turns[4].comparison?.diff} | ${r.turns[5].export?.scenarioIds.join('+')} | ${r.turns[5].stateVersion} |`);
    }
    lines.push('');
  }
  lines.push('## 二、HTTP 适配器与真实模型');
  lines.push('');
  if (adapter) {
    lines.push(`本地 OpenAI 兼容假端点（非 DeepSeek）：**${adapter.status}**，${adapter.checks.passed}/${adapter.checks.total} 项检查通过。`);
    lines.push('');
    lines.push('该测试只验证 HTTP 请求、JSON 解析、提案校验、状态与工具链路，不代表 DeepSeek 的生成质量。');
    lines.push('');
  }
  if (modelStatus === 'NOT_RUN') {
    lines.push('**未执行。** 原因：本轮未设置 `TRADE_DEMO_MODEL_URL`，按协作边界使用模拟模型响应，未调用线上或本地生成模型。');
    lines.push('');
    lines.push('复测要求：设置模型地址与模型名后运行 `node tests/run-model-integration.cjs`，把 `runs/latest-model-integration.json` 与本报告一起归档；真实模型只提交参数提案，金额必须仍由工具计算，提案不合法时程序应拒绝执行。');
  } else {
    lines.push(`DeepSeek 真实调用：**${modelStatus}**。${model.failure || model.reason || ''}`);
    if (model.checks) lines.push(`检查项：${model.checks.passed}/${model.checks.total} 通过。`);
    if (model.blocked) lines.push('该失败由账户余额（HTTP 402 Insufficient Balance）阻断，不是参数校验或计算错误；真实模型能力尚未验证。');
  }
  lines.push('');
  lines.push('## 三、人工事实复核');
  lines.push('');
  lines.push(`复核人：${human?.reviewer || '—'}　日期：${human?.reviewedAt || '—'}`);
  lines.push('');
  lines.push('| 编号 | 复核项 | 结果 |');
  lines.push('|---|---|---|');
  for (const item of human?.items || []) lines.push(`| ${item.id} | ${item.claim} | ${item.result} |`);
  lines.push('');
  lines.push('未覆盖范围：');
  for (const item of human?.notCovered || []) lines.push(`- ${item}`);
  lines.push('');
  lines.push('## 四、执行记录');
  lines.push('');
  lines.push('| 脚本 | 退出码 | 耗时 |');
  lines.push('|---|---:|---:|');
  for (const e of executions) lines.push(`| \`tests/${e.script}\` | ${e.status} | ${e.durationMs} ms |`);
  const failedExec = executions.filter(e => e.status !== 0);
  if (failedExec.length) {
    lines.push('');
    lines.push('失败脚本的 stderr 末尾：');
    for (const e of failedExec) lines.push(`- \`${e.script}\`：${(e.stderr || '').split(String.fromCharCode(10)).slice(-4).join(' / ')}`);
  }
  lines.push('');
  lines.push('## 五、结论与复测要求');
  lines.push('');
  lines.push(summary.overall.statement);
  lines.push('');
  lines.push('复测时必须完成：');
  lines.push('1. `node tests/run-cases.cjs`：41 条用例 0 失败、0 否决；任一金额与 `tests/reference_calc.py` 不一致即否决。');
  lines.push('2. `node tests/run-core-flow.cjs`：核心流程 3 次一致。');
  lines.push('3. `node tests/run-adapter-e2e.cjs`：本地假端点验证 HTTP 适配器链路。');
  lines.push('4. 模型、提示词或工具变更后 `node tests/run-model-integration.cjs`：单独报告 DeepSeek 真实调用结果，不得用模拟或假端点结果替代。');
  lines.push('5. 人工复核导出样例与范围声明；真实税率、归类与协定待遇不在本轮范围内。');
  lines.push('');
  fs.writeFileSync(path.join(OUT_DIR, 'report.md'), lines.join('\n'), 'utf8');
  fs.writeFileSync(path.join(ROOT, 'runs', 'latest-acceptance.md'), lines.join('\n'), 'utf8');

  console.log(`acceptance: tool_state=${toolStatePass ? 'PASS' : 'FAIL'} model=${modelStatus} human=${summary.tiers.human_fact.status}`);
  console.log(`report: ${path.join(OUT_DIR, 'report.md')}`);
  if (!toolStatePass) process.exitCode = 1;
}

main();
