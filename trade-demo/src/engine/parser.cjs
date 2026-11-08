'use strict';
// 模拟模型层的“参数提案器”：只做自然语言理解与参数抽取，不做金额计算。
// 程序侧会对每个字段名、取值、口径再次校验；未通过校验的提案不会进入计算。
const C = require('./constants.cjs');
const D = require('./decimal.cjs');

const NUM = String.raw`(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?)`;
const CUR = String.raw`(美元|美金|USD|欧元|EUR|日元|日圆|JPY|港币|港元|HKD|英镑|GBP|人民币|CNY|RMB)`;
const QTY_UNIT = String.raw`(件|个|台|套|箱|吨|千克|公斤)`;

function normalizeText(input) {
  return String(input || '')
    .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[．]/g, '.')
    .replace(/[％]/g, '%')
    .replace(/[：]/g, ':')
    .replace(/[，]/g, ',')
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanNumber(token) {
  return String(token).replace(/,/g, '');
}

function findCurrency(text) {
  const patterns = [
    ['USD', /美元|美金|USD|\$/i],
    ['EUR', /欧元|EUR|€/i],
    ['JPY', /日元|日圆|JPY/i],
    ['HKD', /港币|港元|HKD/i],
    ['GBP', /英镑|GBP/i],
    ['CNY', /人民币|CNY|RMB/i]
  ];
  for (const [code, re] of patterns) if (re.test(text)) return code;
  return null;
}

function findTerm(text) {
  const latin = text.match(/\b(FOB|CIF|CFR|C&F|CNF|EXW|FCA|DDP)\b/i);
  if (latin) {
    const t = latin[1].toUpperCase();
    if (t === 'C&F' || t === 'CNF') return 'CFR';
    return t;
  }
  if (/离岸价/.test(text)) return 'FOB';
  if (/到岸价|成本加保险费加运费/.test(text)) return 'CIF';
  if (/成本加运费/.test(text)) return 'CFR';
  return null;
}

function intentFrom(text, slots, term) {
  const plain = text;
  if (/^(取消|不算了|结束计算|清空|重来|不算了)[。！!.]*$/.test(plain) || /取消(?:这次|刚才)?(?:计算|案例)/.test(plain)) return 'cancel';
  if (/继续(?:刚才|之前|上面)?的?(?:进口|经贸|案例|计算)|回到(?:刚才|之前)?的?(?:进口|案例)|接着算/.test(plain)) return 'resume';
  if (/导出|摘要|汇总|整理成一份|生成(?:一份)?(?:案例)?(?:报告|摘要)|保存(?:一份)?摘要|打包/.test(plain)) return 'export';
  if (/(?:恢复|还原|回到).*(?:原来|之前|先前|原).*汇率|汇率.*(?:恢复|还原)/.test(plain)) return 'restore_fx';
  if (/(?:哪个|哪个方案).*(?:低|高|便宜|划算)|比较|对比|差额|差异|更便宜|差多少/.test(plain) && !/(?:另一个|另一家|换.*供应商)/.test(plain)) return 'compare';
  if (/(?:另一个供应商|另一家|第二个供应商|新供应商|再报一个|另一个方案|方案\s*B|B\s*方案|乙供应商|换个供应商)/.test(plain)) return 'new_scenario';
  if (/(?:如果|假如|若).*汇率|汇率.*(?:涨|跌|升|降|变化|变动|影响|敏感)|汇率敏感/.test(plain)) return 'sensitivity';
  if (/(?:改成|改为|调整为|调成|变成|设为|降到|涨到|跌到|升到|按\s*-?\d+(?:\.\d+)?\s*(?:算|重算)|采用)/.test(plain) && slots.length) return 'update';
  if (/为什么|怎么算|怎么得出|依据|公式|明细|展开|解释|组成|来源/.test(plain)) return 'explain';
  if (slots.length) return 'calculate';
  if (term) return 'calculate';
  return 'unknown';
}

function isCampus(text) {
  if (/进口|到岸|成本|关税|增值税|汇率|运费|保险费|FOB|CIF|CFR|报价|外贸|贸易/i.test(text)) return false;
  return C.CAMPUS_PATTERNS.some(word => text.includes(word));
}

function pushSlot(slots, slot, errors) {
  const same = slots.filter(s => s.field === slot.field);
  if (same.length) {
    const values = new Set([...same.map(s => s.value), slot.value]);
    if (values.size > 1) {
      errors.push({
        field: slot.field,
        code: 'duplicate_field',
        message: `同一句话里“${C.FIELDS[slot.field]?.label || slot.field}”出现了多个数值，请只保留一个。`,
        quote: slot.quote
      });
      return;
    }
  }
  slots.push(slot);
}

function extractTradeProposal(rawText, state = {}) {
  const text = normalizeText(rawText);
  const slots = [];
  const errors = [];
  const notes = [];
  const flags = { inherit: false, compare: false, whatIf: false, commit: false, newScenario: false };

  flags.inherit = /其他条件(?:一样|不变|相同|照旧)|其余(?:条件)?(?:一样|不变|相同)|同样条件|条件不变/.test(text);
  flags.compare = /哪个|比较|对比|差额|差异|更便宜|差多少/.test(text);
  flags.newScenario = /(?:另一个供应商|另一家|第二个供应商|新供应商|再报一个|另一个方案|方案\s*B|B\s*方案|乙供应商|换个供应商)/.test(text);
  flags.whatIf = /(?:如果|假如|若)/.test(text);
  flags.commit = /(?:就按|按这个|采用(?:这个|该)|确认(?:修改|重算)?)/.test(text);

  const term = findTerm(text);
  if (term) {
    pushSlot(slots, { field: 'priceTerm', value: term, quote: (text.match(/\b(?:FOB|CIF|CFR|C&F|CNF|EXW|FCA|DDP)\b/i) || text.match(/离岸价|到岸价|成本加运费/))?.[0] || term }, errors);
    if (!['FOB', 'CFR', 'CIF'].includes(term)) {
      errors.push({ field: 'priceTerm', code: 'unsupported_term', message: `暂不支持 ${term} 口径；本演示覆盖 FOB、CFR、CIF。`, quote: term });
    }
  }

  const currency = findCurrency(text);
  if (currency) pushSlot(slots, { field: 'currency', value: currency, quote: (text.match(CUR) || [])[0] || currency }, errors);

  // 汇率（先处理反向报价）
  let fxHandled = false;
  const inverse = text.match(new RegExp(String.raw`(?:人民币|CNY)\s*(?:兑|换|对)\s*(?:美元|USD)\s*(?:为|是|:|=)?\s*${NUM}`, 'i'));
  if (inverse) {
    const v = D.parse(cleanNumber(inverse[1]));
    if (v <= 0n) {
      errors.push({ field: 'fx', code: 'fx_not_positive', message: '汇率必须大于 0。', quote: inverse[0] });
    } else {
      const fx = D.div(D.parse('1'), v);
      pushSlot(slots, {
        field: 'fx',
        value: D.formatFixed(fx, 4),
        quote: inverse[0],
        derivedInverse: true,
        note: `你给的是“1 元人民币兑 ${D.format(v, 4)} 美元”，程序按 ${D.formatFixed(fx, 4)} 元/美元换算。`
      }, errors);
      notes.push(`汇率方向已换算：${inverse[0]} → ${D.formatFixed(fx, 4)} 元/美元。`);
      fxHandled = true;
    }
  }
  if (!fxHandled) {
    const direct = text.match(new RegExp(String.raw`(?:美元|USD)\s*(?:兑|换|对)\s*(?:人民币|CNY)\s*(?:为|是|:|=)?\s*${NUM}`, 'i'))
      || text.match(new RegExp(String.raw`1\s*(?:美元|USD)\s*(?:=|＝|兑换|兑|换)\s*${NUM}\s*(?:元|人民币)?`, 'i'));
    if (direct) {
      const v = D.parse(cleanNumber(direct[1]));
      if (v <= 0n) {
        errors.push({ field: 'fx', code: 'fx_not_positive', message: '汇率必须大于 0。', quote: direct[0] });
        pushSlot(slots, { field: 'fx', value: cleanNumber(direct[1]), quote: direct[0], note: '保留用户输入，等待修正。' }, errors);
      } else pushSlot(slots, { field: 'fx', value: D.formatFixed(v, 4), quote: direct[0], note: '汇率方向：1 美元兑多少元人民币。' }, errors);
      fxHandled = true;
    }
  }
  if (!fxHandled) {
    const fxMatch = text.match(new RegExp(String.raw`汇率\s*(?:为|是|改成|改为|涨到|跌到|升到|降到|调到|变成|到|:|=)?\s*${NUM}`, 'i'));
    if (fxMatch) {
      const v = D.parse(cleanNumber(fxMatch[1]));
      if (v <= 0n) {
        errors.push({ field: 'fx', code: 'fx_not_positive', message: '汇率必须大于 0。', quote: fxMatch[0] });
        pushSlot(slots, { field: 'fx', value: cleanNumber(fxMatch[1]), quote: fxMatch[0], note: '保留用户输入，等待修正。' }, errors);
      } else pushSlot(slots, { field: 'fx', value: D.formatFixed(v, 4), quote: fxMatch[0], note: '汇率方向：1 美元兑多少元人民币。' }, errors);
      fxHandled = true;
    }
  }

  // 总价（CIF/CFR 或显式“总价”）
  const totalPatterns = [
    new RegExp(String.raw`(?:总价|总报价|报价总额|合同总价|整批报价|采购总价)\s*(?:为|是|报|:|=)?\s*${NUM}\s*${CUR}?`, 'i'),
    new RegExp(String.raw`(?:CIF|CFR|C&F|CNF)\s*(?:总价|报价|价|总额)?\s*(?:为|是|报|:|=)?\s*${NUM}\s*${CUR}?`, 'i'),
    new RegExp(String.raw`报价\s*(?:为|是|:|=)?\s*${NUM}\s*${CUR}\s*(?:的)?\s*(?:CIF|CFR)`, 'i')
  ];
  let totalHandled = false;
  for (const re of totalPatterns) {
    const m = text.match(re);
    if (!m) continue;
    const before = text.slice(Math.max(0, m.index - 6), m.index);
    if (/每件|单价/.test(before)) continue;
    pushSlot(slots, { field: 'totalPrice', value: cleanNumber(m[1]), quote: m[0] }, errors);
    totalHandled = true;
    break;
  }

  // 单价（与总价同时出现时保留两者，由程序报告口径冲突，而不是静默丢弃）
  {
    const unitPatterns = [
      new RegExp(String.raw`(?:单价|每件|每个|每台|每套)\s*(?:为|是|报价|:|=)?\s*${NUM}\s*${CUR}?`, 'i'),
      new RegExp(String.raw`${NUM}\s*${CUR}\s*(?:\/|每)\s*(?:件|台|套|个)`, 'i')
    ];
    for (const re of unitPatterns) {
      const m = text.match(re);
      if (m) {
        pushSlot(slots, { field: 'unitPrice', value: cleanNumber(m[1]), quote: m[0] }, errors);
        break;
      }
    }
  }

  // 数量（避免把“100 个点”当数量）
  const qtyExplicit = text.match(new RegExp(String.raw`(?:数量|共|一共|合计|采购)\s*(?:为|是|:|=|改成|改为)?\s*${NUM}\s*${QTY_UNIT}`, 'i'));
  const qtyBare = text.match(new RegExp(String.raw`${NUM}\s*${QTY_UNIT}(?!点)`, 'i'));
  const qtyMatch = qtyExplicit || qtyBare;
  if (qtyMatch) {
    pushSlot(slots, { field: 'quantity', value: cleanNumber(qtyMatch[1]), quantityUnit: qtyMatch[2], quote: qtyMatch[0] }, errors);
  }

  // 运费（区分每件 / 整批；支持“每件运费 1 美元”与“运费每件 1 美元”两种语序）
  const freight = text.match(new RegExp(String.raw`(每件|单件|每箱|整批|一共|共)?\s*(?:国际)?运费\s*(?:为|是|改成|改为|:|=)?\s*(每件|单件|每箱|整批|一共|共)?\s*${NUM}\s*${CUR}?`, 'i'));
  if (freight) {
    const basisText = `${freight[1] || ''}${freight[2] || ''}`;
    const basis = /每|单/.test(basisText) ? 'per_unit' : 'lot';
    pushSlot(slots, { field: 'freight', value: cleanNumber(freight[3]), basis, quote: freight[0] }, errors);
  }

  // 保险费
  const insurance = text.match(new RegExp(String.raw`(每件|单件|每箱|整批|一共|共)?\s*(?:保险费|保险)\s*(?:为|是|改成|改为|:|=)?\s*(每件|单件|每箱|整批|一共|共)?\s*${NUM}\s*${CUR}?`, 'i'));
  if (insurance) {
    const basisText = `${insurance[1] || ''}${insurance[2] || ''}`;
    const basis = /每|单/.test(basisText) ? 'per_unit' : 'lot';
    pushSlot(slots, { field: 'insurance', value: cleanNumber(insurance[3]), basis, quote: insurance[0] }, errors);
  }

  // 关税税率：若写成金额（元）则明确拒绝，而不是当成税率
  const duty = text.match(new RegExp(String.raw`(?:进口)?关税(?:税率)?\s*(?:为|是|改成|改为|:|=)?\s*${NUM}\s*(%|个点|元|人民币)?`, 'i'));
  if (duty) {
    const unit = duty[2] || '';
    if (/元|人民币/.test(unit)) {
      errors.push({
        field: 'dutyRate',
        code: 'rate_not_percent',
        message: '这里需要的是关税“税率”（百分数，例如 10%），不是关税金额。若想直接给税额，请说明“关税金额”，本案例公式只接受税率。',
        quote: duty[0]
      });
    } else {
      pushSlot(slots, { field: 'dutyRate', value: cleanNumber(duty[1]), quote: duty[0] }, errors);
    }
  }

  // 进口增值税税率
  const vat = text.match(new RegExp(String.raw`(?:进口)?增值税(?:税率)?\s*(?:为|是|改成|改为|:|=)?\s*${NUM}\s*(%|个点|元|人民币)?`, 'i'));
  if (vat) {
    const unit = vat[2] || '';
    if (/元|人民币/.test(unit)) {
      errors.push({
        field: 'vatRate',
        code: 'rate_not_percent',
        message: '这里需要的是进口增值税“税率”（百分数，例如 13%），不是税额。',
        quote: vat[0]
      });
    } else {
      pushSlot(slots, { field: 'vatRate', value: cleanNumber(vat[1]), quote: vat[0] }, errors);
    }
  }

  // 消费税
  const excise = text.match(new RegExp(String.raw`消费税(?:税率)?\s*(?:为|是|改成|改为|:|=)?\s*${NUM}\s*(%|个点)?`, 'i'));
  if (excise) pushSlot(slots, { field: 'exciseRate', value: cleanNumber(excise[1]), quote: excise[0] }, errors);

  // “本案例不涉及消费税/国内费用”之类的显式声明
  if (/(?:消费税).*(?:不涉及|没有|不计|为零|按\s*0)/.test(text) && !excise) {
    pushSlot(slots, { field: 'exciseRate', value: '0', quote: '消费税不涉及', note: '按你的说明设为 0。' }, errors);
  }
  if (/(?:国内(?:其他)?费用|港杂费).*(?:不涉及|没有|不计|为零|按\s*0)/.test(text)) {
    pushSlot(slots, { field: 'domesticFees', value: '0', quote: '国内其他费用按 0', note: '按你的说明设为 0。' }, errors);
  }

  // 国内其他费用
  const domestic = text.match(new RegExp(String.raw`(?:国内(?:其他)?费用|国内费用|其他费用|港杂费|代理费|检验检疫费)\s*(?:为|是|改成|改为|:|=)?\s*${NUM}\s*(?:元|人民币|CNY)?`, 'i'));
  if (domestic) pushSlot(slots, { field: 'domesticFees', value: cleanNumber(domestic[1]), quote: domestic[0] }, errors);

  // 非数字输入：明确报错，不把文字当金额，也不静默忽略
  const invalidPatterns = [
    ['quantity', /(?:数量|商品数量|件数)\s*(?:为|是|改成|改为|:)?\s*(很多|若干|一些|未知|不清楚|不是数字|随便|不少)/],
    ['unitPrice', /(?:单价|每件)\s*(?:为|是|改成|改为|:)?\s*(很多|若干|一些|未知|不清楚|不是数字|随便|不少)/],
    ['totalPrice', /(?:总价|总报价)\s*(?:为|是|改成|改为|:)?\s*(很多|若干|一些|未知|不清楚|不是数字|随便|不少)/],
    ['freight', /运费\s*(?:为|是|改成|改为|:)?\s*(很多|若干|一些|未知|不清楚|不是数字|随便|不少|abc)/i],
    ['insurance', /(?:保险费|保险)\s*(?:为|是|改成|改为|:)?\s*(很多|若干|一些|未知|不清楚|不是数字|随便|不少|abc)/i],
    ['fx', /汇率\s*(?:为|是|改成|改为|:)?\s*(很多|若干|一些|未知|不清楚|不是数字|随便|不少|abc)/i],
    ['dutyRate', /关税(?:税率)?\s*(?:为|是|改成|改为|:)?\s*(很多|若干|一些|未知|不清楚|不是数字|随便|不少|abc)/i],
    ['vatRate', /(?:进口)?增值税(?:税率)?\s*(?:为|是|改成|改为|:)?\s*(很多|若干|一些|未知|不清楚|不是数字|随便|不少|abc)/i]
  ];
  for (const [field, re] of invalidPatterns) {
    if (slots.some(s => s.field === field)) continue;
    const m = text.match(re);
    if (m) {
      errors.push({
        field,
        code: 'not_a_number',
        message: `「${C.FIELDS[field].label}」需要一个数字（例如 100 或 7.2），这次没有把“${m[1]}”当成金额。`,
        quote: m[0]
      });
    }
  }

  let intent = intentFrom(text, slots, term);
  if (intent === 'unknown' && isCampus(text)) intent = 'campus';
  if (intent === 'new_scenario') flags.newScenario = true;

  return {
    intent,
    text,
    slots,
    term,
    flags,
    errors,
    notes,
    campus: isCampus(text),
    model: { mode: 'simulated', name: 'rules-v1', deterministic: true }
  };
}

function isBareNumber(text) {
  return new RegExp(String.raw`^\s*${NUM}\s*(%|美元|美金|USD|元|人民币|CNY)?\s*$`, 'i').test(normalizeText(text));
}

function bareNumber(text) {
  const m = normalizeText(text).match(new RegExp(String.raw`^\s*${NUM}\s*(%|美元|美金|USD|元|人民币|CNY)?\s*$`, 'i'));
  if (!m) return null;
  return { value: cleanNumber(m[1]), unit: m[2] || null };
}

function ordinalChoice(text) {
  const t = normalizeText(text);
  const map = { 第一个: 0, 第一: 0, 一: 0, 前一个: 0, 上一个: 0, 1: 0, 第二个: 1, 第二: 1, 二: 1, 2: 1, 第三个: 2, 第三: 2, 三: 2, 3: 2, 都行: 0, 第一个吧: 0 };
  if (Object.hasOwn(map, t)) return map[t];
  if (/^\d+$/.test(t)) return Number(t) - 1;
  return null;
}

module.exports = {
  extractTradeProposal,
  normalizeText,
  isCampus,
  isBareNumber,
  bareNumber,
  ordinalChoice,
  findCurrency,
  findTerm
};
