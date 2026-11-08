'use strict';
const C = require('./constants.cjs');
const D = require('./decimal.cjs');
const S = require('./state.cjs');
const T = require('./tools.cjs');

function moneyText(value) { return `${D.format(value, 2)} 元`; }
function pctText(value) { return `${D.format(value, 2)}%`; }

function scopeSentence() {
  return '这里的“含进口税费支出”不等于可确认的会计成本；进口增值税能否抵扣需另行判断。';
}

function changeSentence(state) {
  const change = state.lastChange;
  if (!change) return '';
  if (change.fields?.length > 3) {
    const allNew = change.fields.every(f => f.fromRaw === null || f.fromRaw === undefined || f.fromRaw === '');
    return allNew
      ? `已记录 ${change.fields.length} 项条件，逐项来源见条件卡。`
      : `本次共修改 ${change.fields.length} 项，逐项变化见条件卡。`;
  }
  if (change.fields?.length > 1) {
    const allNew = change.fields.every(f => f.fromRaw === null || f.fromRaw === undefined || f.fromRaw === '');
    if (allNew) return `已记录 ${change.fields.length} 项条件：${change.fields.map(f => `${f.label} ${f.to}`).join('、')}。`;
    return `本次共修改 ${change.fields.length} 项：${change.fields.map(f => `${f.label} ${f.from ?? '—'} → ${f.to}`).join('；')}。其他参数保持不变。`;
  }
  return `其他参数保持不变；本次变更：${change.label} ${change.from ?? '—'} → ${change.to}。`;
}

function resultAnswer(scenario, result, state, options = {}) {
  const a = result.amounts;
  const parts = [];
  parts.push(`按本案例给定条件，${result.priceTerm} 口径下，这批 ${D.format(D.parse(scenario.input.quantity), 0)} ${scenario.quantityUnit || '件'}商品的含进口税费支出合计为 ${a.outlay.text}，折合每件 ${a.perUnit.text}。`);
  parts.push(`主要构成：计税价格 ${a.taxableValue.text}（${result.composition[0].shareText}）、关税 ${a.duty.text}（${result.composition[1].shareText}）、进口增值税 ${a.vat.text}（${result.composition[2].shareText}）。`);
  const change = options.change === false ? '' : changeSentence(state);
  if (change) parts.push(change);
  parts.push(scopeSentence());
  return parts.join('');
}

function resultDetail(scenario, result) {
  const lines = ['可复算步骤：'];
  result.trace.forEach((step, index) => {
    const unit = step.currency === 'CNY' ? '元' : C.currencyInfo(step.currency).unitLabel;
    lines.push(`${index + 1}. ${step.label}：${step.formula} = ${step.value} ${unit}${step.raw !== step.value ? `（未舍入 ${step.raw}）` : ''}`);
  });
  lines.push(`口径：${C.PRICE_TERMS[result.priceTerm].includes}。`);
  lines.push('舍入：每一步只对输出金额四舍五入到 2 位，后续步骤使用已舍入金额；每件支出是展示值。');
  return lines.join('\n');
}

function joinErrors(errors) {
  return errors.map(e => /[。！？]$/.test(e.message) ? e.message : `${e.message}。`).join(' ');
}

function clarificationAnswer(state, validation, scenario) {
  const missing = validation.missing;
  const errors = validation.errors;
  if (errors.length) {
    return `这次先不计算：${joinErrors(errors)}你已填写的参数都保留，改好这一项就能继续。`;
  }
  if (!missing.length) return '参数看起来齐了，我再核对一次。';
  const labels = missing.map(m => m.label);
  let text = `还差 ${missing.length} 项：${labels.join('、')}。`;
  if (missing.length === 1) text += `请告诉我${labels[0]}。`;
  else text += '可以一次补齐，也可以只回一项。';
  if (missing.every(m => ['freight', 'insurance', 'fx', 'dutyRate', 'vatRate'].includes(m.field))) {
    text += '例如（示例值，不是默认值）：运费 100 美元、保险 10 美元。';
  }
  text += '小贸不会替你填默认值。';
  if (scenario && scenario.priceTerm === 'CIF' && missing.some(m => m.field === 'insurance')) {
    text += 'CIF 报价已含保险费，如无额外保险可明确说“保险 0”。';
  }
  return text;
}

function sensitivityAnswer(sens, state) {
  const base = sens.baseline;
  const target = sens.points.find(p => !p.isBaseline) || base;
  const scenario = S.activeScenario(state);
  const current = scenario?.input.fx ? D.format(D.parse(scenario.input.fx), 4) : base.fxText;
  const dir = target.delta.startsWith('-') ? '降' : '升';
  const parts = [];
  parts.push(`如果汇率从 ${base.fxText} ${dir === '升' ? '升' : '降'}到 ${target.fxText}，含进口税费支出会从 ${base.outlayText}${dir === '升' ? '升' : '降'}到 ${target.outlayText}，${dir === '升' ? '增加' : '减少'} ${target.deltaText.replace(/^[+-]/, '')}（${target.deltaPercentText}），每件从 ${base.perUnitText}变为 ${target.perUnitText}。`);
  if (sens.elasticity) parts.push(`本案例税费均按从价比例计征，支出与汇率近似同比例变动，弹性约 ${sens.elasticity}。`);
  parts.push(`当前方案仍按 ${current} 计算，这次只是试算，没有改动原方案；要采用 ${target.fxText}，请说“按 ${target.fxText} 重算”。`);
  parts.push('汇率方向统一为“1 单位外币＝多少元人民币”；数值变大表示人民币贬值、进口支出上升。');
  return parts.join('');
}

function sensitivityDetail(sens) {
  const lines = ['汇率试算（同一方案、其他条件不变）：'];
  for (const p of sens.points) {
    lines.push(`${p.fxText}：计税价格 ${p.taxableValueText}，关税 ${D.format(D.parse(p.duty), 2)} 元，进口增值税 ${D.format(D.parse(p.vat), 2)} 元，合计 ${p.outlayText}，每件 ${p.perUnitText} 元。`);
  }
  lines.push('说明：本案例的关税、进口增值税都是比例税；分步四舍五入到 2 位，个别汇率点可能有 0.01 元差异。');
  return lines.join('\n');
}

function compareAnswer(comparison, state) {
  if (!comparison.ok) {
    if (comparison.code === 'incomparable') {
      return `两个方案目前不在同一口径，不能直接比较差额：${comparison.reasons.join('；')}。请先把这些条件统一，或分别看各自的支出。`;
    }
    return comparison.message || '暂时无法比较这两个方案。';
  }
  const base = comparison.scenarios.find(s => s.id === comparison.baselineId);
  const diff = comparison.differences[0];
  const other = comparison.scenarios.find(s => s.id === diff.id);
  const parts = [];
  if (comparison.sameCost) {
    parts.push(`按统一口径，${base.label} 与 ${other.label} 的支出相同，都是 ${base.outlayText}。`);
  } else {
    parts.push(`按统一口径比较，${comparison.cheaper.label} 更低：${comparison.cheaper.outlayText}，比${base.label} 的 ${base.outlayText}${diff.higher ? '多' : '少'} ${diff.diffText.replace(/^[+-]/, '')}（${diff.diffPercentText}），每件${diff.higher ? '多' : '少'} ${diff.perUnitDiffText.replace(/^[+-]/, '')}。`);
  }
  if (base.priceTerm !== other.priceTerm) {
    parts.push(`两个报价已统一为 CIF 等值口径：${base.label} 是 ${base.priceTerm}（${C.termInfo(base.priceTerm).includes}）；${other.label} 是 ${other.priceTerm}（${C.termInfo(other.priceTerm).includes}）。`);
  }
  parts.push('差额只反映本案例给定条件下的支出差异，不代表质量、交期、付款条件或汇率风险相同。');
  return parts.join('');
}

function compareDetail(comparison) {
  if (!comparison.ok) return comparison.message || '';
  const lines = ['同口径对比：', comparison.basisNote];
  for (const s of comparison.scenarios) {
    lines.push(`${s.label}：${s.priceTermLabel}，CIF 等值 ${s.cifEquivalent}，支出 ${s.outlayText}，每件 ${s.perUnitText}。`);
  }
  for (const d of comparison.differences) {
    lines.push(`${d.label} 相对 ${comparison.baselineId}：${d.diffText}（${d.diffPercentText}），每件 ${d.perUnitDiffText}。`);
  }
  return lines.join('\n');
}

function exportAnswer(exported, state) {
  const ids = exported.scenarioIds.join('、');
  return `已按当前页面状态生成摘要（状态版本 v${state.version}），包含方案 ${ids} 的输入条件、公式代入、结果、假设与来源，并在导出时逐方案重算核对。文件名：${exported.filename}；内容校验码前 12 位：${exported.checksum.slice(0, 12)}。修改参数后旧摘要不会自动更新，请重新导出。`;
}

function restoreAnswer(state, restore, result) {
  const scenario = S.activeScenario(state);
  const parts = [`已恢复${scenario.label} 的汇率：${restore.from} → ${restore.value}。依据：${restore.basis}。`];
  if (result?.ok) parts.push(`其他参数未变，已重算：含进口税费支出 ${result.amounts.outlay.text}，每件 ${result.amounts.perUnit.text}。`);
  parts.push(scopeSentence());
  return parts.join('');
}

function campusAnswer(state) {
  const scenario = S.activeScenario(state);
  let status = '当前还没有开始计算';
  if (scenario) {
    const v = T.validateTradeInputs(scenario);
    if (v.ok && scenario.result) status = `${scenario.label} 已算好，汇率 ${D.format(D.parse(scenario.input.fx), 4)}，支出 ${scenario.result.amounts.outlay.text}`;
    else if (v.missing.length) status = `${scenario.label} 还差 ${v.missing.length} 项参数`;
  }
  return `这个问题属于校园服务范围，本轮演示先不展开。你的进口案例已保留（${status}）。说“继续刚才的进口案例”就能回来，接着算或修改条件。`;
}

function cancelAnswer() {
  return '已结束这次进口案例，参数、方案和导出草稿都已清空。需要重新开始时，直接说“帮我算进口成本”。';
}

function resumeAnswer(state) {
  const scenario = S.activeScenario(state);
  if (!scenario) return '我们回来啦。先说商品数量、报价口径和单价或总价，我继续帮你算。';
  const v = T.validateTradeInputs(scenario);
  if (v.ok && scenario.result) return `我们回到${scenario.label}了。当前含进口税费支出 ${scenario.result.amounts.outlay.text}，每件 ${scenario.result.amounts.perUnit.text}。你可以修改汇率、比较报价或导出摘要。`;
  return `我们回到${scenario.label}了。还差 ${v.missing.length} 项：${v.missing.map(m => m.label).join('、')}。`;
}

function unknownAnswer(state) {
  const scenario = S.activeScenario(state);
  if (scenario) {
    const v = T.validateTradeInputs(scenario);
    if (v.ok && scenario.result) return `我还在你的进口案例里。当前${scenario.label}的支出是 ${scenario.result.amounts.outlay.text}。你可以说“汇率涨到 7.2 会怎样”“比较另一个 CIF 报价”或“导出摘要”。`;
    if (v.missing.length) return `我先接着这个案例：还差 ${v.missing.length} 项——${v.missing.map(m => m.label).join('、')}。也可以说“取消”结束这次计算。`;
  }
  return '我可以帮你算进口成本。先告诉我商品数量、报价口径（FOB/CFR/CIF），以及单价或整批总价；缺失的参数我会逐项追问，不会替你猜。';
}

function thinkingPrompt(result) {
  if (!result) return C.THINKING_PROMPTS[0];
  return '汇率变化对这笔订单影响多大？';
}

function buildConditionsCard(state) {
  return {
    activeId: state.activeScenarioId,
    phase: state.phase,
    version: state.version,
    scenarios: state.scenarios.map(s => {
      const v = T.validateTradeInputs(s);
      return {
        id: s.id,
        label: s.label,
        priceTerm: s.priceTerm,
        priceTermLabel: s.priceTerm ? (C.PRICE_TERMS[s.priceTerm]?.label || s.priceTerm) : '待确认',
        currency: s.currency,
        quantityUnit: s.quantityUnit || '件',
        complete: v.ok,
        missing: v.missing.map(m => ({ field: m.field, label: m.label })),
        errors: v.errors,
        warnings: v.warnings,
        rows: S.summarizeInputs(s),
        fxHistory: s.fxHistory,
        note: C.PRICE_TERMS[s.priceTerm]?.includes || ''
      };
    }),
    lastChange: state.lastChange,
    pending: state.pending,
    assumptions: C.CASE_ASSUMPTIONS
  };
}

function buildResultCard(state) {
  const scenario = S.activeScenario(state);
  if (!scenario?.result) return null;
  const r = scenario.result;
  return {
    scenarioId: scenario.id,
    label: scenario.label,
    priceTerm: r.priceTerm,
    priceTermLabel: C.PRICE_TERMS[r.priceTerm]?.label || r.priceTerm,
    amounts: r.amounts,
    rates: r.rates,
    composition: r.composition,
    display: r.display,
    trace: r.trace,
    scopeNote: r.scopeNote,
    includedCosts: r.includedCosts,
    resultHash: r.hash,
    inputHash: r.inputHash,
    calculatedAt: r.calculatedAt,
    stale: scenario.resultStale,
    domesticFees: r.amounts.domesticFees,
    grandTotal: r.amounts.grandTotal
  };
}

function buildBasisCard(state, resultOverride) {
  const scenario = S.activeScenario(state);
  const result = resultOverride || scenario?.result;
  return {
    formulas: C.FORMULAS,
    trace: result?.trace || [],
    roundingRules: C.ROUNDING_RULES,
    assumptions: C.CASE_ASSUMPTIONS,
    notIncluded: C.NOT_INCLUDED,
    sources: [
      { label: '本案例数据', text: '数量、报价、运费、保险费、汇率和税率由用户在教学案例中给定。', kind: '教学设定' },
      { label: '计算规则', text: '采用本演示约定的教学简化公式；不查询实时汇率、税则或商品归类。', kind: '范围声明' },
      { label: '适用范围', text: '结果只用于课堂案例讨论，不构成真实业务、税务或法律意见。', kind: '使用限制' }
    ],
    scopeNote: result?.scopeNote || '按本案例给定条件计算。'
  };
}

function buildLearningCard(result) {
  return {
    cards: C.LEARNING_CARDS,
    prompt: thinkingPrompt(result),
    prompts: C.THINKING_PROMPTS,
    notIncluded: C.NOT_INCLUDED
  };
}

function defaultActions(state) {
  const scenario = S.activeScenario(state);
  const actions = [];
  if (state.phase === 'paused') {
    return [
      { id: 'resume', label: '继续进口案例', text: '继续刚才的进口案例', kind: 'send', primary: true },
      { id: 'reset', label: '重新开始', text: '取消', kind: 'reset' }
    ];
  }
  if (!scenario) {
    return [
      { id: 'start', label: '开始算成本', text: '帮我算一下这批进口商品的成本', kind: 'send', primary: true },
      { id: 'example', label: '看标准案例', text: '用标准教学案例演示', kind: 'example' }
    ];
  }
  const v = T.validateTradeInputs(scenario);
  if (!v.ok) {
    actions.push({ id: 'example', label: '填入示例值', text: '填入示例值（会标注来源）', kind: 'example' });
    actions.push({ id: 'cancel', label: '取消这次计算', text: '取消', kind: 'send' });
    return actions;
  }
  actions.push({ id: 'fx72', label: '汇率试算 7.20', text: '如果汇率涨到 7.2 呢？', kind: 'send', primary: true });
  actions.push({ id: 'compare', label: '比较 CIF 报价', text: '另一个供应商报 CIF 总价 1,080 美元，其他条件一样，哪个支出更低？', kind: 'send' });
  actions.push({ id: 'explain', label: '展开依据', text: '为什么是这个数？', kind: 'send' });
  actions.push({ id: 'export', label: '导出摘要', text: '把两种方案整理成一份摘要', kind: 'export' });
  return actions;
}

module.exports = {
  moneyText, pctText, scopeSentence, changeSentence, joinErrors,
  resultAnswer, resultDetail, clarificationAnswer,
  sensitivityAnswer, sensitivityDetail, compareAnswer, compareDetail,
  exportAnswer, restoreAnswer, campusAnswer, cancelAnswer, resumeAnswer, unknownAnswer,
  buildConditionsCard, buildResultCard, buildBasisCard, buildLearningCard, defaultActions
};
