'use strict';
// 十进制定点运算：所有数值以 1e-6 为最小单位存为 BigInt，避免二进制浮点误差。
// 规则：解析不接受科学计数法；乘法/除法/百分比均为“四舍五入、half-up、远离零”。
const SCALE = 6;
const FACTOR = 10n ** BigInt(SCALE);

class DecimalError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'DecimalError';
    this.code = code;
    this.detail = detail || null;
  }
}

function normalize(input) {
  if (input === null || input === undefined) throw new DecimalError('empty', '缺少数值');
  if (typeof input === 'bigint') return input;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new DecimalError('not_finite', '数值必须是有限数');
    input = String(input);
  }
  if (typeof input !== 'string') throw new DecimalError('not_string', '数值格式不支持');
  let s = input.trim();
  if (!s) throw new DecimalError('empty', '数值为空');
  s = s
    .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[．。]/g, '.')
    .replace(/[，]/g, ',')
    .replace(/[－—]/g, '-')
    .replace(/[＋]/g, '+');
  // 允许千分位，但必须是规范的 1,234,567 形式
  if (s.includes(',')) {
    if (!/^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(s)) throw new DecimalError('bad_separator', '千分位格式不正确');
    s = s.replace(/,/g, '');
  }
  const m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new DecimalError('not_decimal', '请输入数字，例如 100 或 7.20');
  const sign = m[1] === '-' ? -1n : 1n;
  const whole = m[2];
  let frac = m[3] || '';
  if (frac.length > SCALE) throw new DecimalError('too_many_decimals', `最多支持 ${SCALE} 位小数`);
  frac = frac.padEnd(SCALE, '0');
  return sign * (BigInt(whole) * FACTOR + BigInt(frac || '0'));
}

function divRoundHalfUp(numerator, denominator) {
  if (denominator === 0n) throw new DecimalError('divide_by_zero', '除数不能为零');
  const neg = (numerator < 0n) !== (denominator < 0n);
  const a = numerator < 0n ? -numerator : numerator;
  const b = denominator < 0n ? -denominator : denominator;
  let q = a / b;
  const r = a % b;
  if (r * 2n >= b) q += 1n;
  return neg ? -q : q;
}

function add(a, b) { return normalize(a) + normalize(b); }
function sub(a, b) { return normalize(a) - normalize(b); }
function neg(a) { return -normalize(a); }
function abs(a) { return normalize(a) < 0n ? -normalize(a) : normalize(a); }
function cmp(a, b) { const x = normalize(a), y = normalize(b); return x === y ? 0 : (x < y ? -1 : 1); }
function isZero(a) { return normalize(a) === 0n; }

// 定点乘法：两个 1e-6 单位相乘后回到 1e-6 单位
function mul(a, b) {
  return divRoundHalfUp(normalize(a) * normalize(b), FACTOR);
}

function div(a, b) {
  return divRoundHalfUp(normalize(a) * FACTOR, normalize(b));
}

// 百分比：amount × percent% ，percent 以 10 表示 10%
function applyPercent(amount, percent) {
  return divRoundHalfUp(normalize(amount) * normalize(percent), 100n * FACTOR);
}

// 百分比占比：a / total × 100，结果以 1e-6 表示百分数
function sharePercent(part, total) {
  return divRoundHalfUp(normalize(part) * 100n * FACTOR, normalize(total));
}

// 舍入到指定小数位（0–6），仍返回 1e-6 单位
function roundTo(value, places) {
  if (!Number.isInteger(places) || places < 0 || places > SCALE) throw new DecimalError('bad_places', '舍入位数不支持');
  const step = 10n ** BigInt(SCALE - places);
  return divRoundHalfUp(normalize(value), step) * step;
}

function truncTo(value, places) {
  const step = 10n ** BigInt(SCALE - places);
  const v = normalize(value);
  const q = v / step;
  return q * step;
}

function format(value, places = 2, options = {}) {
  const { group = true, keepSign = false } = options;
  const rounded = roundTo(value, places);
  const v = rounded < 0n ? -rounded : rounded;
  const whole = v / FACTOR;
  const fracRaw = (v % FACTOR).toString().padStart(SCALE, '0').slice(0, places);
  let wholeText = whole.toString();
  if (group) wholeText = wholeText.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = rounded < 0n ? '-' : (keepSign && rounded > 0n ? '+' : '');
  return places > 0 ? `${sign}${wholeText}.${fracRaw}` : `${sign}${wholeText}`;
}

function formatPlain(value, places = 2) { return format(value, places, { group: false }); }

// 不用千分位的“可复算”文本，供导出与公式代入使用
function formatFixed(value, places = 2) { return format(value, places, { group: false }); }

function percentText(value, places = 2) { return `${format(value, places, { group: false })}%`; }

function toCanonicalString(value, places = 2) { return formatPlain(roundTo(value, places), places); }

module.exports = {
  SCALE, FACTOR, DecimalError,
  parse: normalize, normalize,
  add, sub, neg, abs, cmp, isZero,
  mul, div, applyPercent, sharePercent,
  roundTo, truncTo,
  format, formatPlain, formatFixed, percentText, toCanonicalString,
  divRoundHalfUp
};
