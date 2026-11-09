'use strict';
const C = require('./constants.cjs');
const D = require('./decimal.cjs');
const T = require('./tools.cjs');

const STATE_SCHEMA = 'trade-demo-state-v1';
const SHARED_FIELDS = ['quantity', 'currency', 'fx', 'dutyRate', 'vatRate', 'domesticFees', 'exciseRate'];
const OFFER_FIELDS = ['unitPrice', 'totalPrice', 'freight', 'insurance'];

function nowIso(now) { return new Date(now || Date.now()).toISOString(); }

function createState(now = Date.now()) {
  return {
    schema: STATE_SCHEMA,
    version: 1,
    phase: 'idle',
    activeScenarioId: null,
    scenarios: [],
    pending: null,
    lastChange: null,
    events: [],
    resumePhase: null,
    pausedAt: null,
    turn: 0,
    exports: [],
    createdAt: nowIso(now),
    updatedAt: nowIso(now)
  };
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

function getScenario(state, id) {
  return state.scenarios.find(s => s.id === (id || state.activeScenarioId)) || null;
}

function activeScenario(state) { return getScenario(state); }

function nextScenarioId(state) {
  const used = new Set(state.scenarios.map(s => s.id));
  for (const letter of 'ABCDEFGH') if (!used.has(letter)) return letter;
  return `S${state.scenarios.length + 1}`;
}

function createScenario(state, { id, label, parentScenarioId = null, priceTerm = null, currency = null, quantityUnit = '件', input = {}, meta = {}, now = Date.now() } = {}) {
  const caseDefaults = {
    domesticFees: { value: '0', note: '教学案例约定：国内其他费用暂按 0 计' },
    exciseRate: { value: '0', note: '教学案例约定：消费税本案例不涉及' }
  };
  for (const [field, def] of Object.entries(caseDefaults)) {
    if (input[field] === undefined) {
      input[field] = def.value;
      meta[field] = { source: 'case_assumption', turn: null, quote: '', note: def.note, updatedAt: nowIso(now) };
    }
  }
  const scenario = {
    id: id || nextScenarioId(state),
    label: label || `方案 ${id || nextScenarioId(state)}`,
    createdAt: nowIso(now),
    updatedAt: nowIso(now),
    parentScenarioId,
    priceTerm,
    currency,
    quantityUnit,
    input: { ...input },
    meta: { ...meta },
    fxHistory: [],
    result: null,
    resultStale: false,
    notes: []
  };
  if (scenario.input.fx !== undefined) {
    scenario.fxHistory.push({ value: D.formatFixed(D.parse(scenario.input.fx), 4), turn: state.turn, at: nowIso(now), kind: 'set' });
  }
  state.scenarios.push(scenario);
  if (!state.activeScenarioId) state.activeScenarioId = scenario.id;
  return scenario;
}

function touch(state, now = Date.now()) {
  state.version += 1;
  state.updatedAt = nowIso(now);
}

function recordEvent(state, event, now = Date.now()) {
  state.events.push({ at: nowIso(now), version: state.version, ...event });
  if (state.events.length > 400) state.events.splice(0, state.events.length - 400);
}

function setField(state, scenario, field, value, meta = {}, now = Date.now()) {
  const before = scenario.input[field];
  const beforeTerm = scenario.priceTerm;
  if (field === 'priceTerm') {
    scenario.priceTerm = value;
  } else if (field === 'currency') {
    scenario.currency = value;
  } else if (field === 'quantity' && meta.quantityUnit) {
    scenario.quantityUnit = meta.quantityUnit;
    scenario.input.quantity = value;
  } else {
    scenario.input[field] = value;
  }
  scenario.meta[field] = {
    source: meta.source || 'user',
    turn: state.turn,
    quote: meta.quote || '',
    note: meta.note || '',
    updatedAt: nowIso(now)
  };
  if (field === 'fx') {
    const canonical = D.formatFixed(D.parse(value), 4);
    const last = scenario.fxHistory.at(-1);
    if (!last || last.value !== canonical) {
      scenario.fxHistory.push({ value: canonical, turn: state.turn, at: nowIso(now), kind: last ? 'update' : 'set', from: last?.value ?? null });
    }
  }
  scenario.updatedAt = nowIso(now);
  scenario.resultStale = Boolean(scenario.result) && (field !== 'currency');
  recordEvent(state, {
    type: 'field_set',
    scenarioId: scenario.id,
    field,
    from: field === 'priceTerm' ? beforeTerm : (before ?? null),
    to: value,
    source: meta.source || 'user',
    quote: meta.quote || ''
  }, now);
  return scenario;
}

function copyInherited(source, target, now = Date.now()) {
  const copied = [];
  for (const field of SHARED_FIELDS) {
    const value = field === 'currency' ? source.currency : source.input[field];
    if (value === undefined || value === null || value === '') continue;
    if (field === 'currency') target.currency = value;
    else target.input[field] = value;
    target.meta[field] = { source: 'inherited', turn: null, quote: '', note: `沿用${source.label}`, updatedAt: nowIso(now) };
    copied.push(field);
  }
  if (source.quantityUnit) target.quantityUnit = source.quantityUnit;
  if (source.priceTerm) {
    target.meta.priceTerm = { source: 'inherited', turn: null, quote: '', note: `沿用${source.label}的报价前提，但报价金额来自新供应商`, updatedAt: nowIso(now) };
  }
  if (target.input.fx !== undefined) {
    target.fxHistory.push({ value: D.formatFixed(D.parse(target.input.fx), 4), turn: null, at: nowIso(now), kind: 'inherited' });
  }
  target.notes.push(`共享条件沿用${source.label}：${copied.map(f => C.FIELDS[f]?.label || f).join('、')}`);
  return copied;
}

function sameValue(scenario, field, value) {
  if (field === 'priceTerm') return scenario.priceTerm === value;
  if (field === 'currency') return scenario.currency === value;
  const current = scenario.input[field];
  if (current === undefined || current === null || current === '') return false;
  try { return D.parse(current) === D.parse(value); } catch { return String(current) === String(value); }
}

function applySlots(state, scenario, slots, { now = Date.now(), allowPerUnit = true } = {}) {
  const applied = [];
  const rejected = [];
  const skipped = [];
  for (const slot of slots) {
    if (!C.FIELDS[slot.field]) {
      rejected.push({ field: slot.field, code: 'unknown_field', message: `不支持的参数：${slot.field}` });
      continue;
    }
    let value = slot.value;
    let meta = { source: 'user', quote: slot.quote, note: slot.note || '', quantityUnit: slot.quantityUnit };
    if ((slot.field === 'freight' || slot.field === 'insurance') && slot.basis === 'per_unit') {
      const qtyRaw = scenario.input.quantity ?? null;
      if (!allowPerUnit || qtyRaw === null || qtyRaw === undefined || qtyRaw === '') {
        rejected.push({
          field: slot.field,
          code: 'needs_quantity_first',
          message: `${C.FIELDS[slot.field].label}你给的是“每件金额”，需要先确定数量才能折算整批。请先告诉我商品数量。`
        });
        continue;
      }
      const batch = D.roundTo(D.mul(D.parse(value), D.parse(qtyRaw)), 2);
      meta = {
        ...meta,
        source: 'derived',
        note: `每件 ${D.format(D.parse(value), 2)} ${C.currencyInfo(scenario.currency || 'USD').unitLabel} × ${D.format(D.parse(qtyRaw), 0)} ${scenario.quantityUnit} = ${D.format(batch, 2)} ${C.currencyInfo(scenario.currency || 'USD').unitLabel}（整批）`
      };
      value = D.formatFixed(batch, 2);
    }
    if (sameValue(scenario, slot.field, value)) {
      skipped.push({ field: slot.field, value, reason: 'unchanged' });
      continue;
    }
    setField(state, scenario, slot.field, value, meta, now);
    applied.push({ field: slot.field, value, meta });
  }
  if (applied.length) touch(state, now);
  return { applied, rejected, skipped };
}

function resolveRestoreFx(state) {
  const scenario = activeScenario(state);
  if (!scenario) return { kind: 'none', reason: '当前没有经贸方案。' };
  const current = scenario.input.fx === undefined ? null : D.formatFixed(D.parse(scenario.input.fx), 4);
  if (current === null) return { kind: 'none', reason: '当前方案还没有填写汇率。' };
  const priors = [];
  for (const item of [...scenario.fxHistory].reverse()) {
    if (item.value === current) continue;
    if (!priors.some(p => p.value === item.value)) priors.push(item);
  }
  if (!priors.length) return { kind: 'none', reason: `当前汇率就是 ${current}，没有更早的汇率可以恢复。`, current };
  if (priors.length === 1) return { kind: 'restore', value: priors[0].value, from: current, basis: `根据${scenario.label} 的汇率记录：${priors[0].value}（第 ${priors[0].turn ?? '—'} 轮），之后改为 ${current}` };
  return {
    kind: 'ambiguous',
    options: priors.slice(0, 3).map(p => ({ value: p.value, turn: p.turn, at: p.at })),
    current,
    basis: `${scenario.label} 存在多个历史汇率，需要确认恢复目标。`
  };
}

function pauseForCampus(state, now = Date.now()) {
  if (state.phase === 'paused') return state;
  state.resumePhase = ['collecting', 'calculated', 'comparing', 'exported'].includes(state.phase) ? state.phase : 'collecting';
  state.phase = 'paused';
  state.pausedAt = nowIso(now);
  recordEvent(state, { type: 'campus_pause', resumePhase: state.resumePhase }, now);
  touch(state, now);
  return state;
}

function resumeTrade(state, now = Date.now()) {
  if (state.phase !== 'paused') return state;
  const scenario = activeScenario(state);
  const validation = scenario ? T.validateTradeInputs(scenario) : null;
  state.phase = state.resumePhase || (validation?.ok ? 'calculated' : 'collecting');
  state.resumePhase = null;
  state.pausedAt = null;
  recordEvent(state, { type: 'resume', phase: state.phase }, now);
  touch(state, now);
  return state;
}

function complete(state) {
  return state.scenarios.filter(s => T.validateTradeInputs(s).ok);
}

function notApplicable(scenario, field) {
  const term = scenario.priceTerm;
  if (term === 'FOB' && field === 'totalPrice') return 'FOB 按“单价×数量”计，不填总价';
  if ((term === 'CIF' || term === 'CFR') && field === 'unitPrice') return `${term} 按整批总价计，不填单价`;
  if (term === 'CIF' && field === 'freight') return 'CIF 报价已含国际运费';
  if (term === 'CIF' && field === 'insurance') return 'CIF 报价已含保险费';
  if (term === 'CFR' && field === 'freight') return 'CFR 报价已含国际运费';
  return null;
}

function summarizeInputs(scenario) {
  const rows = [];
  for (const field of ['quantity', 'priceTerm', 'currency', 'unitPrice', 'totalPrice', 'freight', 'insurance', 'fx', 'dutyRate', 'vatRate', 'domesticFees', 'exciseRate']) {
    const raw = field === 'priceTerm' ? scenario.priceTerm : (field === 'currency' ? scenario.currency : scenario.input[field]);
    const meta = scenario.meta[field] || {};
    if (raw === undefined || raw === null || raw === '') {
      const na = notApplicable(scenario, field);
      rows.push({
        field,
        label: C.fieldLabel(field, scenario),
        value: null,
        display: na ? '不适用' : '待填写',
        unit: '',
        applicable: !na,
        note: na || '',
        source: na ? 'na' : 'missing',
        sourceText: na ? '不适用' : '待填写'
      });
      continue;
    }
    let display = raw;
    let unit = '';
    try {
      if (field === 'quantity') { unit = scenario.quantityUnit || '件'; display = D.format(D.parse(raw), 0); }
      else if (field === 'priceTerm') unit = '';
      else if (field === 'currency') unit = C.currencyInfo(raw).name;
      else if (['unitPrice', 'totalPrice', 'freight', 'insurance'].includes(field)) {
        unit = C.currencyInfo(scenario.currency).unitLabel + (field === 'unitPrice' ? `/${scenario.quantityUnit || '件'}` : '（整批）');
        display = D.format(D.parse(raw), 2);
      } else if (field === 'fx') {
        unit = C.currencyInfo(scenario.currency).fxLabel;
        display = D.format(D.parse(raw), 4);
      } else if (['dutyRate', 'vatRate', 'exciseRate'].includes(field)) {
        unit = '%';
        display = D.format(D.parse(raw), 2);
      } else if (field === 'domesticFees') {
        unit = '元';
        display = D.format(D.parse(raw), 2);
      }
    } catch {
      display = String(raw);
      unit = '';
    }
    rows.push({
      field,
      label: C.fieldLabel(field, scenario),
      value: display,
      unit,
      applicable: true,
      source: meta.source || 'case_assumption',
      sourceText: C.FIELD_META_SOURCE_TEXT[meta.source] || '案例约定',
      quote: meta.quote || '',
      note: meta.note || ''
    });
  }
  return rows;
}

module.exports = {
  STATE_SCHEMA, SHARED_FIELDS, OFFER_FIELDS,
  createState, cloneState, getScenario, activeScenario, nextScenarioId, createScenario,
  setField, applySlots, copyInherited, touch, recordEvent,
  resolveRestoreFx, pauseForCampus, resumeTrade, complete, summarizeInputs
};
