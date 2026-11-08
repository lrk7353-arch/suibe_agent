'use strict';
const crypto = require('node:crypto');
const D = require('./decimal.cjs');
const C = require('./constants.cjs');

const CALC_VERSION = 'calc-v1';
const MAX_AMOUNT = D.parse('1000000000000'); // 1e12，防止异常输入拖垮展示
const MAX_QUANTITY = D.parse('1000000');

const FOREIGN_MONEY_FIELDS = ['unitPrice', 'totalPrice', 'freight', 'insurance'];
const PERCENT_FIELDS = ['dutyRate', 'vatRate', 'exciseRate'];
const FIELD_ORDER = ['quantity', 'priceTerm', 'currency', 'unitPrice', 'totalPrice', 'freight', 'insurance', 'fx', 'dutyRate', 'vatRate', 'domesticFees', 'exciseRate'];

function canonicalScenarioInput(scenario) {
  const input = {};
  for (const field of FIELD_ORDER) {
    if (scenario.input?.[field] !== undefined && scenario.input?.[field] !== null) input[field] = scenario.input[field];
  }
  return JSON.stringify({
    caseId: C.CASE_ID,
    calcVersion: CALC_VERSION,
    priceTerm: scenario.priceTerm || null,
    currency: scenario.currency || null,
    quantityUnit: scenario.quantityUnit || '件',
    input
  });
}

function inputHash(scenario) {
  return crypto.createHash('sha256').update(canonicalScenarioInput(scenario)).digest('hex');
}

function resultHash(result) {
  const amounts = result?.amounts || {};
  const payload = JSON.stringify({
    calcVersion: result?.calcVersion,
    inputHash: result?.inputHash,
    values: Object.fromEntries(Object.entries(amounts).map(([k, v]) => [k, v?.value ?? null]))
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function amount(valueBigInt, code, places = 2) {
  const info = C.currencyInfo(code);
  const isCny = code === 'CNY';
  const text = `${D.format(valueBigInt, places)} ${isCny ? '元' : info.unitLabel}`;
  return {
    value: D.formatFixed(valueBigInt, places),
    places,
    currency: code,
    text,
    raw: D.formatFixed(valueBigInt, D.SCALE)
  };
}

function percentValue(valueBigInt) {
  return { value: D.formatFixed(valueBigInt, 2), text: D.percentText(valueBigInt, 2) };
}

function rawText(valueBigInt) {
  return D.formatFixed(valueBigInt, D.SCALE);
}

function trimZeros(text) {
  if (!text.includes('.')) return text;
  return text.replace(/0+$/, '').replace(/\.$/, '');
}

function normalizeMoney(text, field, errors, scenario) {
  try {
    const v = D.parse(text);
    if (v < 0n) throw new D.DecimalError('negative', '金额不能为负');
    if (v > MAX_AMOUNT) throw new D.DecimalError('too_large', '金额超出演示范围');
    const decimals = D.formatFixed(v, D.SCALE).split('.')[1].replace(/0+$/, '').length;
    if (decimals > 2) throw new D.DecimalError('too_many_money_decimals', '金额最多 2 位小数');
    return { ok: true, value: D.roundTo(v, 2), canonical: D.formatFixed(v, 2) };
  } catch (err) {
    errors.push({ field, code: err.code || 'invalid', message: `${C.fieldLabel(field, scenario)}：${err.message}` });
    return { ok: false };
  }
}

function isNonZero(text) {
  try { return D.parse(text) !== 0n; } catch { return false; }
}

function validateTradeInputs(scenario) {
  const errors = [];
  const warnings = [];
  const missing = [];
  const normalized = {};
  if (!scenario || typeof scenario !== 'object') {
    return { ok: false, code: 'invalid_scenario', missing: [], errors: [{ field: null, code: 'invalid_scenario', message: '缺少方案数据' }], warnings: [], normalized: {}, required: [] };
  }
  const input = scenario.input || {};
  const term = scenario.priceTerm || null;
  const termDef = term ? C.termInfo(term) : null;

  if (term && !termDef) {
    errors.push({ field: 'priceTerm', code: 'unsupported_term', message: `暂不支持 ${term} 报价口径；本演示支持 FOB、CFR、CIF。` });
  }
  if (scenario.currency && !C.CURRENCIES[scenario.currency]) {
    errors.push({ field: 'currency', code: 'unsupported_currency', message: `暂不支持币种 ${scenario.currency}` });
  }

  // 数量：正整数
  if (input.quantity !== undefined && input.quantity !== null && input.quantity !== '') {
    try {
      const v = D.parse(input.quantity);
      if (v <= 0n) throw new D.DecimalError('quantity_not_positive', '数量必须大于 0');
      if (v > MAX_QUANTITY) throw new D.DecimalError('quantity_too_large', '数量超出演示范围');
      if (v % D.FACTOR !== 0n) throw new D.DecimalError('quantity_not_integer', '件数必须是整数；按重量计价请改用总额报价');
      normalized.quantity = (v / D.FACTOR).toString();
    } catch (err) {
      errors.push({ field: 'quantity', code: err.code || 'invalid_quantity', message: `商品数量：${err.message}` });
    }
  }

  for (const field of FOREIGN_MONEY_FIELDS) {
    if (input[field] === undefined || input[field] === null || input[field] === '') continue;
    const r = normalizeMoney(input[field], field, errors, scenario);    if (r.ok) {
      if ((field === 'unitPrice' || field === 'totalPrice') && r.value === 0n) {
        errors.push({ field, code: 'price_not_positive', message: `${C.fieldLabel(field, scenario)}：价格必须大于 0` });
      } else normalized[field] = r.canonical;
    }
  }

  if (input.fx !== undefined && input.fx !== null && input.fx !== '') {
    try {
      const v = D.parse(input.fx);
      if (v <= 0n) throw new D.DecimalError('fx_not_positive', '汇率必须大于 0');
      if (v > D.parse('10000')) throw new D.DecimalError('fx_too_large', '汇率超出演示范围');
      const decimals = D.formatFixed(v, D.SCALE).split('.')[1].replace(/0+$/, '').length;
      if (decimals > 4) throw new D.DecimalError('too_many_fx_decimals', '汇率最多 4 位小数');
      normalized.fx = D.formatFixed(v, 4);
    } catch (err) {
      errors.push({ field: 'fx', code: err.code || 'invalid_fx', message: `汇率：${err.message}` });
    }
  }

  for (const field of PERCENT_FIELDS) {
    if (input[field] === undefined || input[field] === null || input[field] === '') continue;
    try {
      const v = D.parse(input[field]);
      if (v < 0n) throw new D.DecimalError('percent_negative', '税率不能为负');
      if (v > D.parse('100')) throw new D.DecimalError('percent_too_large', '税率必须在 0–100 之间');
      const decimals = D.formatFixed(v, D.SCALE).split('.')[1].replace(/0+$/, '').length;
      if (decimals > 2) throw new D.DecimalError('too_many_percent_decimals', '税率最多 2 位小数');
      normalized[field] = D.formatFixed(v, 2);
    } catch (err) {
      errors.push({ field, code: err.code || 'invalid_percent', message: `${C.FIELDS[field].label}：${err.message}` });
    }
  }

  if (input.domesticFees !== undefined && input.domesticFees !== null && input.domesticFees !== '') {
    const r = normalizeMoney(input.domesticFees, 'domesticFees', errors, scenario);
    if (r.ok) normalized.domesticFees = r.canonical;
  }

  if (normalized.exciseRate && D.parse(normalized.exciseRate) > 0n) {
    errors.push({
      field: 'exciseRate',
      code: 'excise_unsupported',
      message: '本教学案例不涉及消费税，且本版本未实现消费税复合计税规则。请将消费税设为 0，或另行提供计税规则与来源。'
    });
  }

  // 口径一致性：CIF/CFR 已含运费，FOB 才有单价
  if (term === 'FOB') {
    if (input.totalPrice !== undefined && input.totalPrice !== null && input.totalPrice !== '') {
      errors.push({ field: 'totalPrice', code: 'term_conflict', message: 'FOB 口径按“单价×数量”计，总价会与单价冲突。请只保留单价，或把报价口径改为 CIF/CFR。' });
    }
  }
  if (term === 'CFR' || term === 'CIF') {
    if (input.unitPrice !== undefined && input.unitPrice !== null && input.unitPrice !== '') {
      errors.push({ field: 'unitPrice', code: 'term_conflict', message: `${term} 口径按整批总价计，不能再填单价。请只保留总价。` });
    }
  }
  if (term === 'CIF') {
    for (const field of ['freight', 'insurance']) {
      if (input[field] !== undefined && input[field] !== null && input[field] !== '' && isNonZero(input[field])) {
        errors.push({
          field,
          code: 'included_cost_repeated',
          message: `CIF 报价已包含${field === 'freight' ? '国际运费' : '保险费'}，不能重复叠加。请删除该项，或把报价口径改成 FOB/CFR。`
        });
      }
    }
  }
  if (term === 'CFR' && input.freight !== undefined && input.freight !== null && input.freight !== '' && isNonZero(input.freight)) {
    errors.push({ field: 'freight', code: 'included_cost_repeated', message: 'CFR 报价已包含国际运费，不能重复叠加。' });
  }

  const required = termDef ? [...termDef.required] : ['quantity', 'priceTerm', 'currency', 'fx', 'dutyRate', 'vatRate'];
  for (const field of required) {
    if (field === 'priceTerm') {
      if (!term) missing.push({ field, label: C.FIELDS[field].label, ask: '这是 FOB、CFR 还是 CIF 报价？' });
      continue;
    }
    if (field === 'currency') {
      if (!scenario.currency) missing.push({ field, label: '报价币种', ask: '报价用的是美元、欧元还是人民币？' });
      continue;
    }
    if (input[field] === undefined || input[field] === null || input[field] === '') {
      if (!errors.some(e => e.field === field)) missing.push({ field, label: C.fieldLabel(field, scenario), ask: `请提供${C.fieldLabel(field, scenario)}` });
    }
  }

  if (normalized.dutyRate && D.parse(normalized.dutyRate) === 0n) warnings.push({ field: 'dutyRate', code: 'zero_duty', message: '关税税率为 0，本案例下关税为 0。' });
  if (normalized.vatRate && D.parse(normalized.vatRate) === 0n) warnings.push({ field: 'vatRate', code: 'zero_vat', message: '进口增值税税率为 0，本案例下增值税为 0。' });

  const ok = errors.length === 0 && missing.length === 0;
  return {
    ok,
    code: ok ? 'ok' : (errors.length ? 'invalid_inputs' : 'missing_inputs'),
    term: termDef ? term : null,
    missing,
    errors,
    warnings,
    normalized,
    required
  };
}

// 兼容误用：validate 里可能用到 parseSafe
if (!D.parseSafe) D.parseSafe = value => { try { return D.parse(value); } catch { return null; } };

function calculateImportOutlay(scenario) {
  const validation = validateTradeInputs(scenario);
  if (!validation.ok) {
    return { ok: false, code: validation.code, validation, tool: 'calculate_import_outlay' };
  }
  const n = validation.normalized;
  const currency = scenario.currency;
  const qty = D.parse(n.quantity);
  const fx = D.parse(n.fx);
  const dutyRate = D.parse(n.dutyRate);
  const vatRate = D.parse(n.vatRate);
  const domesticFees = D.parse(n.domesticFees || '0');
  const term = validation.term;

  let goodsForeign;
  let freightForeign = 0n;
  let insuranceForeign = 0n;
  const trace = [];

  if (term === 'FOB') {
    const unitPrice = D.parse(n.unitPrice);
    goodsForeign = D.roundTo(D.mul(unitPrice, qty), 2);
    freightForeign = D.roundTo(D.parse(n.freight), 2);
    insuranceForeign = D.roundTo(D.parse(n.insurance), 2);
    trace.push({
      id: 'goods_total',
      label: '商品总价',
      formula: `${D.format(qty, 0)} ${scenario.quantityUnit || '件'} × ${D.format(unitPrice, 2)} ${C.currencyInfo(currency).unitLabel}/${scenario.quantityUnit || '件'}`,
      raw: rawText(D.mul(unitPrice, qty)),
      value: D.formatFixed(goodsForeign, 2),
      currency,
      note: '按 FOB 单价乘数量'
    });
  } else {
    goodsForeign = D.roundTo(D.parse(n.totalPrice), 2);
    trace.push({
      id: 'goods_total',
      label: `${term} 报价总价`,
      formula: term === 'CIF' ? '整批报价（已含国际运费与保险费）' : '整批报价（已含国际运费）',
      raw: rawText(D.parse(n.totalPrice)),
      value: D.formatFixed(goodsForeign, 2),
      currency,
      note: term === 'CIF' ? 'CIF 总价已含国际运费与保险费' : 'CFR 总价已含国际运费'
    });
  }

  if (term === 'CFR') {
    insuranceForeign = D.roundTo(D.parse(n.insurance), 2);
  }
  const cifEquivalent = D.add(D.add(goodsForeign, freightForeign), insuranceForeign);

  const taxableRaw = D.mul(cifEquivalent, fx);
  const taxable = D.roundTo(taxableRaw, 2);
  const dutyRaw = D.applyPercent(taxable, dutyRate);
  const duty = D.roundTo(dutyRaw, 2);
  const vatBase = D.add(taxable, duty);
  const vatRaw = D.applyPercent(vatBase, vatRate);
  const vat = D.roundTo(vatRaw, 2);
  const outlay = D.add(D.add(taxable, duty), vat);
  const perUnitRaw = D.div(outlay, qty);
  const perUnit = D.roundTo(perUnitRaw, 2);
  const grandTotal = D.add(outlay, domesticFees);
  const perUnitGrand = D.roundTo(D.div(grandTotal, qty), 2);

  trace.push({
    id: 'cif_equivalent',
    label: 'CIF 等值',
    formula: term === 'FOB'
      ? `${D.format(goodsForeign, 2)} + ${D.format(freightForeign, 2)} + ${D.format(insuranceForeign, 2)}`
      : (term === 'CFR' ? `${D.format(goodsForeign, 2)}（CFR）+ ${D.format(insuranceForeign, 2)}（保险）` : 'CIF 总价（已含运费与保险费）'),
    raw: rawText(cifEquivalent),
    value: D.formatFixed(cifEquivalent, 2),
    currency,
    note: term === 'CIF' ? '不再叠加运费与保险费' : '统一折算为 CIF 等值'
  });
  trace.push({
    id: 'taxable_value',
    label: '计税价格',
    formula: `${D.format(cifEquivalent, 2)} ${C.currencyInfo(currency).unitLabel} × ${D.format(fx, 4)} ${C.currencyInfo(currency).fxLabel}`,
    raw: rawText(taxableRaw),
    value: D.formatFixed(taxable, 2),
    currency: 'CNY',
    rounding: { places: 2, rule: 'half-up' },
    note: '按案例约定先折人民币'
  });
  trace.push({
    id: 'duty',
    label: '关税',
    formula: `${D.format(taxable, 2)} × ${D.format(dutyRate, 2)}%`,
    raw: rawText(dutyRaw),
    value: D.formatFixed(duty, 2),
    currency: 'CNY',
    rounding: { places: 2, rule: 'half-up' },
    note: '以已舍入的计税价格为基数'
  });
  trace.push({
    id: 'vat',
    label: '进口增值税',
    formula: `(${D.format(taxable, 2)} + ${D.format(duty, 2)}) × ${D.format(vatRate, 2)}%`,
    raw: rawText(vatRaw),
    value: D.formatFixed(vat, 2),
    currency: 'CNY',
    rounding: { places: 2, rule: 'half-up' },
    note: '以“计税价格＋关税”为基数'
  });
  trace.push({
    id: 'outlay',
    label: '含进口税费支出合计',
    formula: `${D.format(taxable, 2)} + ${D.format(duty, 2)} + ${D.format(vat, 2)}`,
    raw: rawText(outlay),
    value: D.formatFixed(outlay, 2),
    currency: 'CNY',
    note: '使用已舍入分项相加，不再二次舍入'
  });
  trace.push({
    id: 'per_unit',
    label: '每件对应支出',
    formula: `${D.format(outlay, 2)} ÷ ${D.format(qty, 0)} ${scenario.quantityUnit || '件'}`,
    raw: rawText(perUnitRaw),
    value: D.formatFixed(perUnit, 2),
    currency: 'CNY',
    rounding: { places: 2, rule: 'half-up' },
    note: '展示值，不参与合计'
  });
  if (domesticFees > 0n) {
    trace.push({
      id: 'grand_total',
      label: '含国内其他费用合计',
      formula: `${D.format(outlay, 2)} + ${D.format(domesticFees, 2)}（国内其他费用）`,
      raw: rawText(grandTotal),
      value: D.formatFixed(grandTotal, 2),
      currency: 'CNY',
      note: '国内其他费用不改变案例口径的“含进口税费支出”'
    });
  }

  const shares = [
    { key: 'taxableValue', label: '计税价格', value: taxable, share: D.sharePercent(taxable, outlay) },
    { key: 'duty', label: '关税', value: duty, share: D.sharePercent(duty, outlay) },
    { key: 'vat', label: '进口增值税', value: vat, share: D.sharePercent(vat, outlay) }
  ];

  const result = {
    ok: true,
    tool: 'calculate_import_outlay',
    calcVersion: CALC_VERSION,
    caseId: C.CASE_ID,
    scenarioId: scenario.id,
    priceTerm: term,
    currency,
    quantityUnit: scenario.quantityUnit || '件',
    inputHash: inputHash(scenario),
    calculatedAt: new Date().toISOString(),
    amounts: {
      goodsTotal: amount(goodsForeign, currency),
      freightTotal: amount(freightForeign, currency),
      insuranceTotal: amount(insuranceForeign, currency),
      cifEquivalent: amount(cifEquivalent, currency),
      taxableValue: amount(taxable, 'CNY'),
      duty: amount(duty, 'CNY'),
      vat: amount(vat, 'CNY'),
      outlay: amount(outlay, 'CNY'),
      perUnit: amount(perUnit, 'CNY'),
      domesticFees: amount(domesticFees, 'CNY'),
      grandTotal: amount(grandTotal, 'CNY'),
      perUnitGrand: amount(perUnitGrand, 'CNY')
    },
    rates: {
      fx: { value: D.formatFixed(fx, 4), text: D.format(fx, 4) + ' ' + C.currencyInfo(currency).fxLabel },
      dutyRate: percentValue(dutyRate),
      vatRate: percentValue(vatRate),
      exciseRate: percentValue(D.parse(n.exciseRate || '0'))
    },
    composition: shares.map(s => ({
      key: s.key,
      label: s.label,
      amount: D.formatFixed(s.value, 2),
      amountText: amount(s.value, 'CNY').text,
      share: D.formatFixed(s.share, 2),
      shareText: D.percentText(s.share, 2)
    })),
    trace,
    assumptions: C.CASE_ASSUMPTIONS,
    roundingRules: C.ROUNDING_RULES,
    formulas: C.FORMULAS,
    includedCosts: {
      freight: term === 'FOB' ? 'separately_added' : 'included_in_price',
      insurance: term === 'CIF' ? 'included_in_price' : (term === 'CFR' ? 'separately_added' : 'separately_added'),
      note: C.termInfo(term).includes
    },
    scopeNote: '按本案例给定条件计算：含进口税费支出＝计税价格＋关税＋进口增值税；该支出不等于可确认的会计成本。',
    display: {
      outlay: amount(outlay, 'CNY').text,
      perUnit: `${amount(perUnit, 'CNY').text}/${scenario.quantityUnit || '件'}`,
      compositionSummary: shares.map(s => `${s.label} ${D.format(s.value, 2)} 元（${D.percentText(s.share, 2)}）`).join('；')
    }
  };
  result.hash = resultHash(result);
  return result;
}

function compareTradeScenarios({ scenarios, baselineId }) {
  if (!Array.isArray(scenarios) || scenarios.length < 2) {
    return { ok: false, code: 'need_two_scenarios', tool: 'compare_trade_scenarios', message: '至少需要两个完整方案才能比较。' };
  }
  const computed = [];
  for (const s of scenarios) {
    const r = calculateImportOutlay(s);
    if (!r.ok) return { ok: false, code: 'scenario_invalid', tool: 'compare_trade_scenarios', scenarioId: s.id, validation: r.validation, message: `方案 ${s.label || s.id} 还不能计算。` };
    computed.push({ scenario: s, result: r });
  }
  const base = computed.find(x => x.scenario.id === baselineId) || computed[0];
  const reasons = [];
  for (const item of computed) {
    if (item.scenario.id === base.scenario.id) continue;
    for (const [key, label] of [['quantity', '数量'], ['fx', '汇率'], ['dutyRate', '关税税率'], ['vatRate', '增值税税率'], ['currency', '币种'], ['quantityUnit', '数量单位']]) {
      const a = String(base.scenario.input?.[key] ?? base.scenario[key] ?? '');
      const b = String(item.scenario.input?.[key] ?? item.scenario[key] ?? '');
      if (key === 'currency' || key === 'quantityUnit') {
        const av = base.scenario[key] || '', bv = item.scenario[key] || '';
        if (av !== bv) reasons.push(`${item.scenario.label || item.scenario.id} 的${label}（${bv || '未填'}）与基准（${av || '未填'}）不同`);
      } else if (a !== b) {
        reasons.push(`${item.scenario.label || item.scenario.id} 的${label}（${b || '未填'}）与基准（${a || '未填'}）不同`);
      }
    }
  }
  if (reasons.length) {
    return {
      ok: false,
      code: 'incomparable',
      tool: 'compare_trade_scenarios',
      message: '两个方案不在同一口径，不能直接比较差额。请先把数量、汇率、税率和币种统一，或分别计算。',
      reasons,
      scenarios: computed.map(x => ({ id: x.scenario.id, label: x.scenario.label, priceTerm: x.scenario.priceTerm, outlay: x.result.amounts.outlay.text, perUnit: x.result.amounts.perUnit.text }))
    };
  }

  const differences = computed.filter(x => x.scenario.id !== base.scenario.id).map(item => {
    const diff = D.sub(D.parse(item.result.amounts.outlay.value), D.parse(base.result.amounts.outlay.value));
    const pct = base.result.amounts.outlay.value === '0.00'
      ? 0n
      : D.div(D.mul(diff, D.parse('100')), D.parse(base.result.amounts.outlay.value));
    const perUnitDiff = D.sub(D.parse(item.result.amounts.perUnit.value), D.parse(base.result.amounts.perUnit.value));
    return {
      id: item.scenario.id,
      label: item.scenario.label,
      priceTerm: item.scenario.priceTerm,
      outlay: item.result.amounts.outlay.value,
      outlayText: item.result.amounts.outlay.text,
      perUnit: item.result.amounts.perUnit.value,
      perUnitText: item.result.amounts.perUnit.text,
      diffFromBaseline: D.formatFixed(diff, 2),
      diffText: `${diff > 0n ? '+' : ''}${D.format(diff, 2)} 元`,
      diffPercent: D.formatFixed(pct, 2),
      diffPercentText: `${diff > 0n ? '+' : ''}${D.format(pct, 2)}%`,
      perUnitDiff: D.formatFixed(perUnitDiff, 2),
      perUnitDiffText: `${perUnitDiff > 0n ? '+' : ''}${D.format(perUnitDiff, 2)} 元`,
      higher: diff > 0n,
      equal: diff === 0n
    };
  });

  let cheaper = { id: base.scenario.id, label: base.scenario.label, outlay: base.result.amounts.outlay.value };
  for (const d of differences) {
    if (D.cmp(D.parse(d.outlay), D.parse(cheaper.outlay)) < 0) cheaper = { id: d.id, label: d.label, outlay: d.outlay };
  }
  const maxDiff = differences.reduce((acc, d) => D.abs(D.parse(d.diffFromBaseline)) > D.abs(D.parse(acc)) ? d.diffFromBaseline : acc, '0');
  const sameCost = differences.every(d => d.equal);

  return {
    ok: true,
    tool: 'compare_trade_scenarios',
    calcVersion: CALC_VERSION,
    baselineId: base.scenario.id,
    sameScope: true,
    basisNote: '两个方案已统一为 CIF 等值口径（FOB 报价另加运费与保险费；CIF 报价不重复叠加），并按同一汇率与税率计算。',
    scenarios: computed.map(x => ({
      id: x.scenario.id,
      label: x.scenario.label,
      priceTerm: x.scenario.priceTerm,
      priceTermLabel: C.termInfo(x.scenario.priceTerm)?.label || x.scenario.priceTerm,
      outlay: x.result.amounts.outlay.value,
      outlayText: x.result.amounts.outlay.text,
      perUnit: x.result.amounts.perUnit.value,
      perUnitText: `${x.result.amounts.perUnit.text}/${x.result.quantityUnit}`,
      cifEquivalent: x.result.amounts.cifEquivalent.text,
      includedCosts: x.result.includedCosts,
      resultHash: x.result.hash
    })),
    differences,
    cheaper: { id: cheaper.id, label: cheaper.label, outlay: cheaper.outlay, outlayText: D.format(D.parse(cheaper.outlay), 2) + ' 元' },
    maxDifference: `${maxDiff} 元`,
    sameCost,
    note: sameCost
      ? '两个方案的支出相同；请进一步比较付款条件、质量与交付风险。'
      : `按案例口径，${cheaper.label} 的含进口税费支出更低。`
  };
}

function analyzeExchangeSensitivity({ scenario, fxValues }) {
  const base = calculateImportOutlay(scenario);
  if (!base.ok) {
    return { ok: false, code: 'invalid_inputs', tool: 'analyze_exchange_sensitivity', validation: base.validation, message: '方案还没有补齐，无法做汇率分析。' };
  }
  const baseFx = D.parse(base.rates.fx.value);
  const targets = [];
  for (const raw of (fxValues && fxValues.length ? fxValues : [D.formatFixed(D.mul(baseFx, D.parse('1.1')), 4)])) {
    try {
      const v = D.parse(raw);
      if (v <= 0n) throw new D.DecimalError('fx_not_positive', '汇率必须大于 0');
      const canonical = D.formatFixed(v, 4);
      if (!targets.some(t => t === canonical)) targets.push(canonical);
    } catch {
      return { ok: false, code: 'invalid_fx', tool: 'analyze_exchange_sensitivity', message: `汇率 ${raw} 格式不正确。` };
    }
  }
  const points = [];
  for (const fx of [base.rates.fx.value, ...targets.filter(t => t !== base.rates.fx.value)]) {
    const clone = JSON.parse(JSON.stringify(scenario));
    clone.input = { ...clone.input, fx };
    const r = calculateImportOutlay(clone);
    if (!r.ok) return { ok: false, code: 'scenario_invalid', tool: 'analyze_exchange_sensitivity', validation: r.validation };
    const fxV = D.parse(fx);
    const diff = D.sub(D.parse(r.amounts.outlay.value), D.parse(base.amounts.outlay.value));
    const pct = D.div(D.mul(diff, D.parse('100')), D.parse(base.amounts.outlay.value));
    const fxPct = D.div(D.mul(D.sub(fxV, baseFx), D.parse('100')), baseFx);
    const perUnit = r.amounts.perUnit.value;
    points.push({
      fx,
      fxText: D.format(fxV, 4),
      isBaseline: fx === base.rates.fx.value,
      taxableValue: r.amounts.taxableValue.value,
      taxableValueText: r.amounts.taxableValue.text,
      duty: r.amounts.duty.value,
      vat: r.amounts.vat.value,
      outlay: r.amounts.outlay.value,
      outlayText: r.amounts.outlay.text,
      perUnit,
      perUnitText: r.amounts.perUnit.text,
      delta: D.formatFixed(diff, 2),
      deltaText: `${diff > 0n ? '+' : ''}${D.format(diff, 2)} 元`,
      deltaPercent: D.formatFixed(pct, 2),
      deltaPercentText: `${pct > 0n ? '+' : ''}${D.format(pct, 2)}%`,
      fxDeltaPercent: D.formatFixed(fxPct, 2),
      elasticity: fxPct === 0n ? null : D.formatFixed(D.div(pct, fxPct), 4),
      direction: fx === base.rates.fx.value ? '基线' : (fxV > baseFx ? '汇率上升（人民币贬值）→ 支出上升' : '汇率下降（人民币升值）→ 支出下降')
    });
  }
  const firstNonBase = points.find(p => !p.isBaseline);
  return {
    ok: true,
    tool: 'analyze_exchange_sensitivity',
    calcVersion: CALC_VERSION,
    scenarioId: scenario.id,
    baseline: points[0],
    points,
    exposure: base.amounts.cifEquivalent,
    exposureText: base.amounts.cifEquivalent.text,
    elasticity: firstNonBase?.elasticity || null,
    directionNote: firstNonBase?.direction || null,
    note: '本案例的关税与进口增值税都按从价比例计征，支出随汇率近似同比例变化；因分步四舍五入，个别点可能出现 0.01 元级差异。汇率方向统一为“1 单位外币＝多少元人民币”。',
    inputHash: base.inputHash
  };
}

module.exports = {
  CALC_VERSION,
  validateTradeInputs,
  calculateImportOutlay,
  compareTradeScenarios,
  analyzeExchangeSensitivity,
  inputHash,
  resultHash,
  canonicalScenarioInput,
  amount
};
