'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { handleTurn } = require('../src/engine/engine.cjs');
const { createState } = require('../src/engine/state.cjs');
const T = require('../src/engine/tools.cjs');
const P = require('../src/engine/parser.cjs');
const D = require('../src/engine/decimal.cjs');

const ROOT = path.resolve(__dirname, '..');
const CASES_PATH = path.join(__dirname, 'cases', 'trade-cases.json');
const REFERENCE = path.join(__dirname, 'reference_calc.py');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const OUT_DIR = path.join(ROOT, 'runs', `cases-${stamp}`);

function sha256(text) { return crypto.createHash('sha256').update(text, 'utf8').digest('hex'); }

function loadReference() {
  const python = process.env.PYTHON || 'python';
  const res = spawnSync(python, ['-I', REFERENCE], { encoding: 'utf8', timeout: 30000 });
  if (res.status !== 0) {
    throw new Error(`独立参考计算失败：${res.stderr || res.error?.message || 'unknown'}`);
  }
  return JSON.parse(res.stdout);
}

function makeModel(failTurns, turn) {
  return {
    name: 'simulated-flaky',
    async propose({ text, state }) {
      if (failTurns.includes(turn)) {
        const err = new Error('模拟模型超时（测试注入）');
        err.code = 'timeout';
        throw err;
      }
      return P.extractTradeProposal(text, state);
    }
  };
}

function applyInjection(state, inject) {
  if (!inject) return;
  const scenario = state.scenarios.find(s => s.id === inject.scenarioId);
  if (!scenario || !scenario.result) throw new Error(`注入失败：找不到方案 ${inject.scenarioId} 的结果`);
  if (inject.type === 'tamperResultAmount') {
    scenario.result.amounts[inject.field].value = inject.value;
  }
}

function scenarioValue(scenario, field) {
  if (field === 'priceTerm') return scenario.priceTerm;
  if (field === 'currency') return scenario.currency;
  if (field === 'quantityUnit') return scenario.quantityUnit;
  return scenario.input?.[field];
}

function equalValue(actual, expected) {
  if (actual === undefined || actual === null) return expected === undefined || expected === null;
  if (typeof expected === 'number' || typeof actual === 'number') return Number(actual) === Number(expected);
  try { return D.parse(actual) === D.parse(expected); } catch { return String(actual) === String(expected); }
}

function finalActive(state) {
  return state.scenarios.find(s => s.id === state.activeScenarioId) || null;
}

function conditionOf(last) {
  const conditions = last?.cards?.conditions;
  if (!conditions) return null;
  return conditions.scenarios.find(s => s.id === conditions.activeId) || null;
}

function evaluate(caseDef, responses, reference) {
  const checks = [];
  const add = (name, pass, detail, veto = false) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? null : detail, veto: veto && !pass });
  const last = responses.at(-1)?.response;
  const state = responses.at(-1)?.state;
  const active = finalActive(state);
  const expected = caseDef.expect || {};

  if (caseDef.referenceKey) {
    const ref = reference[caseDef.referenceKey];
    if (!ref) add('reference.exists', false, `缺少参考组 ${caseDef.referenceKey}`, true);
    else {
      const keys = ['goodsTotal', 'cifEquivalent', 'taxableValue', 'duty', 'vat', 'outlay', 'perUnit'];
      for (const key of keys) {
        if (expected.amounts && expected.amounts[key] !== undefined) {
          add(`reference.${key}`, String(ref[key]) === String(expected.amounts[key]), `reference=${ref[key]} case=${expected.amounts[key]}`, true);
        }
      }
      if (caseDef.humanReference) {
        for (const [key, value] of Object.entries(caseDef.humanReference)) {
          add(`humanReference.${key}`, String(ref[key]) === String(value), `reference=${ref[key]} humanReference=${value}`, true);
        }
      }
    }
  }

  if (expected.finalPhase !== undefined) add('finalPhase', last?.phase === expected.finalPhase, `actual=${last?.phase}`);
  if (expected.scenarioCount !== undefined) add('scenarioCount', state?.scenarios.length === expected.scenarioCount, `actual=${state?.scenarios.length}`);
  if (expected.minVersion !== undefined) add('minVersion', (state?.version || 0) >= expected.minVersion, `actual=${state?.version}`);

  if (expected.amounts === null) {
    add('amounts.none', !last?.cards?.result, last?.cards?.result ? '仍返回结果卡' : '无结果卡', true);
  } else if (expected.amounts) {
    if (!last?.cards?.result) add('amounts.exists', false, '没有结果卡', true);
    else {
      for (const [key, value] of Object.entries(expected.amounts)) {
        const actual = last.cards.result.amounts?.[key]?.value;
        add(`amount.${key}`, String(actual) === String(value), `actual=${actual} expected=${value}`, true);
      }
    }
  }

  const answer = last?.answer || '';
  const detail = last?.detail || '';
  for (const text of expected.answerContains || []) add(`answer.contains:${text}`, answer.includes(text), answer.slice(0, 120));
  for (const text of expected.answerExcludes || []) add(`answer.excludes:${text}`, !answer.includes(text), answer.slice(0, 120));
  for (const text of expected.detailContains || []) add(`detail.contains:${text}`, detail.includes(text), detail.slice(0, 120));
  if (expected.noRawJson) add('noRawJson', !/\{\s*"|"amounts"\s*:|\btoolCalls\b/.test(answer + detail), '回答中不应出现原始 JSON', true);

  const tools = [...new Set(responses.flatMap(r => (r.response.toolCalls || []).map(t => t.name)))];
  const lastTools = [...new Set((last?.toolCalls || []).map(t => t.name))];
  for (const name of expected.toolsInclude || []) add(`tools.include:${name}`, tools.includes(name), tools.join(','));
  for (const name of expected.allToolsExclude || []) add(`tools.excludeAll:${name}`, !tools.includes(name), tools.join(','), true);
  for (const name of expected.lastToolsExclude || []) add(`tools.excludeLast:${name}`, !lastTools.includes(name), lastTools.join(','), true);

  if (expected.missingFields) {
    const actual = active ? T.validateTradeInputs(active).missing.map(m => m.field) : [];
    add('missingFields', JSON.stringify(actual) === JSON.stringify(expected.missingFields), `actual=${actual.join(',')} expected=${expected.missingFields.join(',')}`);
  }
  if (expected.conditionErrorCodes) {
    const cond = conditionOf(last);
    const codes = (cond?.errors || []).map(e => e.code);
    for (const code of expected.conditionErrorCodes) add(`conditionError:${code}`, codes.includes(code), codes.join(','));
  }
  if (expected.errorCode !== undefined) add('errorCode', last?.error?.code === expected.errorCode, `actual=${last?.error?.code}`);
  if (expected.errorsSeen) {
    const seen = responses.map(r => r.response.error?.code).filter(Boolean);
    for (const code of expected.errorsSeen) add(`errorsSeen:${code}`, seen.includes(code), seen.join(','));
  }
  if (expected.pendingKind !== undefined) add('pendingKind', (last?.state?.pending?.kind ?? null) === expected.pendingKind, `actual=${last?.state?.pending?.kind ?? null}`);
  if (expected.pendingField !== undefined) add('pendingField', (last?.state?.pending?.field ?? null) === expected.pendingField, `actual=${last?.state?.pending?.field ?? null}`);

  if (expected.lastChange) {
    const change = last?.state?.lastChange;
    if (!change) add('lastChange.exists', false, '缺少变更记录', true);
    else {
      if (expected.lastChange.field !== undefined) add('lastChange.field', change.field === expected.lastChange.field, `actual=${change.field}`);
      if (expected.lastChange.from !== undefined) add('lastChange.from', change.from === expected.lastChange.from, `actual=${change.from}`);
      if (expected.lastChange.to !== undefined) add('lastChange.to', change.to === expected.lastChange.to, `actual=${change.to}`);
      if (expected.lastChange.count !== undefined) add('lastChange.count', change.fields?.length === expected.lastChange.count, `actual=${change.fields?.length}`);
    }
  }

  const comparison = last?.cards?.comparison;
  if (expected.comparisonOk !== undefined) add('comparison.ok', Boolean(comparison?.ok) === expected.comparisonOk, `actual=${comparison?.ok} code=${comparison?.code}`);
  if (expected.comparisonCode !== undefined) add('comparison.code', comparison?.code === expected.comparisonCode, `actual=${comparison?.code}`);
  if (expected.cheaperId !== undefined) add('comparison.cheaper', comparison?.cheaper?.id === expected.cheaperId, `actual=${comparison?.cheaper?.id}`);
  if (expected.diff !== undefined) add('comparison.diff', comparison?.differences?.[0]?.diffFromBaseline === expected.diff, `actual=${comparison?.differences?.[0]?.diffFromBaseline}`);
  if (expected.sameScope !== undefined) add('comparison.sameScope', comparison?.sameScope === expected.sameScope, `actual=${comparison?.sameScope}`);
  if (expected.sameCost !== undefined) add('comparison.sameCost', comparison?.sameCost === expected.sameCost, `actual=${comparison?.sameCost}`);
  if (expected.minReasons !== undefined) add('comparison.reasons', (comparison?.reasons?.length || 0) >= expected.minReasons, `actual=${comparison?.reasons?.length || 0}`);

  if (expected.scenarioOutlays) {
    for (const [id, outlay] of Object.entries(expected.scenarioOutlays)) {
      const scenario = state?.scenarios.find(s => s.id === id);
      if (!scenario) { add(`scenario.${id}.exists`, false, '方案不存在', true); continue; }
      const r = T.calculateImportOutlay(scenario);
      add(`scenario.${id}.outlay`, r.ok && r.amounts.outlay.value === outlay, `actual=${r.ok ? r.amounts.outlay.value : 'invalid'} expected=${outlay}`, true);
    }
  }
  if (expected.scenarioValues) {
    for (const [id, fields] of Object.entries(expected.scenarioValues)) {
      const scenario = state?.scenarios.find(s => s.id === id);
      if (!scenario) { add(`scenarioValues.${id}`, false, '方案不存在', true); continue; }
      for (const [field, value] of Object.entries(fields)) {
        const actual = scenarioValue(scenario, field);
        add(`scenarioValues.${id}.${field}`, equalValue(actual, value), `actual=${actual} expected=${value}`);
      }
    }
  }
  if (expected.metaSources) {
    for (const [id, fields] of Object.entries(expected.metaSources)) {
      const scenario = state?.scenarios.find(s => s.id === id);
      for (const [field, source] of Object.entries(fields)) {
        const actual = scenario?.meta?.[field]?.source;
        add(`metaSource.${id}.${field}`, actual === source, `actual=${actual} expected=${source}`);
      }
    }
  }
  if (expected.fieldNotes) {
    for (const [id, fields] of Object.entries(expected.fieldNotes)) {
      const scenario = state?.scenarios.find(s => s.id === id);
      for (const [field, fragment] of Object.entries(fields)) {
        const note = scenario?.meta?.[field]?.note || '';
        add(`fieldNote.${id}.${field}`, note.includes(fragment), `actual=${note}`);
      }
    }
  }
  if (expected.trace) {
    const result = last?.cards?.result;
    for (const [id, vals] of Object.entries(expected.trace)) {
      const step = result?.trace?.find(s => s.id === id);
      if (!step) { add(`trace.${id}`, false, '缺少步骤', true); continue; }
      for (const [key, value] of Object.entries(vals)) add(`trace.${id}.${key}`, String(step[key]) === String(value), `actual=${step[key]} expected=${value}`, true);
    }
  }

  if (expected.export) {
    const exported = last?.cards?.export;
    if (!exported) add('export.exists', false, '没有导出卡', true);
    else {
      const content = exported.formats?.markdown?.content || '';
      if (expected.export.scenarioIds) add('export.scenarioIds', JSON.stringify(exported.primary.scenarioIds) === JSON.stringify(expected.export.scenarioIds), `actual=${exported.primary.scenarioIds.join(',')}`);
      for (const text of expected.export.contains || []) add(`export.contains:${text}`, content.includes(text), text);
      for (const text of expected.export.excludes || []) add(`export.excludes:${text}`, !content.includes(text), text, true);
      if (expected.export.checksumValid) add('export.checksum', sha256(content) === exported.primary.checksum, '导出内容 SHA-256 与校验码不一致', true);
      if (expected.export.ext) add('export.ext', path.extname(exported.primary.filename) === expected.export.ext, exported.primary.filename);
    }
  }

  return checks;
}

async function runCase(caseDef, reference) {
  const started = Date.now();
  let state = createState();
  const responses = [];
  const audit = [];
  const failTurns = caseDef.modelFailureAt || [];
  for (let i = 0; i < caseDef.turns.length; i += 1) {
    const text = caseDef.turns[i];
    const model = failTurns.length ? makeModel(failTurns, i + 1) : null;
    const res = await handleTurn({ text, state, sessionId: caseDef.id, model, now: Date.now() });
    state = res.state;
    responses.push({ turn: i + 1, text, response: res, state });
    audit.push({
      caseId: caseDef.id,
      turn: i + 1,
      text,
      phase: res.phase,
      stateVersion: state.version,
      answer: res.answer,
      toolCalls: (res.toolCalls || []).map(t => ({ name: t.name, ok: t.ok, code: t.code })),
      error: res.error?.code || null,
      audit: res.audit
    });
    if (caseDef.inject && caseDef.inject.afterTurn === i + 1) applyInjection(state, caseDef.inject);
    if (caseDef.perTurn?.[i]) {
      const exp = caseDef.perTurn[i];
      const last = res;
      const checks = [];
      if (exp.phase && last.phase !== exp.phase) checks.push(`phase=${last.phase}`);
      if (exp.pendingKind !== undefined && (last.state?.pending?.kind ?? null) !== exp.pendingKind) checks.push(`pendingKind=${last.state?.pending?.kind ?? null}`);
      if (exp.pendingField !== undefined && (last.state?.pending?.field ?? null) !== exp.pendingField) checks.push(`pendingField=${last.state?.pending?.field ?? null}`);
      if (checks.length) responses[responses.length - 1].perTurnFailure = checks;
    }
  }
  const checks = evaluate(caseDef, responses, reference);
  for (const r of responses) {
    if (r.perTurnFailure) checks.push({ name: `perTurn.${r.turn}`, pass: false, detail: r.perTurnFailure.join(';'), veto: false });
  }
  const passed = checks.filter(c => c.pass).length;
  const failed = checks.filter(c => !c.pass);
  const veto = failed.some(c => c.veto);
  return {
    id: caseDef.id,
    title: caseDef.title,
    category: caseDef.category,
    tier: caseDef.tier,
    status: failed.length ? 'FAIL' : 'PASS',
    veto,
    score: checks.length ? Number((passed / checks.length).toFixed(4)) : 0,
    checksPassed: passed,
    checksTotal: checks.length,
    durationMs: Date.now() - started,
    turns: caseDef.turns,
    finalAnswer: responses.at(-1)?.response.answer || '',
    detail: responses.at(-1)?.response.detail || '',
    stateVersion: responses.at(-1)?.state?.version,
    phase: responses.at(-1)?.response.phase,
    failures: failed,
    checks,
    audit
  };
}

async function main() {
  const reference = loadReference();
  const data = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const results = [];
  for (const caseDef of data.cases) {
    const result = await runCase(caseDef, reference);
    results.push(result);
    console.log(`${result.status === 'PASS' ? 'PASS' : 'FAIL'} ${result.id} ${result.title}${result.veto ? ' [VETO]' : ''}`);
    if (result.status === 'FAIL') {
      for (const f of result.failures.slice(0, 4)) console.log(`  - ${f.name}: ${f.detail}`);
    }
  }
  const byCategory = {};
  for (const r of results) {
    byCategory[r.category] = byCategory[r.category] || { total: 0, pass: 0, veto: 0 };
    byCategory[r.category].total += 1;
    if (r.status === 'PASS') byCategory[r.category].pass += 1;
    if (r.veto) byCategory[r.category].veto += 1;
  }
  const summary = {
    generator: 'trade-demo-v1/run-cases.cjs',
    generatedAt: new Date().toISOString(),
    caseFile: path.relative(ROOT, CASES_PATH),
    referenceFile: path.relative(ROOT, REFERENCE),
    node: process.version,
    reference,
    total: results.length,
    passed: results.filter(r => r.status === 'PASS').length,
    failed: results.filter(r => r.status === 'FAIL').length,
    vetoCount: results.filter(r => r.veto).length,
    byCategory,
    categoryMinimums: data.meta.categoryMinimums,
    results
  };
  fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify(summary, null, 2), 'utf8');
  fs.writeFileSync(path.join(OUT_DIR, 'audit.jsonl'), results.flatMap(r => r.audit).map(a => JSON.stringify(a)).join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(ROOT, 'runs', 'latest-cases.json'), JSON.stringify(summary, null, 2), 'utf8');

  const lines = [];
  lines.push('# 经贸专项用例测试报告');
  lines.push('');
  lines.push(`生成时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（Asia/Shanghai）`);
  lines.push(`用例文件：\`${path.relative(ROOT, CASES_PATH)}\``);
  lines.push(`独立参考：\`${path.relative(ROOT, REFERENCE)}\`（Python Decimal，与待测实现分离）`);
  lines.push('');
  lines.push(`**总计 ${summary.total} 条；通过 ${summary.passed} 条；失败 ${summary.failed} 条；否决 ${summary.vetoCount} 条。**`);
  lines.push('');
  lines.push('| 类型 | 用例数 | 通过 | 否决 | 最低要求 | 是否达到 |');
  lines.push('|---|---:|---:|---:|---:|---|');
  for (const [category, count] of Object.entries(byCategory)) {
    const min = data.meta.categoryMinimums[category] ?? 0;
    lines.push(`| ${category} | ${count.total} | ${count.pass} | ${count.veto} | ${min} | ${count.total >= min ? '是' : '否'} |`);
  }
  lines.push('');
  lines.push('## 用例明细');
  lines.push('');
  lines.push('| 编号 | 用例 | 结果 | 得分 | 检查项 | 否决 | 失败项 |');
  lines.push('|---|---|---|---:|---:|---|---|');
  for (const r of results) {
    const firstFailure = r.failures[0] ? `${r.failures[0].name}（${r.failures[0].detail ?? ''}）` : '';
    lines.push(`| ${r.id} | ${r.title} | ${r.status} | ${(r.score * 100).toFixed(1)}% | ${r.checksPassed}/${r.checksTotal} | ${r.veto ? '是' : '否'} | ${firstFailure.replace(/\|/g, '\\|')} |`);
  }
  lines.push('');
  lines.push('## 说明');
  lines.push('');
  lines.push('- 本报告为“工具与状态流程”层，使用模拟模型响应（规则抽取），不代表接入真实模型后的生成质量。');
  lines.push('- 金额断言同时对照 `tests/reference_calc.py` 的独立 Decimal 实现；任何金额不一致都会标记否决。');
  lines.push('- 每条用例的完整检查项、回答原文和执行记录见 `results.json` 与 `audit.jsonl`。');
  lines.push('');
  fs.writeFileSync(path.join(OUT_DIR, 'report.md'), lines.join('\n'), 'utf8');
  fs.writeFileSync(path.join(ROOT, 'runs', 'latest-cases.md'), lines.join('\n'), 'utf8');
  console.log(`\n${summary.passed}/${summary.total} passed, ${summary.vetoCount} veto -> ${OUT_DIR}`);
  if (summary.failed || summary.vetoCount) process.exitCode = 1;
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
