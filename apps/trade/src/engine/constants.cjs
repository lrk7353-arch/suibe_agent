'use strict';
const DEMO_VERSION = 'trade-demo-v1.0.0';
const CASE_ID = 'TEACHING-CASE-SUIBE-2026';

const CURRENCIES = {
  USD: { code: 'USD', name: '美元', unitLabel: '美元', fxLabel: '元/美元', decimals: 2 },
  EUR: { code: 'EUR', name: '欧元', unitLabel: '欧元', fxLabel: '元/欧元', decimals: 2 },
  JPY: { code: 'JPY', name: '日元', unitLabel: '日元', fxLabel: '元/日元', decimals: 2 },
  HKD: { code: 'HKD', name: '港币', unitLabel: '港币', fxLabel: '元/港币', decimals: 2 },
  GBP: { code: 'GBP', name: '英镑', unitLabel: '英镑', fxLabel: '元/英镑', decimals: 2 },
  CNY: { code: 'CNY', name: '人民币', unitLabel: '元', fxLabel: '元/元', decimals: 2 }
};

const PRICE_TERMS = {
  FOB: {
    code: 'FOB',
    label: 'FOB（离岸价）',
    plain: 'FOB',
    includes: '报价只含货物本身，国际运费与保险费需另加',
    required: ['quantity', 'unitPrice', 'currency', 'freight', 'insurance', 'fx', 'dutyRate', 'vatRate']
  },
  CFR: {
    code: 'CFR',
    label: 'CFR（成本加运费）',
    plain: 'CFR',
    includes: '报价已含国际运费，保险费需另加',
    required: ['quantity', 'totalPrice', 'currency', 'insurance', 'fx', 'dutyRate', 'vatRate']
  },
  CIF: {
    code: 'CIF',
    label: 'CIF（到岸价）',
    plain: 'CIF',
    includes: '报价已含国际运费与保险费，不得重复叠加',
    required: ['quantity', 'totalPrice', 'currency', 'fx', 'dutyRate', 'vatRate']
  }
};

// 字段顺序即页面展示顺序
const FIELDS = {
  quantity: { label: '商品数量', kind: 'quantity', unit: '件' },
  priceTerm: { label: '报价口径', kind: 'enum', unit: '', options: ['FOB', 'CFR', 'CIF'] },
  currency: { label: '报价币种', kind: 'enum', unit: '', options: Object.keys(CURRENCIES) },
  unitPrice: { label: '商品单价', kind: 'moneyForeign', unit: '外币/件' },
  totalPrice: { label: '报价总价', kind: 'moneyForeign', unit: '外币（整批）' },
  freight: { label: '国际运费', kind: 'moneyForeign', unit: '外币（整批）' },
  insurance: { label: '保险费', kind: 'moneyForeign', unit: '外币（整批）' },
  fx: { label: '汇率', kind: 'fx', unit: '元/外币' },
  dutyRate: { label: '关税税率', kind: 'percent', unit: '%' },
  vatRate: { label: '进口增值税税率', kind: 'percent', unit: '%' },
  domesticFees: { label: '国内其他费用', kind: 'moneyCny', unit: '元' },
  exciseRate: { label: '消费税税率', kind: 'percent', unit: '%' }
};

// 本案例明确约定、需要始终显示的假设（不是静默默认值）
const CASE_ASSUMPTIONS = [
  {
    id: 'scope_outlay',
    text: '计算口径为“含进口税费支出合计”＝计税价格＋关税＋进口增值税；不等于会计成本。',
    source: '教学案例约定',
    appliesTo: '全部方案'
  },
  {
    id: 'excise_zero',
    text: '消费税：本案例不涉及，按 0 计。',
    source: '教学案例约定',
    appliesTo: '全部方案'
  },
  {
    id: 'domestic_zero',
    text: '国内其他费用：本案例暂按 0 计（港杂费、代理费、检验检疫、资金占用等均未计入）。',
    source: '教学案例约定',
    appliesTo: '全部方案'
  },
  {
    id: 'teaching_rates',
    text: '汇率、关税税率、进口增值税税率均为本案例的教学设定，不代表任何商品或任何时点的现行税率。',
    source: '教学案例约定',
    appliesTo: '全部方案'
  },
  {
    id: 'no_live_query',
    text: '本轮不查询实时汇率、商品归类、原产地规则或协定税率；如用于真实业务，需另行核对来源与适用条件。',
    source: '演示范围声明',
    appliesTo: '全部方案'
  },
  {
    id: 'vat_not_cost',
    text: '进口增值税能否抵扣取决于纳税人身份与凭证，本案例只把它计入“支出”，不直接称为可确认的会计成本。',
    source: '教学案例约定',
    appliesTo: '全部方案'
  }
];

const NOT_INCLUDED = [
  '消费税（本案例约定不涉及）',
  '国内其他费用（港杂费、代理费、检验检疫费等，本案例按 0 计）',
  '资金占用成本、汇兑损益与融资费用',
  '进口增值税的抵扣影响（本案例只计算支出）',
  '报关代理、仓储、滞箱、内陆运输等未列明费用',
  '真实商品归类、原产地与协定税率差异'
];

const ROUNDING_RULES = [
  '金额以十进制定点存储；金额保留 2 位小数，汇率保留 4 位小数，税率保留 2 位小数。',
  '每一步只对输出的金额做一次“四舍五入（half-up，远离零）”，后续步骤使用已舍入金额。',
  '关税＝计税价格×关税税率，结果保留 2 位；进口增值税＝（计税价格＋关税）×增值税税率，结果保留 2 位。',
  '合计＝计税价格＋关税＋进口增值税，使用已舍入的分项金额相加，不再二次舍入。',
  '每件对应支出＝合计÷数量，保留 2 位，仅作展示；不做“每件×数量=合计”的反向校验。'
];

const FORMULAS = [
  { id: 'F1', label: '商品总价', text: '商品总价 = 单价 × 数量（FOB）' },
  { id: 'F2', label: 'CIF 等值', text: 'CIF 等值 = 商品总价 + 国际运费 + 保险费（FOB）；CFR 报价另加保险费；CIF 报价即为总价' },
  { id: 'F3', label: '计税价格', text: '计税价格 = CIF 等值 × 汇率（人民币/外币）' },
  { id: 'F4', label: '关税', text: '关税 = 计税价格 × 关税税率' },
  { id: 'F5', label: '进口增值税', text: '进口增值税 =（计税价格 + 关税）× 进口增值税税率' },
  { id: 'F6', label: '支出合计', text: '含进口税费支出合计 = 计税价格 + 关税 + 进口增值税' },
  { id: 'F7', label: '每件支出', text: '每件对应支出 = 支出合计 ÷ 商品数量（展示值）' }
];

const THINKING_PROMPTS = [
  '汇率变化对这笔订单影响多大？',
  '两个报价是否包含相同费用？',
  '还有哪些支出尚未计入？'
];

const LEARNING_CARDS = [
  {
    id: 'fob',
    term: 'FOB 离岸价',
    text: 'FOB 只覆盖货物装上船前的成本。进口方还要自己承担国际运费、保险费和进口税费。'
  },
  {
    id: 'cif',
    term: 'CIF 到岸价',
    text: 'CIF 报价已包含成本、保险费和运费。比较时如果再把运费、保险费加一遍，就会重复计入。'
  },
  {
    id: 'fx',
    term: '汇率方向',
    text: '本案例汇率写作“1 美元＝7.00 元人民币”。数值变大表示人民币贬值，进口同样一批货要花更多人民币。'
  },
  {
    id: 'duty',
    term: '计税价格与关税',
    text: '本案例先用 CIF 等值折成人民币得到计税价格，再按给定税率算关税；进口增值税在“计税价格＋关税”的基础上计算。'
  },
  {
    id: 'scope',
    term: '支出不等于会计成本',
    text: '“含进口税费支出”是现金流出口径。进口增值税能否抵扣、存货如何入账，需要按纳税人身份和会计政策另算。'
  }
];

const CAMPUS_PATTERNS = [
  '借阅', '续借', '还书', '图书馆', '校园网', 'portal', 'Portal', 'Wi-Fi', 'wifi', '网络',
  '食堂', '宿舍', '选课', '成绩', '考试', '补考', '缓考', '转专业', '校历', '校车', '一卡通',
  '学费', '住宿费', '报到', '新生', '奖学金', '助学金', '报修', '电费', '水费', '快递',
  '教务处', '学工', '辅导员', '门诊', '校医院', '体育', '体测'
];

const FIELD_META_SOURCE_TEXT = {
  user: '用户填写',
  inherited: '沿用其他方案',
  case_assumption: '案例约定',
  example: '示例值',
  derived: '由程序换算',
  na: '不适用',
  missing: '待填写'
};

function currencyInfo(code) { return CURRENCIES[code] || CURRENCIES.USD; }
function termInfo(code) { return PRICE_TERMS[code] || null; }
function fieldLabel(field, scenario) {
  const def = FIELDS[field];
  if (!def) return field;
  if (field === 'quantity') return `商品数量（${scenario?.quantityUnit || '件'}）`;
  if (field === 'unitPrice') return `商品单价（${currencyInfo(scenario?.currency).unitLabel}/${scenario?.quantityUnit || '件'}）`;
  if (field === 'totalPrice') return `报价总价（${currencyInfo(scenario?.currency).unitLabel}，整批）`;
  if (field === 'freight') return `国际运费（${currencyInfo(scenario?.currency).unitLabel}，整批）`;
  if (field === 'insurance') return `保险费（${currencyInfo(scenario?.currency).unitLabel}，整批）`;
  if (field === 'fx') return `汇率（${currencyInfo(scenario?.currency).fxLabel}）`;
  if (field === 'domesticFees') return '国内其他费用（元）';
  return def.label;
}

module.exports = {
  DEMO_VERSION, CASE_ID,
  CURRENCIES, PRICE_TERMS, FIELDS,
  CASE_ASSUMPTIONS, NOT_INCLUDED, ROUNDING_RULES, FORMULAS,
  THINKING_PROMPTS, LEARNING_CARDS, CAMPUS_PATTERNS,
  FIELD_META_SOURCE_TEXT,
  currencyInfo, termInfo, fieldLabel
};
