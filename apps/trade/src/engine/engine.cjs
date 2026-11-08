'use strict';
const crypto = require('node:crypto');
const C = require('./constants.cjs');
const D = require('./decimal.cjs');
const T = require('./tools.cjs');
const S = require('./state.cjs');
const P = require('./parser.cjs');
const N = require('./narration.cjs');
const X = require('./summarize.cjs');

const EXAMPLE_VALUES = {
  FOB: { priceTerm: 'FOB', quantity: '100', quantityUnit: '件', currency: 'USD', unitPrice: '10', freight: '100', insurance: '10', fx: '7', dutyRate: '10', vatRate: '13', domesticFees: '0', exciseRate: '0' },
  CIF: { priceTerm: 'CIF', quantity: '100', quantityUnit: '件', currency: 'USD', totalPrice: '1080', fx: '7', dutyRate: '10', vatRate: '13', domesticFees: '0', exciseRate: '0' }
};

function turnIdFor(sessionId, turn) { return `${sessionId || 'local'}-t${turn}`; }

function displayFieldValue(scenario, field, value) {
  if (value === null || value === undefined || value === '') return '—';
  try {
    if (field === 'quantity') return `${D.format(D.parse(value), 0)} ${scenario.quantityUnit || '件'}`;
    if (field === 'priceTerm') return value;
    if (field === 'currency') return value;
    if (field === 'fx') return D.format(D.parse(value), 4);
    if (['dutyRate', 'vatRate', 'exciseRate'].includes(field)) return `${D.format(D.parse(value), 2)}%`;
    if (['unitPrice', 'totalPrice', 'freight', 'insurance', 'domesticFees'].includes(field)) return D.format(D.parse(value), 2);
  } catch {
    return String(value);
  }
  return String(value);
}

function buildLastChange(state, events, scenario) {
  const changes = events.filter(e => e.type === 'field_set' && e.scenarioId === scenario?.id);
  if (!changes.length) return null;
  const fields = changes.map(e => ({
    field: e.field,
    label: C.fieldLabel(e.field, scenario),
    from: displayFieldValue(scenario, e.field, e.from),
    to: displayFieldValue(scenario, e.field, e.to),
    fromRaw: e.from,
    toRaw: e.to,
    source: e.source
  }));
  return {
    count: fields.length,
    fields,
    field: fields[0].field,
    label: fields[0].label,
    from: fields[0].from,
    to: fields[0].to
  };
}

function ensureScenario(state, now) {
  let scenario = S.activeScenario(state);
  if (!scenario) {
    scenario = S.createScenario(state, { id: 'A', label: '方案 A', now });
    state.activeScenarioId = scenario.id;
    S.recordEvent(state, { type: 'scenario_created', scenarioId: scenario.id, label: scenario.label }, now);
    S.touch(state, now);
  }
  return scenario;
}

function applyExampleValues(state, scenario, now) {
  const term = scenario.priceTerm || 'FOB';
  const example = EXAMPLE_VALUES[term] || EXAMPLE_VALUES.FOB;
  const before = state.events.length;
  const slots = [];
  for (const [field, value] of Object.entries(example)) {
    if (field === 'quantityUnit') {
      if (!scenario.quantityUnit) scenario.quantityUnit = value;
      continue;
    }
    const current = field === 'priceTerm' ? scenario.priceTerm : (field === 'currency' ? scenario.currency : scenario.input[field]);
    if (current === undefined || current === null || current === '') {
      slots.push({ field, value, quantityUnit: field === 'quantity' ? example.quantityUnit : undefined, quote: '示例值（标准教学案例）', note: '演示用示例值，来自标准教学案例，可修改' });
    }
  }
  const applied = S.applySlots(state, scenario, slots, { now });
  for (const a of applied.applied) {
    scenario.meta[a.field] = { ...scenario.meta[a.field], source: 'example', note: '演示用示例值，可修改' };
  }
  state.lastChange = buildLastChange(state, state.events.slice(before), scenario);
  if (state.lastChange) for (const f of state.lastChange.fields) f.source = 'example';
  return applied;
}

function toolCall(name, inputSummary, output, extra = {}) {
  return {
    name,
    ok: Boolean(output?.ok),
    code: output?.code || (output?.ok ? 'ok' : 'error'),
    input: inputSummary,
    output: {
      ok: Boolean(output?.ok),
      code: output?.code || (output?.ok ? 'ok' : 'error'),
      ...(output?.ok ? (extra.summary || {}) : { message: output?.message || output?.validation?.errors?.[0]?.message || '' })
    }
  };
}

async function propose(model, text, state) {
  if (!model) return { proposal: P.extractTradeProposal(text, state), modelMode: 'simulated' };
  let raw;
  if (typeof model.propose === 'function') raw = await model.propose({ text, state });
  else if (typeof model === 'function') raw = await model({ text, state });
  else return { proposal: P.extractTradeProposal(text, state), modelMode: 'simulated' };
  return { proposal: raw, modelMode: model.name || 'model' };
}

function normalizeProposal(proposal) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    return { intent: 'invalid', slots: [], errors: [{ field: null, code: 'invalid_proposal', message: '模型返回的参数结构无法识别。' }], flags: {}, notes: [], model: {} };
  }
  const slots = Array.isArray(proposal.slots) ? proposal.slots.filter(s => s && typeof s === 'object' && typeof s.field === 'string' && (typeof s.value === 'string' || typeof s.value === 'number')) : [];
  const dropped = Array.isArray(proposal.slots) ? proposal.slots.length - slots.length : 0;
  const errors = Array.isArray(proposal.errors) ? proposal.errors : [];
  if (dropped > 0) errors.push({ field: null, code: 'invalid_slot_shape', message: `有 ${dropped} 个参数提案的格式不合法，已拒绝执行。` });
  const knownIntents = ['calculate', 'update', 'new_scenario', 'compare', 'sensitivity', 'export', 'explain', 'resume', 'cancel', 'restore_fx', 'campus', 'unknown', 'invalid'];
  const intent = knownIntents.includes(proposal.intent) ? proposal.intent : 'invalid';
  if (intent === 'invalid') errors.push({ field: null, code: 'invalid_intent', message: '模型给出的意图不在允许范围内，已拒绝执行。' });
  return {
    intent,
    slots,
    term: proposal.term || null,
    flags: proposal.flags || {},
    errors,
    notes: Array.isArray(proposal.notes) ? proposal.notes : [],
    model: proposal.model || {},
    text: proposal.text || ''
  };
}

function resolvePendingFxTarget(state, text) {
  const pending = state.pending;
  if (!pending || pending.kind !== 'fx_target') return null;
  const bare = P.bareNumber(text);
  if (!bare) return null;
  const value = D.formatFixed(D.parse(bare.value), 4);
  state.pending = null;
  return value;
}

function resolvePendingRestore(state, text) {
  const pending = state.pending;
  if (!pending || pending.kind !== 'fx_restore_choice') return null;
  const option = P.ordinalChoice(text);
  if (option === null) {
    const bare = P.bareNumber(text);
    if (bare) {
      const value = D.formatFixed(D.parse(bare.value), 4);
      const hit = pending.options.find(o => o.value === value);
      if (hit) { state.pending = null; return hit.value; }
    }
    return null;
  }
  const hit = pending.options[option];
  if (!hit) return null;
  state.pending = null;
  return hit.value;
}

function resolvePendingField(state, text) {
  const pending = state.pending;
  if (!pending || pending.kind !== 'field') return null;
  if (P.isCampus(P.normalizeText(text))) return null;
  const bare = P.bareNumber(text);
  if (!bare) return null;
  const field = pending.field;
  const scenario = S.getScenario(state, pending.scenarioId) || S.activeScenario(state);
  if (!scenario || !C.FIELDS[field]) return null;
  const slot = { field, value: bare.value, quote: `补答：${bare.unit || bare.value}`, note: '回答上一轮的追问' };
  if (field === 'quantity') slot.quantityUnit = scenario.quantityUnit || '件';
  if (field === 'currency') slot.value = P.findCurrency(text) || bare.unit || bare.value;
  if (field === 'priceTerm') {
    const term = P.findTerm(text);
    if (!term) return null;
    slot.value = term;
  }
  if (['dutyRate', 'vatRate'].includes(field) && !String(bare.unit || '').includes('%')) slot.note = '按百分数理解（上一轮问的是税率）';
  state.pending = null;
  return { intent: 'calculate', slots: [slot], flags: {}, errors: [], notes: ['上一轮追问的补答'], model: { mode: 'simulated', name: 'pending-resolver' } };
}

function persistResult(scenario) {
  const r = T.calculateImportOutlay(scenario);
  if (r.ok) {
    scenario.result = r;
    scenario.resultStale = false;
  } else if (scenario.result) {
    scenario.resultStale = true;
  }
  return r;
}

function finalize(state, payload, now) {
  const scenario = S.activeScenario(state);
  const result = scenario?.result && !scenario.resultStale ? scenario.result : null;
  const isSensitivity = payload.comparison?.kind === 'sensitivity';
  // 对比卡是“当前状态的视图”：即使本轮是导出或解释，只要存在两个完整方案就继续展示
  let comparison = payload.comparison || null;
  if (!comparison && !isSensitivity) {
    const complete = S.complete(state);
    if (complete.length >= 2) {
      const c = T.compareTradeScenarios({ scenarios: complete, baselineId: complete[0].id });
      comparison = c.ok ? { kind: 'scenarios', ...c } : { kind: 'compare_failed', ...c };
    }
  }
  const cards = {
    conditions: N.buildConditionsCard(state),
    result: result ? N.buildResultCard(state) : null,
    basis: N.buildBasisCard(state, result),
    learning: N.buildLearningCard(result),
    comparison: isSensitivity ? null : comparison,
    sensitivity: isSensitivity ? payload.comparison : (payload.sensitivity || null),
    export: payload.export || null
  };
  return {
    ...payload,
    state,
    cards,
    updatedAt: new Date(now).toISOString()
  };
}

async function handleTurn({ text, state: incoming, sessionId = 'local', model = null, now = Date.now() } = {}) {
  const t0 = process.hrtime.bigint();
  const state = S.cloneState(incoming && incoming.schema === S.STATE_SCHEMA ? incoming : S.createState(now));
  const turnEventsStart = state.events.length;
  state.turn = (state.turn || 0) + 1;
  state.lastChange = null;
  state.pending = state.pending || null;
  const steps = [];
  const toolCalls = [];
  const beforeVersion = state.version;
  const turnId = turnIdFor(sessionId, state.turn);
  const rawText = String(text || '').trim();
  steps.push({ step: 'input', text: rawText.slice(0, 200) });

  if (!rawText) {
    return finalize(state, {
      turnId, sessionId, answer: '请先输入一个问题，例如“帮我算一下这批进口商品的成本”。', detail: null, pet: { mood: 'idle', text: '等你开口' }, actions: N.defaultActions(state), toolCalls, mode: '输入为空', phase: state.phase, audit: { steps, durationMs: Number(process.hrtime.bigint() - t0) / 1e6, beforeVersion, afterVersion: state.version }
    }, now);
  }

  // 内部动作：为演示补齐示例值（显式标注来源，不覆盖用户已填内容）
  if (text === '__example_fill__') {
    const scenario = ensureScenario(state, now);
    const applied = applyExampleValues(state, scenario, now);
    const validation = T.validateTradeInputs(scenario);
    toolCalls.push(toolCall('validate_trade_inputs', { scenarioId: scenario.id }, validation, { summary: { missing: validation.missing.length, errors: validation.errors.length } }));
    steps.push({ step: 'example_fill', applied: applied.applied.map(a => a.field), source: 'example' });
    if (validation.ok) {
      const r = persistResult(scenario);
      state.phase = 'calculated';
      toolCalls.push(toolCall('calculate_import_outlay', { scenarioId: scenario.id }, r, { summary: { outlay: r.amounts?.outlay?.value, perUnit: r.amounts?.perUnit?.value } }));
      return finalize(state, {
        turnId, sessionId,
        answer: `为了让你快速看到完整结果，我按标准教学案例填入了缺失参数，并在条件卡里标成“示例值”（可逐项修改）。${N.resultAnswer(scenario, r, state)}`,
        detail: N.resultDetail(scenario, r),
        pet: { mood: 'cheer', text: '示例值已填入' },
        actions: N.defaultActions(state),
        toolCalls,
        mode: '示例值补齐 + 确定性工具',
        phase: state.phase,
        audit: { steps, durationMs: Number(process.hrtime.bigint() - t0) / 1e6, beforeVersion, afterVersion: state.version }
      }, now);
    }
    return finalize(state, {
      turnId, sessionId, answer: N.clarificationAnswer(state, validation, scenario), detail: null,
      pet: { mood: 'remind', text: `还差 ${validation.missing.length} 个参数` }, actions: N.defaultActions(state), toolCalls,
      mode: '示例值补齐', phase: 'collecting', audit: { steps, durationMs: Number(process.hrtime.bigint() - t0) / 1e6, beforeVersion, afterVersion: state.version }
    }, now);
  }

  // 1) 模型（或模拟模型）给出参数提案。失败时保留用户状态。
  let proposal;
  let modelMode = 'simulated';
  try {
    const proposed = await propose(model, rawText, state);
    proposal = normalizeProposal(proposed.proposal);
    modelMode = proposed.modelMode;
    steps.push({ step: 'model_proposal', provider: modelMode, intent: proposal.intent, slots: proposal.slots.map(s => ({ field: s.field, value: s.value, basis: s.basis || 'lot' })), errors: proposal.errors.map(e => e.code) });
  } catch (err) {
    steps.push({ step: 'model_error', code: err?.code || 'model_unavailable', message: String(err?.message || err).slice(0, 200) });
    return finalize(state, {
      turnId, sessionId,
      answer: '这次没有收到模型响应，所以没有改动任何参数。你已填写的条件都保留着；可以直接重试，或改用“填入示例值”继续演示。',
      detail: null,
      pet: { mood: 'alert', text: '模型暂时没响应' },
      actions: [{ id: 'retry', label: '重试这次输入', text: rawText, kind: 'send', primary: true }, { id: 'example', label: '填入示例值', text: '填入示例值', kind: 'example' }, ...N.defaultActions(state)],
      toolCalls,
      mode: '模型不可用 · 状态已保留',
      phase: state.phase,
      error: { code: 'model_unavailable', message: String(err?.message || err) },
      audit: { steps, durationMs: Number(process.hrtime.bigint() - t0) / 1e6, beforeVersion, afterVersion: state.version }
    }, now);
  }

  // 2) 程序侧校验提案结构：未知字段、非法意图直接拒绝
  const schemaErrors = [];
  const allowedFields = new Set(Object.keys(C.FIELDS));
  const slots = [];
  for (const slot of proposal.slots) {
    if (!allowedFields.has(slot.field)) schemaErrors.push({ field: slot.field, code: 'unknown_field', message: `提案包含不支持的参数：${slot.field}` });
    else if (slot.value === undefined || slot.value === null || String(slot.value) === '') schemaErrors.push({ field: slot.field, code: 'empty_value', message: `${C.FIELDS[slot.field].label}缺少数值` });
    else slots.push(slot);
  }
  proposal.slots = slots;
  proposal.errors = [...proposal.errors, ...schemaErrors];
  if (proposal.errors.length) steps.push({ step: 'proposal_rejected', errors: proposal.errors.map(e => ({ field: e.field, code: e.code })) });

  // 3) 处理“上一轮追问的补答”和“二选一确认”
  const restoredChoice = resolvePendingRestore(state, rawText);
  if (restoredChoice) {
    const scenario = S.activeScenario(state);
    const before = scenario.input.fx;
    S.touch(state, now);
    S.setField(state, scenario, 'fx', restoredChoice, { source: 'user', quote: `选择恢复 ${restoredChoice}` }, now);
    state.lastChange = buildLastChange(state, state.events.slice(turnEventsStart), scenario);
    const r = persistResult(scenario);
    steps.push({ step: 'restore_choice', value: restoredChoice });
    return finalize(state, {
      turnId, sessionId,
      answer: N.restoreAnswer(state, { from: displayFieldValue(scenario, 'fx', before), value: displayFieldValue(scenario, 'fx', restoredChoice), basis: '你刚刚在候选中做了选择' }, r),
      detail: r.ok ? N.resultDetail(scenario, r) : null,
      pet: { mood: 'cheer', text: '汇率已恢复' },
      actions: N.defaultActions(state), toolCalls,
      mode: '状态恢复', phase: r.ok ? 'calculated' : 'collecting',
      audit: { steps, durationMs: Number(process.hrtime.bigint() - t0) / 1e6, beforeVersion, afterVersion: state.version }
    }, now);
  }

  // 补答“想看哪个汇率？”：下一轮的裸数字直接作为试算目标
  if (state.pending?.kind === 'fx_target') {
    const target = resolvePendingFxTarget(state, rawText);
    if (target) {
      proposal = {
        intent: 'sensitivity',
        slots: [{ field: 'fx', value: target, quote: `补答目标汇率 ${target}`, note: '回答上一轮的汇率追问' }],
        flags: {}, errors: [], notes: ['上一轮的汇率目标'], model: { mode: 'simulated', name: 'pending-resolver' }
      };
    }
  }
  if (proposal.slots.length) state.pending = null;

  if (!proposal.slots.length && !proposal.errors.length) {
    const pendingField = resolvePendingField(state, rawText);
    if (pendingField) proposal = { ...proposal, ...pendingField, intent: 'calculate' };
  }

  // 4) 校园问题：暂停经贸流程，保留状态
  if (proposal.intent === 'campus') {
    S.pauseForCampus(state, now);
    steps.push({ step: 'state_transition', type: 'pause', phase: state.phase });
    return finalize(state, {
      turnId, sessionId,
      answer: N.campusAnswer(state), detail: null,
      pet: { mood: 'idle', text: '已暂停经贸计算' },
      actions: N.defaultActions(state), toolCalls,
      mode: '校园问题 · 经贸流程已暂停', phase: state.phase,
      audit: { steps, durationMs: Number(process.hrtime.bigint() - t0) / 1e6, beforeVersion, afterVersion: state.version }
    }, now);
  }

  // 5) 取消
  if (proposal.intent === 'cancel') {
    const cleared = S.createState(now);
    cleared.version = state.version + 1;
    cleared.turn = state.turn;
    S.recordEvent(cleared, { type: 'cancel', previousScenarios: state.scenarios.map(s => s.id) }, now);
    steps.push({ step: 'state_transition', type: 'cancel' });
    return finalize(cleared, {
      turnId, sessionId,
      answer: N.cancelAnswer(), detail: null,
      pet: { mood: 'idle', text: '已清空' },
      actions: N.defaultActions(cleared), toolCalls,
      mode: '已取消', phase: 'idle',
      audit: { steps, durationMs: Number(process.hrtime.bigint() - t0) / 1e6, beforeVersion, afterVersion: cleared.version }
    }, now);
  }

  // 6) 恢复被暂停的案例
  if (proposal.intent === 'resume') {
    if (state.phase !== 'paused') {
      return finalize(state, {
        turnId, sessionId, answer: state.scenarios.length ? '我们现在就在经贸案例里，继续说你想改的条件就好。' : '现在还没有可以恢复的案例。我们先从商品数量和报价开始。',
        detail: null, pet: { mood: 'idle', text: '案例在线' }, actions: N.defaultActions(state), toolCalls,
        mode: '恢复案例', phase: state.phase,
        audit: { steps, durationMs: Number(process.hrtime.bigint() - t0) / 1e6, beforeVersion, afterVersion: state.version }
      }, now);
    }
    S.resumeTrade(state, now);
    const scenario = S.activeScenario(state);
    const v = scenario ? T.validateTradeInputs(scenario) : null;
    steps.push({ step: 'state_transition', type: 'resume', phase: state.phase });
    return finalize(state, {
      turnId, sessionId, answer: N.resumeAnswer(state), detail: v?.ok && scenario.result ? N.resultDetail(scenario, scenario.result) : null,
      pet: { mood: 'cheer', text: '案例已恢复' }, actions: N.defaultActions(state), toolCalls,
      mode: '恢复案例', phase: state.phase,
      audit: { steps, durationMs: Number(process.hrtime.bigint() - t0) / 1e6, beforeVersion, afterVersion: state.version }
    }, now);
  }

  // 7) 恢复历史汇率（有明确状态依据；多候选项时要求确认）
  if (proposal.intent === 'restore_fx') {
    const restore = S.resolveRestoreFx(state);
    if (restore.kind === 'none') {
      return finalize(state, {
        turnId, sessionId, answer: restore.reason, detail: null,
        pet: { mood: 'remind', text: '没有可恢复的汇率' }, actions: N.defaultActions(state), toolCalls,
        mode: '恢复汇率', phase: state.phase,
        audit: { steps, durationMs: Number(process.hrtime.bigint() - t0) / 1e6, beforeVersion, afterVersion: state.version }
      }, now);
    }
    if (restore.kind === 'ambiguous') {
      state.pending = { kind: 'fx_restore_choice', scenarioId: state.activeScenarioId, options: restore.options, current: restore.current, askedAtTurn: state.turn };
      const optionsText = restore.options.map((o, i) => `${i === 0 ? '第一个' : i === 1 ? '第二个' : '第三个'} ${o.value}（第 ${o.turn ?? '—'} 轮）`).join('；');
      steps.push({ step: 'clarification', type: 'fx_restore_choice', options: restore.options.map(o => o.value) });
      return finalize(state, {
        turnId, sessionId,
        answer: `“原来的汇率”有多个候选，需要你确认：${optionsText}。当前汇率是 ${restore.current}。回复“第一个/第二个”，或直接给出目标汇率。`,
        detail: null,
        pet: { mood: 'remind', text: '有两个历史汇率' },
        actions: restore.options.map((o, i) => ({ id: `fx-opt-${i}`, label: o.value, text: i === 0 ? '第一个' : '第二个', kind: 'send' })),
        toolCalls, mode: '指代存在歧义 · 等待确认', phase: state.phase,
        audit: { steps, durationMs: Number(process.hrtime.bigint() - t0) / 1e6, beforeVersion, afterVersion: state.version }
      }, now);
    }
    const scenario = S.activeScenario(state);
    const before = scenario.input.fx;
    S.touch(state, now);
    S.setField(state, scenario, 'fx', restore.value, { source: 'user', quote: '恢复原来的汇率' }, now);
    state.lastChange = buildLastChange(state, state.events.slice(turnEventsStart), scenario);
    const r = persistResult(scenario);
    toolCalls.push(toolCall('calculate_import_outlay', { scenarioId: scenario.id, trigger: 'restore_fx' }, r, { summary: { outlay: r.amounts?.outlay?.value, perUnit: r.amounts?.perUnit?.value } }));
    steps.push({ step: 'state_transition', type: 'restore_fx', from: before, to: restore.value });
    state.phase = r.ok ? 'calculated' : 'collecting';
    return finalize(state, {
      turnId, sessionId,
      answer: N.restoreAnswer(state, { from: displayFieldValue(scenario, 'fx', before), value: displayFieldValue(scenario, 'fx', restore.value), basis: restore.basis }, r),
      detail: r.ok ? N.resultDetail(scenario, r) : null,
      pet: { mood: 'cheer', text: '汇率已恢复' },
      actions: N.defaultActions(state), toolCalls,
      mode: '状态恢复 + 确定性工具', phase: state.phase,
      audit: { steps, durationMs: Number(process.hrtime.bigint() - t0) / 1e6, beforeVersion, afterVersion: state.version }
    }, now);
  }

  // 8) 敏感度分析（不修改原方案）
  if (proposal.intent === 'sensitivity') {
    const scenario = S.activeScenario(state);
    if (!scenario) {
      return finalize(state, {
        turnId, sessionId, answer: '还没有可以试算的方案。先告诉我数量、报价口径和单价或总价。', detail: null,
        pet: { mood: 'remind', text: '先建一个方案' }, actions: N.defaultActions(state), toolCalls,
        mode: '汇率试算', phase: state.phase,
        audit: { steps, durationMs: Number(process.hrtime.bigint() - t0) / 1e6, beforeVersion, afterVersion: state.version }
      }, now);
    }
    // 汇率试算不修改原方案：这里只读取 fx 目标值，其余条件保持不变。
    const validation = T.validateTradeInputs(scenario);
    toolCalls.push(toolCall('validate_trade_inputs', { scenarioId: scenario.id }, validation, { summary: { missing: validation.missing.length, errors: validation.errors.length } }));
    if (!validation.ok) {
      state.pending = (!validation.errors.length && validation.missing.length)
        ? { kind: 'field', field: validation.missing[0].field, label: validation.missing[0].label, scenarioId: scenario.id, askedAtTurn: state.turn }
        : null;
      return finalize(state, {
        turnId, sessionId, answer: N.clarificationAnswer(state, validation, scenario), detail: null,
        pet: { mood: 'remind', text: validation.errors.length ? `有 ${validation.errors.length} 项需要修正` : `还差 ${validation.missing.length} 个参数` }, actions: N.defaultActions(state), toolCalls,
        mode: '参数待补齐', phase: 'collecting',
        audit: { steps, durationMs: Number(process.hrtime.bigint() - t0) / 1e6, beforeVersion, afterVersion: state.version }
      }, now);
    }
    const fxSlot = proposal.slots.find(s => s.field === 'fx');
    const targetFromPending = resolvePendingFxTarget(state, rawText);
    const targets = [];
    if (fxSlot) targets.push(D.formatFixed(D.parse(fxSlot.value), 4));
    else if (targetFromPending) targets.push(targetFromPending);
    if (!targets.length) {
      const current = D.formatFixed(D.parse(scenario.input.fx), 4);
      const up = D.formatFixed(D.mul(D.parse(scenario.input.fx), D.parse('1.1')), 4);
      const down = D.formatFixed(D.mul(D.parse(scenario.input.fx), D.parse('0.9')), 4);
      state.pending = { kind: 'fx_target', scenarioId: scenario.id, askedAtTurn: state.turn };
      return finalize(state, {
        turnId, sessionId,
        answer: `想看哪个汇率？当前是 ${current}。例如 ${up}（+10%）或 ${down}（−10%），也可以直接说“7.2”。我不会改动原方案，只做试算。`,
        detail: null,
        pet: { mood: 'remind', text: '等你给目标汇率' },
        actions: [{ id: 'fx-up', label: `试算 ${up}`, text: `如果汇率涨到 ${up} 呢？`, kind: 'send' }, { id: 'fx-down', label: `试算 ${down}`, text: `如果汇率跌到 ${down} 呢？`, kind: 'send' }],
        toolCalls, mode: '汇率试算 · 等待目标值', phase: state.phase,
        audit: { steps, durationMs: Number(process.hrtime.bigint() - t0) / 1e6, beforeVersion, afterVersion: state.version }
      }, now);
    }
    const sens = T.analyzeExchangeSensitivity({ scenario, fxValues: targets });
    toolCalls.push(toolCall('analyze_exchange_sensitivity', { scenarioId: scenario.id, fxValues: targets }, sens, { summary: { points: sens.points?.length, elasticity: sens.elasticity } }));
    if (!sens.ok) {
      return finalize(state, {
        turnId, sessionId, answer: sens.message || '这次汇率试算没有完成，参数已保留。', detail: null,
        pet: { mood: 'alert', text: '试算未完成' }, actions: N.defaultActions(state), toolCalls,
        mode: '工具异常 · 状态已保留', phase: state.phase,
        audit: { steps, durationMs: Number(process.hrtime.bigint() - t0) / 1e6, beforeVersion, afterVersion: state.version }
      }, now);
    }
    steps.push({ step: 'tool_call', name: 'analyze_exchange_sensitivity', points: sens.points.length });
    const fxText = D.format(D.parse(targets[0]), 2);
    return finalize(state, {
      turnId, sessionId,
      answer: N.sensitivityAnswer(sens, state),
      detail: N.sensitivityDetail(sens),
      pet: { mood: 'cheer', text: '汇率试算完成' },
      actions: [{ id: 'commit-fx', label: `按 ${fxText} 重算`, text: `按 ${fxText} 重算`, kind: 'send', primary: true }, { id: 'compare', label: '比较第二个报价', text: '另一个供应商报 CIF 总价 1,080 美元，其他条件一样，哪个支出更低？', kind: 'send' }, { id: 'export', label: '导出摘要', text: '把两种方案整理成一份摘要', kind: 'export' }],
      comparison: { kind: 'sensitivity', ...sens },
      toolCalls,
      mode: '汇率敏感性分析（不改变原方案）',
      phase: state.phase,
      audit: { steps, durationMs: Number(process.hrtime.bigint() - t0) / 1e6, beforeVersion, afterVersion: state.version }
    }, now);
  }

  // 9) 新建可比方案（切换供应商）
  if (proposal.intent === 'new_scenario') {
    const source = S.activeScenario(state);
    const id = S.nextScenarioId(state);
    const term = proposal.term || null;
    const scenario = S.createScenario(state, {
      id,
      label: `方案 ${id}`,
      parentScenarioId: source?.id || null,
      priceTerm: term,
      currency: source?.currency || null,
      quantityUnit: source?.quantityUnit || '件',
      now
    });
    state.activeScenarioId = scenario.id;
    const eventsStart = state.events.length;
    if (proposal.flags?.inherit && source) S.copyInherited(source, scenario, now);
    if (term) S.setField(state, scenario, 'priceTerm', term, { source: 'user', quote: proposal.term }, now);
    const applied = S.applySlots(state, scenario, proposal.slots.filter(s => s.field !== 'priceTerm'), { now });
    state.lastChange = buildLastChange(state, state.events.slice(eventsStart), scenario);
    steps.push({ step: 'scenario_created', id: scenario.id, parent: source?.id || null, inherited: Boolean(proposal.flags?.inherit), applied: applied.applied.map(a => a.field) });

    const validation = T.validateTradeInputs(scenario);
    toolCalls.push(toolCall('validate_trade_inputs', { scenarioId: scenario.id }, validation, { summary: { missing: validation.missing.length, errors: validation.errors.length } }));
    if (!validation.ok) {
      state.phase = 'collecting';
      state.pending = (!validation.errors.length && validation.missing.length)
        ? { kind: 'field', field: validation.missing[0].field, label: validation.missing[0].label, scenarioId: scenario.id, askedAtTurn: state.turn }
        : null;
      const prefix = source ? `已保留${source.label}，并新建${scenario.label}。` : `已新建${scenario.label}。`;
      return finalize(state, {
        turnId, sessionId, answer: `${prefix}${N.clarificationAnswer(state, validation, scenario)}`,
        detail: null, pet: { mood: 'remind', text: validation.errors.length ? `新方案有 ${validation.errors.length} 项需要修正` : `新方案还差 ${validation.missing.length} 项` },
        actions: N.defaultActions(state), toolCalls, mode: '新方案 · 补齐参数', phase: state.phase,
        audit: { steps, durationMs: Number(process.hrtime.bigint() - t0) / 1e6, beforeVersion, afterVersion: state.version }
      }, now);
    }
    const r = persistResult(scenario);
    toolCalls.push(toolCall('calculate_import_outlay', { scenarioId: scenario.id }, r, { summary: { outlay: r.amounts?.outlay?.value, perUnit: r.amounts?.perUnit?.value } }));
    let comparison = null;
    if (source) {
      const sourceValidation = T.validateTradeInputs(source);
      if (sourceValidation.ok) {
        comparison = T.compareTradeScenarios({ scenarios: [source, scenario], baselineId: source.id });
        toolCalls.push(toolCall('compare_trade_scenarios', { baselineId: source.id, scenarios: [source.id, scenario.id] }, comparison, { summary: { cheaper: comparison.cheaper?.id, diff: comparison.differences?.[0]?.diffFromBaseline } }));
      }
    }
    state.phase = comparison?.ok ? 'comparing' : 'calculated';
    const answerPrefix = `已保留${source?.label || '原方案'}，并新建${scenario.label}。`;
    const answer = `${answerPrefix}${N.resultAnswer(scenario, r, state, { change: false })}${comparison ? N.compareAnswer(comparison, state) : ''}`;
    return finalize(state, {
      turnId, sessionId, answer,
      detail: comparison
        ? `${N.resultDetail(scenario, r)}\n\n${N.compareDetail(comparison)}`
        : N.resultDetail(scenario, r),
      pet: { mood: 'cheer', text: comparison?.ok ? '两个方案已同口径比较' : '新方案已计算' },
      actions: N.defaultActions(state),
      comparison: comparison?.ok ? { kind: 'scenarios', ...comparison } : (comparison ? { kind: 'compare_failed', ...comparison } : null),
      toolCalls, mode: '新方案 + 确定性工具' + (comparison?.ok ? ' + 同口径比较' : ''), phase: state.phase,
      audit: { steps, durationMs: Number(process.hrtime.bigint() - t0) / 1e6, beforeVersion, afterVersion: state.version }
    }, now);
  }

  // 10) 比较
  if (proposal.intent === 'compare') {
    const complete = S.complete(state);
    if (complete.length < 2) {
      const scenario = S.activeScenario(state);
      const v = scenario ? T.validateTradeInputs(scenario) : null;
      const answer = v && !v.ok
        ? `要比较两个报价，先把当前方案补齐：${v.missing.map(m => m.label).join('、')}。`
        : '目前只有一个完整方案。把第二个供应商的报价告诉我，例如“另一个供应商报 CIF 总价 1,080 美元，其他条件一样”，我会保留原方案并新建一个可比较的方案。';
      return finalize(state, {
        turnId, sessionId, answer, detail: null, pet: { mood: 'remind', text: '还差一个报价' },
        actions: [{ id: 'second', label: '输入第二个报价', text: '另一个供应商报 CIF 总价 1,080 美元，其他条件一样，哪个支出更低？', kind: 'send', primary: true }, ...N.defaultActions(state)],
        toolCalls, mode: '比较 · 等待第二个方案', phase: state.phase,
        audit: { steps, durationMs: Number(process.hrtime.bigint() - t0) / 1e6, beforeVersion, afterVersion: state.version }
      }, now);
    }
    const comparison = T.compareTradeScenarios({ scenarios: complete, baselineId: state.activeScenarioId });
    toolCalls.push(toolCall('compare_trade_scenarios', { baselineId: state.activeScenarioId, scenarios: complete.map(s => s.id) }, comparison, { summary: { cheaper: comparison.cheaper?.id, diff: comparison.differences?.[0]?.diffFromBaseline } }));
    state.phase = comparison.ok ? 'comparing' : state.phase;
    return finalize(state, {
      turnId, sessionId, answer: N.compareAnswer(comparison, state), detail: N.compareDetail(comparison),
      pet: { mood: comparison.ok ? 'cheer' : 'remind', text: comparison.ok ? '对比完成' : '口径不一致' },
      actions: N.defaultActions(state),
      comparison: { kind: 'scenarios', ...comparison },
      toolCalls, mode: '同口径方案比较', phase: state.phase,
      audit: { steps, durationMs: Number(process.hrtime.bigint() - t0) / 1e6, beforeVersion, afterVersion: state.version }
    }, now);
  }

  // 11) 导出
  if (proposal.intent === 'export') {
    const complete = S.complete(state);
    if (!complete.length) {
      const scenario = S.activeScenario(state);
      const v = scenario ? T.validateTradeInputs(scenario) : null;
      return finalize(state, {
        turnId, sessionId,
        answer: v && !v.ok ? `还不能导出：${v.missing.map(m => m.label).join('、')} 还没补齐。补齐后我会把输入、公式、结果、假设和来源一起生成摘要。` : '还没有可导出的完整方案。先说“帮我算进口成本”开始。',
        detail: null, pet: { mood: 'remind', text: '还差参数才能导出' }, actions: N.defaultActions(state), toolCalls,
        mode: '导出 · 参数不足', phase: state.phase,
        audit: { steps, durationMs: Number(process.hrtime.bigint() - t0) / 1e6, beforeVersion, afterVersion: state.version }
      }, now);
    }
    // 导出前逐方案重算，避免导出与页面当前方案不一致
    let staleFound = false;
    for (const s of complete) {
      const fresh = T.calculateImportOutlay(s);
      if (!fresh.ok) continue;
      if (!s.result || s.result.hash !== fresh.hash || s.result.inputHash !== fresh.inputHash) {
        s.result = fresh;
        s.resultStale = false;
        staleFound = true;
      }
    }
    if (staleFound) steps.push({ step: 'recalculate_before_export', reason: '导出前一致性核对' });
    const formats = ['markdown', 'html', 'json'];
    const outputs = {};
    for (const fmt of formats) {
      const built = X.buildCaseSummary(state, fmt, now);
      if (!built.ok) {
        toolCalls.push({ name: 'export_case_summary', ok: false, code: built.code, input: { format: fmt }, output: { ok: false, code: built.code, message: built.message } });
        return finalize(state, {
          turnId, sessionId, answer: built.message || '导出没有完成，参数已保留。', detail: null,
          pet: { mood: 'alert', text: '导出未完成' }, actions: N.defaultActions(state), toolCalls,
          mode: '工具异常 · 导出失败', phase: state.phase,
          audit: { steps, durationMs: Number(process.hrtime.bigint() - t0) / 1e6, beforeVersion, afterVersion: state.version }
        }, now);
      }
      outputs[fmt] = built;
      toolCalls.push({ name: 'export_case_summary', ok: true, code: 'ok', input: { format: fmt, stateVersion: state.version }, output: { ok: true, code: 'ok', filename: built.filename, checksum: built.checksum.slice(0, 16), bytes: built.bytes } });
    }
    const primary = outputs.markdown;
    state.phase = 'exported';
    state.exports.push({ at: new Date(now).toISOString(), stateVersion: state.version, checksum: primary.checksum, scenarios: primary.scenarioIds, filename: primary.filename });
    if (state.exports.length > 10) state.exports.shift();
    steps.push({ step: 'export', stateVersion: state.version, checksum: primary.checksum.slice(0, 16), formats });
    return finalize(state, {
      turnId, sessionId,
      answer: N.exportAnswer(primary, state),
      detail: `导出包含：${primary.scenarioIds.join('、')} 的输入条件、公式代入、结果明细、方案对比（如有）、假设、未计入项目、来源与复算指纹。状态版本 v${state.version}。`,
      pet: { mood: 'cheer', text: '摘要已生成' },
      actions: [
        { id: 'download-md', label: '下载 Markdown', kind: 'download', format: 'markdown', primary: true },
        { id: 'download-html', label: '下载 HTML', kind: 'download', format: 'html' },
        { id: 'download-json', label: '下载 JSON', kind: 'download', format: 'json' },
        ...N.defaultActions(state)
      ],
      export: {
        primary: { filename: primary.filename, checksum: primary.checksum, bytes: primary.bytes, stateVersion: state.version, scenarioIds: primary.scenarioIds },
        formats: Object.fromEntries(Object.entries(outputs).map(([k, v]) => [k, { filename: v.filename, checksum: v.checksum, bytes: v.bytes, mime: v.mime, content: v.content }])),
        preview: primary.content
      },
      toolCalls,
      mode: '导出案例摘要（导出前重算核对）', phase: state.phase,
      audit: { steps, durationMs: Number(process.hrtime.bigint() - t0) / 1e6, beforeVersion, afterVersion: state.version }
    }, now);
  }

  // 12) 解释
  if (proposal.intent === 'explain') {
    const scenario = S.activeScenario(state);
    if (!scenario?.result || scenario.resultStale) {
      const v = scenario ? T.validateTradeInputs(scenario) : null;
      return finalize(state, {
        turnId, sessionId,
        answer: v && !v.ok ? `现在还没有完整结果：${v.missing.map(m => m.label).join('、')} 还缺。补齐后我把每一步公式代入给你看。` : '现在还没有可解释的计算结果。先让我算一次，再说“为什么”。',
        detail: null, pet: { mood: 'remind', text: '先算一次' }, actions: N.defaultActions(state), toolCalls,
        mode: '解释 · 暂无结果', phase: state.phase,
        audit: { steps, durationMs: Number(process.hrtime.bigint() - t0) / 1e6, beforeVersion, afterVersion: state.version }
      }, now);
    }
    const r = scenario.result;
    return finalize(state, {
      turnId, sessionId,
      answer: N.resultAnswer(scenario, r, state) + '下面把每一步拆开，你可以逐行复算。',
      detail: N.resultDetail(scenario, r),
      pet: { mood: 'cheer', text: '依据已展开' },
      actions: N.defaultActions(state), toolCalls,
      mode: '解释计算结果', phase: state.phase,
      audit: { steps, durationMs: Number(process.hrtime.bigint() - t0) / 1e6, beforeVersion, afterVersion: state.version }
    }, now);
  }

  // 13) 默认：计算或更新
  const scenario = ensureScenario(state, now);
  const eventsStart = state.events.length;
  if (proposal.slots.length) {
    const applied = S.applySlots(state, scenario, proposal.slots, { now });
    state.lastChange = buildLastChange(state, state.events.slice(eventsStart), scenario);
    steps.push({ step: 'state_update', applied: applied.applied.map(a => ({ field: a.field, value: a.value, source: a.meta.source })), rejected: applied.rejected.map(r => r.code) });
    if (applied.rejected.length) {
      return finalize(state, {
        turnId, sessionId, answer: applied.rejected.map(r => r.message).join(' '), detail: null,
        pet: { mood: 'remind', text: '还缺一个条件' }, actions: N.defaultActions(state), toolCalls,
        mode: '参数未通过校验', phase: state.phase,
        audit: { steps, durationMs: Number(process.hrtime.bigint() - t0) / 1e6, beforeVersion, afterVersion: state.version }
      }, now);
    }
  }

  const validation = T.validateTradeInputs(scenario);
  toolCalls.push(toolCall('validate_trade_inputs', { scenarioId: scenario.id }, validation, { summary: { missing: validation.missing.length, errors: validation.errors.length, term: validation.term?.code || null } }));
  steps.push({ step: 'validate_trade_inputs', ok: validation.ok, missing: validation.missing.map(m => m.field), errors: validation.errors.map(e => e.code) });

  const explicitErrors = proposal.errors;
  if (explicitErrors.length) {
    state.pending = null;
    state.phase = scenario.input && Object.keys(scenario.input).length ? 'collecting' : 'idle';
    const retained = state.lastChange ? `你这次填写的其他参数已保留：${state.lastChange.fields.map(f => `${f.label} ${f.to}`).join('、')}。` : '你已填写的参数都保留。';
    return finalize(state, {
      turnId, sessionId,
      answer: `${N.joinErrors(explicitErrors)} ${retained}改好这一项就能继续。`,
      detail: null,
      pet: { mood: 'remind', text: '有一项需要确认' },
      actions: N.defaultActions(state), toolCalls,
      mode: '参数校验未通过 · 状态已保留', phase: state.phase,
      error: { code: explicitErrors[0].code, fields: explicitErrors.map(e => e.field) },
      audit: { steps, durationMs: Number(process.hrtime.bigint() - t0) / 1e6, beforeVersion, afterVersion: state.version }
    }, now);
  }

  if (!validation.ok) {
    state.phase = state.scenarios.length ? 'collecting' : 'idle';
    state.pending = (!validation.errors.length && validation.missing.length)
      ? { kind: 'field', field: validation.missing[0].field, label: validation.missing[0].label, scenarioId: scenario.id, askedAtTurn: state.turn }
      : null;
    steps.push({ step: 'state_transition', type: 'collecting', missing: validation.missing.map(m => m.field), errors: validation.errors.map(e => e.code) });
    return finalize(state, {
      turnId, sessionId,
      answer: (state.lastChange ? N.changeSentence(state) + ' ' : '') + N.clarificationAnswer(state, validation, scenario),
      detail: null,
      pet: { mood: 'remind', text: validation.errors.length ? `有 ${validation.errors.length} 项需要修正` : `还差 ${validation.missing.length} 个参数` },
      actions: N.defaultActions(state), toolCalls,
      mode: '参数校验 · 追问或修正', phase: state.phase,
      error: validation.errors.length ? { code: validation.errors[0].code, fields: validation.errors.map(e => e.field) } : null,
      audit: { steps, durationMs: Number(process.hrtime.bigint() - t0) / 1e6, beforeVersion, afterVersion: state.version }
    }, now);
  }

  const r = persistResult(scenario);
  toolCalls.push(toolCall('calculate_import_outlay', { scenarioId: scenario.id, priceTerm: scenario.priceTerm, fx: scenario.input.fx }, r, { summary: { outlay: r.amounts?.outlay?.value, perUnit: r.amounts?.perUnit?.value, taxable: r.amounts?.taxableValue?.value } }));
  steps.push({ step: 'tool_call', name: 'calculate_import_outlay', ok: r.ok, outlay: r.amounts?.outlay?.value });
  state.phase = 'calculated';
  return finalize(state, {
    turnId, sessionId,
    answer: N.resultAnswer(scenario, r, state),
    detail: N.resultDetail(scenario, r),
    pet: { mood: 'cheer', text: '计算完成' },
    actions: N.defaultActions(state), toolCalls,
    mode: '模拟模型 + 确定性工具', phase: state.phase,
    audit: { steps, durationMs: Number(process.hrtime.bigint() - t0) / 1e6, beforeVersion, afterVersion: state.version }
  }, now);
}

module.exports = { handleTurn, EXAMPLE_VALUES, buildLastChange };
