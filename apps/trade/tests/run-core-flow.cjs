'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { handleTurn } = require('../src/engine/engine.cjs');
const { createState } = require('../src/engine/state.cjs');

const ROOT = path.resolve(__dirname, '..');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const OUT_DIR = path.join(ROOT, 'runs', `core-flow-${stamp}`);
const TURNS = [
  '帮我算一下这批进口商品的成本。',
  '100 件，每件 10 美元，FOB。',
  '运费 100 美元、保险 10 美元，汇率 7，关税 10%，增值税 13%。',
  '如果汇率涨到 7.2 呢？',
  '另一个供应商报 CIF 总价 1,080 美元，其他条件一样，哪个支出更低？',
  '把两种方案整理成一份摘要。'
];
const EXPECTED = [
  { phase: 'collecting', result: null },
  { phase: 'collecting', result: null },
  { phase: 'calculated', outlay: '9658.11', perUnit: '96.58' },
  { phase: 'calculated', outlay: '9658.11', sensitivity: '9934.06' },
  { phase: 'comparing', outlay: '9397.08', cheaper: 'B', diff: '-261.03' },
  { phase: 'exported', outlay: '9397.08', scenarioIds: ['A', 'B'] }
];

function sha256(text) { return crypto.createHash('sha256').update(text, 'utf8').digest('hex'); }
function normalizeAnswer(text) {
  return String(text || '')
    .replace(/小贸-进口成本案例-\d{8}-\d{4}\.(md|html|json)/g, '小贸-进口成本案例-<stamp>.$1')
    .replace(/内容校验码前 12 位：[0-9a-f]{12}/g, '内容校验码前 12 位：<hash>');
}

async function runOnce(index) {
  let state = createState();
  const turns = [];
  for (let i = 0; i < TURNS.length; i += 1) {
    const t0 = process.hrtime.bigint();
    const res = await handleTurn({ text: TURNS[i], state, sessionId: `core-${index}` });
    const durationMs = Number(process.hrtime.bigint() - t0) / 1e6;
    state = res.state;
    const exported = res.cards?.export;
    const record = {
      turn: i + 1,
      text: TURNS[i],
      phase: res.phase,
      stateVersion: state.version,
      answer: res.answer,
      detail: res.detail,
      durationMs: Math.round(durationMs * 1000) / 1000,
      result: res.cards?.result
        ? {
            scenarioId: res.cards.result.scenarioId,
            priceTerm: res.cards.result.priceTerm,
            outlay: res.cards.result.amounts.outlay.value,
            perUnit: res.cards.result.amounts.perUnit.value,
            taxableValue: res.cards.result.amounts.taxableValue.value,
            duty: res.cards.result.amounts.duty.value,
            vat: res.cards.result.amounts.vat.value,
            resultHash: res.cards.result.resultHash
          }
        : null,
      sensitivity: res.cards?.sensitivity
        ? res.cards.sensitivity.points.find(p => !p.isBaseline)
        : null,
      comparison: res.cards?.comparison
        ? {
            ok: res.cards.comparison.ok,
            cheaperId: res.cards.comparison.cheaper?.id,
            diff: res.cards.comparison.differences?.[0]?.diffFromBaseline,
            diffPercent: res.cards.comparison.differences?.[0]?.diffPercent,
            sameScope: res.cards.comparison.sameScope
          }
        : null,
      export: exported
        ? {
            scenarioIds: exported.primary.scenarioIds,
            filename: exported.primary.filename,
            checksum: exported.primary.checksum,
            checksumValid: sha256(exported.formats.markdown.content) === exported.primary.checksum,
            bytes: exported.primary.bytes
          }
        : null,
      toolCalls: res.toolCalls.map(t => ({ name: t.name, ok: t.ok, code: t.code }))
    };
    turns.push(record);
  }
  return { run: index, turns };
}

function verify(run) {
  const checks = [];
  const add = (turn, name, pass, detail) => checks.push({ turn, name, pass: Boolean(pass), detail });
  for (let i = 0; i < EXPECTED.length; i += 1) {
    const exp = EXPECTED[i];
    const rec = run.turns[i];
    add(i + 1, 'phase', rec.phase === exp.phase, `${rec.phase}`);
    if (exp.result === null) add(i + 1, 'no-result', !rec.result, rec.result ? rec.result.outlay : 'ok');
    if (exp.outlay) add(i + 1, 'outlay', rec.result?.outlay === exp.outlay, `${rec.result?.outlay}`);
    if (exp.perUnit) add(i + 1, 'perUnit', rec.result?.perUnit === exp.perUnit, `${rec.result?.perUnit}`);
    if (exp.sensitivity) add(i + 1, 'sensitivity', rec.sensitivity?.outlay === exp.sensitivity, `${rec.sensitivity?.outlay}`);
    if (exp.cheaper) add(i + 1, 'cheaper', rec.comparison?.cheaperId === exp.cheaper, `${rec.comparison?.cheaperId}`);
    if (exp.diff) add(i + 1, 'diff', rec.comparison?.diff === exp.diff, `${rec.comparison?.diff}`);
    if (exp.scenarioIds) add(i + 1, 'export-scenarios', JSON.stringify(rec.export?.scenarioIds) === JSON.stringify(exp.scenarioIds), JSON.stringify(rec.export?.scenarioIds));
    if (rec.export) add(i + 1, 'export-checksum', rec.export.checksumValid, rec.export.checksum);
    add(i + 1, 'no-raw-json', !/\{\s*"|"amounts"\s*:/.test(rec.answer + (rec.detail || '')), '无原始 JSON');
  }
  return checks;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const runs = [];
  for (let i = 1; i <= 3; i += 1) runs.push(await runOnce(i));
  const verification = runs.map(r => ({ run: r.run, checks: verify(r) }));
  const allChecks = verification.flatMap(v => v.checks);
  const failed = allChecks.filter(c => !c.pass);

  // 三次运行的确定性比对（忽略时间戳、文件名与校验码）
  const signatures = runs.map(r => JSON.stringify(r.turns.map(t => ({
    phase: t.phase,
    outlay: t.result?.outlay,
    perUnit: t.result?.perUnit,
    sensitivity: t.sensitivity?.outlay,
    comparison: t.comparison,
    exportScenarios: t.export?.scenarioIds,
    answer: normalizeAnswer(t.answer)
  }))));
  const deterministic = signatures.every(s => s === signatures[0]);

  const summary = {
    generator: 'trade-demo-v1/run-core-flow.cjs',
    generatedAt: new Date().toISOString(),
    turns: TURNS,
    runs,
    verification,
    deterministic,
    checks: { total: allChecks.length, passed: allChecks.length - failed.length, failed: failed.length },
    failed
  };
  fs.writeFileSync(path.join(OUT_DIR, 'runs.json'), JSON.stringify(summary, null, 2), 'utf8');
  fs.writeFileSync(path.join(ROOT, 'runs', 'latest-core-flow.json'), JSON.stringify(summary, null, 2), 'utf8');

  const lines = [];
  lines.push('# 核心演示流程 · 重复运行 3 次');
  lines.push('');
  lines.push(`生成时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（Asia/Shanghai）`);
  lines.push(`结论：${failed.length === 0 && deterministic ? '**3 次运行全部通过，且结果一致**' : '**存在失败或不确定项**'}`);
  lines.push('');
  lines.push('| 轮次 | 第 3 轮支出 | 第 4 轮试算 | 第 5 轮更低方案 | 第 5 轮差额 | 第 6 轮导出 | 状态版本 | 耗时合计 |');
  lines.push('|---|---:|---:|---|---:|---|---|---:|');
  for (const r of runs) {
    const t3 = r.turns[2].result;
    const t4 = r.turns[3].sensitivity;
    const t5 = r.turns[4].comparison;
    const t6 = r.turns[5].export;
    const totalMs = r.turns.reduce((sum, t) => sum + t.durationMs, 0);
    lines.push(`| 第 ${r.run} 次 | ${t3?.outlay} | ${t4?.outlay} | ${t5?.cheaperId} | ${t5?.diff} | ${t6?.scenarioIds.join('+')} / ${t6?.checksumValid ? '校验通过' : '校验失败'} | ${r.turns[5].stateVersion} | ${totalMs.toFixed(1)} ms |`);
  }
  lines.push('');
  lines.push('## 逐轮结果');
  lines.push('');
  for (const r of runs) {
    lines.push(`### 第 ${r.run} 次`);
    lines.push('');
    lines.push('| 轮次 | 用户输入 | 阶段 | 支出 | 每件 | 工具 |');
    lines.push('|---|---|---|---:|---:|---|');
    for (const t of r.turns) {
      lines.push(`| ${t.turn} | ${t.text.replace(/\|/g, '\\|')} | ${t.phase} | ${t.result?.outlay || '—'} | ${t.result?.perUnit || '—'} | ${t.toolCalls.map(x => x.name).join(', ')} |`);
    }
    lines.push('');
  }
  lines.push('## 断言');
  lines.push('');
  lines.push(`共 ${allChecks.length} 项，通过 ${allChecks.length - failed.length} 项，失败 ${failed.length} 项。`);
  lines.push('');
  lines.push(`三次运行的金额、状态、回答（排除时间戳与文件名）${deterministic ? '完全一致' : '存在差异'}。`);
  lines.push('');
  fs.writeFileSync(path.join(OUT_DIR, 'report.md'), lines.join('\n'), 'utf8');
  fs.writeFileSync(path.join(ROOT, 'runs', 'latest-core-flow.md'), lines.join('\n'), 'utf8');

  console.log(`core flow: ${allChecks.length - failed.length}/${allChecks.length} checks, deterministic=${deterministic}`);
  if (failed.length) for (const f of failed.slice(0, 8)) console.log(`  - t${f.turn} ${f.name}: ${f.detail}`);
  if (failed.length || !deterministic) process.exitCode = 1;
}

main().catch(err => { console.error(err.stack || err.message); process.exit(1); });
