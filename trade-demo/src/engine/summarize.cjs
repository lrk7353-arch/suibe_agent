'use strict';
const crypto = require('node:crypto');
const C = require('./constants.cjs');
const D = require('./decimal.cjs');
const T = require('./tools.cjs');
const S = require('./state.cjs');

function shanghaiStamp(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(new Date(now));
  const get = type => parts.find(p => p.type === type)?.value || '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}:${get('second')}` };
}

function fileStamp(now = Date.now()) {
  const { date, time } = shanghaiStamp(now);
  return `${date.replace(/-/g, '')}-${time.replace(/:/g, '').slice(0, 4)}`;
}

function readScenarioValue(scenario, field) {
  if (field === 'priceTerm') return scenario.priceTerm;
  if (field === 'currency') return scenario.currency;
  return scenario.input?.[field];
}

function displayValue(scenario, field) {
  const raw = readScenarioValue(scenario, field);
  if (raw === undefined || raw === null || raw === '') return '—';
  if (field === 'quantity') return `${D.format(D.parse(raw), 0)} ${scenario.quantityUnit || '件'}`;
  if (field === 'priceTerm') return C.PRICE_TERMS[raw]?.label || raw;
  if (field === 'currency') return `${C.currencyInfo(raw).name}（${raw}）`;
  if (field === 'unitPrice') return `${D.format(D.parse(raw), 2)} ${C.currencyInfo(scenario.currency).unitLabel}/${scenario.quantityUnit || '件'}`;
  if (field === 'totalPrice' || field === 'freight' || field === 'insurance') return `${D.format(D.parse(raw), 2)} ${C.currencyInfo(scenario.currency).unitLabel}`;
  if (field === 'fx') return `${D.format(D.parse(raw), 4)} ${C.currencyInfo(scenario.currency).fxLabel}`;
  if (['dutyRate', 'vatRate', 'exciseRate'].includes(field)) return `${D.format(D.parse(raw), 2)}%`;
  if (field === 'domesticFees') return `${D.format(D.parse(raw), 2)} 元`;
  return String(raw);
}

function checkFreshness(scenario) {
  const validation = T.validateTradeInputs(scenario);
  if (!validation.ok) return { ok: false, code: 'scenario_incomplete', validation };
  const recalc = T.calculateImportOutlay(scenario);
  if (!recalc.ok) return { ok: false, code: 'recalc_failed', validation: recalc.validation };
  if (!scenario.result || scenario.result.hash !== recalc.hash || scenario.result.inputHash !== recalc.inputHash) {
    return { ok: false, code: 'stale_result', recalc };
  }
  return { ok: true, result: recalc, validation };
}

function buildSummaryData(state, now = Date.now()) {
  const scenarios = [];
  for (const scenario of state.scenarios) {
    const validation = T.validateTradeInputs(scenario);
    if (!validation.ok) {
      scenarios.push({ id: scenario.id, label: scenario.label, incomplete: true, pending: validation.missing.concat(validation.errors.map(e => ({ field: e.field, label: e.message }))) });
      continue;
    }
    const fresh = checkFreshness(scenario);
    if (!fresh.ok) return { ok: false, code: fresh.code, message: fresh.code === 'stale_result' ? `${scenario.label}的结果与当前参数不一致，需要先重算。` : `${scenario.label}还不能导出。` };
    scenarios.push({
      id: scenario.id,
      label: scenario.label,
      incomplete: false,
      priceTerm: scenario.priceTerm,
      priceTermLabel: C.PRICE_TERMS[scenario.priceTerm]?.label || scenario.priceTerm,
      currency: scenario.currency,
      quantityUnit: scenario.quantityUnit || '件',
      rows: S.summarizeInputs(scenario),
      result: fresh.result,
      resultHash: fresh.result.hash,
      inputHash: fresh.result.inputHash,
      meta: scenario.meta,
      notes: scenario.notes
    });
  }
  const complete = scenarios.filter(s => !s.incomplete);
  if (!complete.length) return { ok: false, code: 'nothing_to_export', message: '还没有可导出的完整方案。请先补齐参数并完成计算。' };
  let comparison = null;
  if (complete.length >= 2) {
    const rawScenarios = state.scenarios.filter(s => complete.some(c => c.id === s.id));
    // 导出以页面中第一个完整方案为基准（通常是方案 A），保证差额符号与文字方向一致
    comparison = T.compareTradeScenarios({ scenarios: rawScenarios, baselineId: rawScenarios[0].id });
  }
  const stamp = shanghaiStamp(now);
  return {
    ok: true,
    data: {
      caseId: C.CASE_ID,
      title: '小贸 · 进口成本案例摘要',
      generatedAt: `${stamp.date} ${stamp.time}（Asia/Shanghai）`,
      generatedAtIso: new Date(now).toISOString(),
      stateVersion: state.version,
      phase: state.phase,
      mode: '教学案例（固定数据，非实时查询）',
      scope: '按本案例给定条件计算：含进口税费支出＝计税价格＋关税＋进口增值税；不等于可确认的会计成本。',
      scenarios: complete,
      incomplete: scenarios.filter(s => s.incomplete),
      comparison,
      assumptions: C.CASE_ASSUMPTIONS,
      notIncluded: C.NOT_INCLUDED,
      roundingRules: C.ROUNDING_RULES,
      formulas: C.FORMULAS,
      sources: [
        { id: 'user_case', text: '本案例的数量、报价、运费、保险费、汇率与税率由用户在演示中给定，属于教学设定。', url: null },
        { id: 'no_live_query', text: '本轮未查询实时汇率、商品归类、原产地规则或协定税率；不构成真实业务或税务意见。', url: null },
        { id: 'calc_rules', text: '计算规则为本演示约定的教学简化公式，明细见“计算公式与代入”。', url: null }
      ],
      provenance: {
        calcVersion: T.CALC_VERSION,
        demoVersion: C.DEMO_VERSION,
        stateSchema: S.STATE_SCHEMA,
        exportedBy: '小贸经贸演示 v1',
        checks: [
          `导出时逐方案重算，结果指纹与页面一致（状态版本 v${state.version}）。`,
          '所有金额由十进制定点程序计算，不使用模型生成的数值。',
          '导出内容只包含当前方案，不包含已取消或未完成的草案。'
        ]
      }
    }
  };
}

function mdEscape(text) { return String(text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' '); }
function htmlEscape(text) { return String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }

function cellText(row) {
  if (!row) return '—';
  if (!row.applicable) return '不适用';
  if (row.value === null) return '待填写';
  const display = row.display ?? row.value;
  if (row.unit === '%') return `${display}%`;
  return `${display}${row.unit ? ' ' + row.unit : ''}`;
}

function trimNumber(text) {
  if (!text.includes('.')) return text;
  return text.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

function traceValue(step) {
  return `${D.format(D.parse(step.value), 2)} ${step.currency === 'CNY' ? '元' : C.currencyInfo(step.currency).unitLabel}`;
}

function traceRawNeeded(step) {
  try { return D.parse(step.raw) !== D.parse(step.value); } catch { return false; }
}

function traceRawText(step) {
  return trimNumber(D.format(D.parse(step.raw), 6));
}

function markdown(data) {
  const lines = [];
  lines.push(`# ${data.title}`);
  lines.push('');
  lines.push(`生成时间：${data.generatedAt}　｜　案例：${data.caseId}　｜　状态版本：v${data.stateVersion}`);
  lines.push(`数据性质：${data.mode}`);
  lines.push('');
  lines.push(`> ${data.scope}`);
  lines.push('');
  lines.push('## 一、结论');
  lines.push('');
  if (data.scenarios.length === 1) {
    const s = data.scenarios[0];
    lines.push(`- ${s.label}（${s.priceTerm}）：含进口税费支出合计 **${s.result.amounts.outlay.text}**，每件 **${s.result.amounts.perUnit.text}**。`);
  } else {
    for (const s of data.scenarios) {
      lines.push(`- ${s.label}（${s.priceTerm}）：含进口税费支出合计 **${s.result.amounts.outlay.text}**，每件 **${s.result.amounts.perUnit.text}**。`);
    }
    if (data.comparison?.ok) {
      const d = data.comparison.differences[0];
      lines.push(`- 比较：${data.comparison.cheaper.label} 更低，比${data.comparison.scenarios[0].label} 少 **${d.diffText.replace(/^[+-]/, '')}**（${d.diffPercentText}）；两方案已统一为 CIF 等值口径。`);
    } else if (data.comparison && !data.comparison.ok) {
      lines.push(`- 比较：${data.comparison.message}`);
    }
  }
  lines.push('');
  lines.push('## 二、输入条件');
  lines.push('');
  const fields = data.scenarios[0].rows.map(r => r.field);
  lines.push(`| 参数 | ${data.scenarios.map(s => mdEscape(s.label)).join(' | ')} | 来源 |`);
  lines.push(`|---|${data.scenarios.map(() => '---:').join('|')}|---|`);
  for (const field of fields) {
    const first = data.scenarios[0].rows.find(r => r.field === field);
    const cells = data.scenarios.map(s => mdEscape(cellText(s.rows.find(r => r.field === field))));
    if (cells.every(c => c === '不适用')) continue;
    const sources = [...new Set(data.scenarios
      .map(s => s.rows.find(r => r.field === field))
      .filter(r => r && r.applicable && r.value !== null)
      .map(r => r.sourceText))];
    lines.push(`| ${mdEscape(first.label)} | ${cells.join(' | ')} | ${mdEscape(sources.join(' / ') || '—')} |`);
  }
  lines.push('');
  lines.push('## 三、计算公式与代入');
  lines.push('');
  for (const s of data.scenarios) {
    lines.push(`### ${s.label}（${s.priceTerm} ${C.PRICE_TERMS[s.priceTerm]?.label.match(/（(.+)）/)?.[1] || ''}）`);
    lines.push('');
    for (const step of s.result.trace) {
      const rawNote = traceRawNeeded(step) ? `　未舍入：${traceRawText(step)}` : '';
      lines.push(`${step.label}：${step.formula} = **${traceValue(step)}**${rawNote}`);
      lines.push('');
    }
  }
  lines.push('### 舍入规则');
  lines.push('');
  for (const rule of data.roundingRules) lines.push(`- ${rule}`);
  lines.push('');
  lines.push('## 四、结果明细');
  lines.push('');
  lines.push(`| 项目 | ${data.scenarios.map(s => mdEscape(s.label)).join(' | ')} |`);
  lines.push(`|---|${data.scenarios.map(() => '---:').join('|')}|`);
  const amountRows = [
    ['货值 / 报价金额', 'goodsTotal'], ['国际运费', 'freightTotal'], ['保险费', 'insuranceTotal'],
    ['CIF 等值', 'cifEquivalent'], ['计税价格', 'taxableValue'], ['关税', 'duty'],
    ['进口增值税', 'vat'], ['含进口税费支出合计', 'outlay'], ['每件对应支出', 'perUnit'],
    ['国内其他费用', 'domesticFees'], ['含国内费用合计', 'grandTotal']
  ];
  const amountCell = (s, key) => {
    if (key === 'freightTotal' && (s.priceTerm === 'CIF' || s.priceTerm === 'CFR')) return `已含在 ${s.priceTerm} 报价`;
    if (key === 'insuranceTotal' && s.priceTerm === 'CIF') return '已含在 CIF 报价';
    return s.result.amounts[key]?.text || '—';
  };
  for (const [label, key] of amountRows) {
    const cells = data.scenarios.map(s => amountCell(s, key));
    lines.push(`| ${label} | ${cells.join(' | ')} |`);
  }
  lines.push('');
  for (const s of data.scenarios) {
    lines.push(`- ${s.label} 构成：${s.result.display.compositionSummary}`);
  }
  lines.push('');
  if (data.comparison) {
    lines.push('## 五、方案对比');
    lines.push('');
    if (data.comparison.ok) {
      lines.push(data.comparison.basisNote);
      lines.push('');
      for (const s of data.comparison.scenarios) {
        lines.push(`- ${s.label}：${s.priceTermLabel}，CIF 等值 ${s.cifEquivalent}，支出 ${s.outlayText}，每件 ${s.perUnit.split(' ')[0]} 元。`);
      }
      lines.push('');
      const baselineLabel = data.comparison.scenarios.find(s => s.id === data.comparison.baselineId)?.label || '基准方案';
      for (const d of data.comparison.differences) {
        const dir = d.diffFromBaseline.startsWith('-') ? '少' : '多';
        lines.push(`- 差额：${d.label} 比${baselineLabel} ${dir} ${d.diffText.replace(/^[+-]/, '')}（${d.diffPercentText}），每件${dir} ${d.perUnitDiffText.replace(/^[+-]/, '')}。`);
      }
    } else {
      lines.push(data.comparison.message);
      for (const reason of data.comparison.reasons || []) lines.push(`- ${reason}`);
    }
    lines.push('');
  }
  lines.push(`## ${data.comparison ? '六' : '五'}、假设与适用范围`);
  lines.push('');
  for (const a of data.assumptions) lines.push(`- ${a.text}（来源：${a.source}）`);
  lines.push('');
  lines.push(`## ${data.comparison ? '七' : '六'}、未计入项目`);
  lines.push('');
  for (const item of data.notIncluded) lines.push(`- ${item}`);
  lines.push('');
  lines.push(`## ${data.comparison ? '八' : '七'}、来源与依据`);
  lines.push('');
  for (const s of data.sources) lines.push(`- ${s.text}`);
  lines.push('');
  lines.push(`## ${data.comparison ? '九' : '八'}、复算与一致性`);
  lines.push('');
  for (const s of data.scenarios) {
    lines.push(`- ${s.label} 输入指纹（SHA-256）：\`${s.inputHash}\``);
    lines.push(`- ${s.label} 结果指纹（SHA-256）：\`${s.resultHash}\``);
  }
  lines.push(`- 页面状态版本：v${data.stateVersion}`);
  for (const check of data.provenance.checks) lines.push(`- ${check}`);
  lines.push('');
  lines.push('---');
  lines.push(`由 ${data.provenance.exportedBy} 生成。修改任一参数后请重新计算并重新导出，旧摘要不自动更新。`);
  lines.push('');
  return lines.join('\n');
}

function html(data) {
  const rows = [];
  const fields = data.scenarios[0].rows.map(r => r.field);
  for (const field of fields) {
    const first = data.scenarios[0].rows.find(r => r.field === field);
    const cells = data.scenarios.map(s => {
      const row = s.rows.find(r => r.field === field);
      if (!row) return '<td>—</td>';
      if (!row.applicable) return '<td class="na">不适用</td>';
      if (row.value === null) return '<td><span class="pending">待填写</span></td>';
      return `<td>${htmlEscape(cellText(row))}</td>`;
    });
    if (cells.every(c => c.includes('不适用'))) continue;
    const sources = [...new Set(data.scenarios
      .map(s => s.rows.find(r => r.field === field))
      .filter(r => r && r.applicable && r.value !== null)
      .map(r => r.sourceText))];
    rows.push(`<tr><th>${htmlEscape(first.label)}</th>${cells.join('')}<td class="muted">${htmlEscape(sources.join(' / ') || '—')}</td></tr>`);
  }
  const resultRows = [
    ['货值 / 报价金额', 'goodsTotal'], ['国际运费', 'freightTotal'], ['保险费', 'insuranceTotal'], ['CIF 等值', 'cifEquivalent'],
    ['计税价格', 'taxableValue'], ['关税', 'duty'], ['进口增值税', 'vat'], ['含进口税费支出合计', 'outlay'],
    ['每件对应支出', 'perUnit'], ['国内其他费用', 'domesticFees'], ['含国内费用合计', 'grandTotal']
  ].map(([label, key]) => `<tr><th>${label}</th>${data.scenarios.map(s => {
    let text = s.result.amounts[key]?.text || '—';
    if (key === 'freightTotal' && (s.priceTerm === 'CIF' || s.priceTerm === 'CFR')) text = `已含在 ${s.priceTerm} 报价`;
    if (key === 'insuranceTotal' && s.priceTerm === 'CIF') text = '已含在 CIF 报价';
    return `<td class="${key === 'outlay' ? 'strong' : ''}">${htmlEscape(text)}</td>`;
  }).join('')}</tr>`).join('');
  const traceBlocks = data.scenarios.map(s => `
    <section class="block">
      <h3>${htmlEscape(s.label)}（${htmlEscape(s.priceTerm)}）</h3>
      <ol class="trace">${s.result.trace.map(step => `<li><span>${htmlEscape(step.label)}</span><code>${htmlEscape(step.formula)}</code><strong>${htmlEscape(traceValue(step))}</strong>${traceRawNeeded(step) ? `<small>未舍入 ${htmlEscape(traceRawText(step))}</small>` : ''}</li>`).join('')}</ol>
    </section>`).join('');
  const compareBlock = data.comparison?.ok ? `
    <section class="block">
      <h2>方案对比</h2>
      <p>${htmlEscape(data.comparison.basisNote)}</p>
      <table><thead><tr><th>方案</th><th>口径</th><th>CIF 等值</th><th>支出合计</th><th>每件</th></tr></thead><tbody>
      ${data.comparison.scenarios.map(s => `<tr><td>${htmlEscape(s.label)}</td><td>${htmlEscape(s.priceTermLabel)}</td><td>${htmlEscape(s.cifEquivalent)}</td><td>${htmlEscape(s.outlayText)}</td><td>${htmlEscape(s.perUnitText)}</td></tr>`).join('')}
      </tbody></table>
      ${data.comparison.differences.map(d => `<p class="diff">${htmlEscape(d.label)} 相对 ${htmlEscape(data.comparison.baselineId)}：<strong>${htmlEscape(d.diffText)}</strong>（${htmlEscape(d.diffPercentText)}），每件 ${htmlEscape(d.perUnitDiffText)}。</p>`).join('')}
    </section>` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(data.title)}</title>
<style>
:root{--blue:#0066b3;--deep:#123d65;--ink:#18354e;--muted:#577086;--line:#d9e4ed;--wash:#f4f8fb;--sky:#e7f2fa;--amber:#9a6100}
*{box-sizing:border-box}body{margin:0;background:var(--wash);color:var(--ink);font:15px/1.7 "Microsoft YaHei","PingFang SC",system-ui,sans-serif}
main{max-width:900px;margin:0 auto;padding:40px 28px 64px;background:white}
h1{font-size:28px;color:var(--deep);margin:0 0 8px}h2{font-size:20px;color:var(--deep);margin:32px 0 12px}h3{font-size:17px;color:var(--deep);margin:20px 0 8px}
.meta{color:var(--muted);font-size:13px;margin-bottom:20px}
.scope{background:var(--sky);border-left:4px solid var(--blue);padding:12px 16px;border-radius:0 8px 8px 0}
table{width:100%;border-collapse:collapse;margin:12px 0 20px;font-size:14px}
th,td{border-bottom:1px solid var(--line);padding:9px 10px;text-align:left;vertical-align:top}
th{background:#f8fbfd;color:var(--deep);font-weight:600}td{font-variant-numeric:tabular-nums}
td.strong{color:var(--blue);font-weight:700;font-size:16px}
.block{border:1px solid var(--line);border-radius:12px;padding:16px 20px;margin:16px 0}
.trace{list-style:none;padding:0;margin:0;display:grid;gap:8px}
.trace li{display:grid;gap:2px;padding:10px 0;border-bottom:1px dashed var(--line)}
.trace li:last-child{border-bottom:0}
.trace span{font-size:12px;color:var(--muted)}
.trace code{font-family:"Cascadia Mono",Consolas,monospace;background:var(--wash);padding:4px 8px;border-radius:6px;font-size:13px}
.trace strong{color:var(--blue)}
.trace small{color:var(--amber)}
.diff{background:#fff8ec;border:1px solid #f1d9ae;border-radius:8px;padding:10px 14px}
.pending{color:var(--amber)}.na{color:var(--muted);font-size:12px}.muted{color:var(--muted);font-size:12px}
ul{padding-left:22px}footer{margin-top:36px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
@media print{body{background:white}main{padding:0;max-width:none}.block{break-inside:avoid}}
</style></head><body><main>
<h1>${htmlEscape(data.title)}</h1>
<p class="meta">生成时间：${htmlEscape(data.generatedAt)}　｜　案例：${htmlEscape(data.caseId)}　｜　状态版本：v${data.stateVersion}　｜　${htmlEscape(data.mode)}</p>
<p class="scope">${htmlEscape(data.scope)}</p>
<h2>一、结论</h2>
<ul>${data.scenarios.map(s => `<li>${htmlEscape(s.label)}（${htmlEscape(s.priceTerm)}）：含进口税费支出合计 <strong>${htmlEscape(s.result.amounts.outlay.text)}</strong>，每件 <strong>${htmlEscape(s.result.amounts.perUnit.text)}</strong>。</li>`).join('')}</ul>
${data.comparison?.ok ? `<p>${htmlEscape(data.comparison.note)}（${htmlEscape(data.comparison.differences[0]?.diffText || '')}）</p>` : ''}
<h2>二、输入条件</h2>
<table><thead><tr><th>参数</th>${data.scenarios.map(s => `<th>${htmlEscape(s.label)}</th>`).join('')}<th>来源</th></tr></thead><tbody>${rows.join('')}</tbody></table>
<h2>三、计算公式与代入</h2>
${traceBlocks}
<h3>舍入规则</h3><ul>${data.roundingRules.map(r => `<li>${htmlEscape(r)}</li>`).join('')}</ul>
<h2>四、结果明细</h2>
<table><thead><tr><th>项目</th>${data.scenarios.map(s => `<th>${htmlEscape(s.label)}</th>`).join('')}</tr></thead><tbody>${resultRows}</tbody></table>
${compareBlock}
<h2>${data.comparison ? '六' : '五'}、假设与适用范围</h2><ul>${data.assumptions.map(a => `<li>${htmlEscape(a.text)}（来源：${htmlEscape(a.source)}）</li>`).join('')}</ul>
<h2>${data.comparison ? '七' : '六'}、未计入项目</h2><ul>${data.notIncluded.map(i => `<li>${htmlEscape(i)}</li>`).join('')}</ul>
<h2>${data.comparison ? '八' : '七'}、来源与依据</h2><ul>${data.sources.map(s => `<li>${htmlEscape(s.text)}</li>`).join('')}</ul>
<h2>${data.comparison ? '九' : '八'}、复算与一致性</h2>
<ul>${data.scenarios.map(s => `<li>${htmlEscape(s.label)} 输入指纹：<code>${htmlEscape(s.inputHash)}</code><br>${htmlEscape(s.label)} 结果指纹：<code>${htmlEscape(s.resultHash)}</code></li>`).join('')}
<li>页面状态版本：v${data.stateVersion}</li>${data.provenance.checks.map(c => `<li>${htmlEscape(c)}</li>`).join('')}</ul>
<footer>由 ${htmlEscape(data.provenance.exportedBy)} 生成。修改任一参数后请重新计算并重新导出，旧摘要不自动更新。</footer>
</main></body></html>`;
}

function buildCaseSummary(state, format = 'markdown', now = Date.now()) {
  const built = buildSummaryData(state, now);
  if (!built.ok) return { ok: false, code: built.code, tool: 'export_case_summary', message: built.message };
  const data = built.data;
  let content, mime, ext;
  if (format === 'html') {
    content = html(data);
    mime = 'text/html; charset=utf-8';
    ext = 'html';
  } else if (format === 'json') {
    content = JSON.stringify({ ...data, format: 'json', checksumNote: '本文件自身不含校验和，页面会给出内容 SHA-256。' }, null, 2);
    mime = 'application/json; charset=utf-8';
    ext = 'json';
  } else {
    content = markdown(data);
    mime = 'text/markdown; charset=utf-8';
    ext = 'md';
  }
  const checksum = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  const filename = `小贸-进口成本案例-${fileStamp(now)}.${ext}`;
  return {
    ok: true,
    tool: 'export_case_summary',
    format,
    filename,
    mime,
    content,
    checksum,
    bytes: Buffer.byteLength(content, 'utf8'),
    stateVersion: state.version,
    scenarioIds: data.scenarios.map(s => s.id),
    generatedAt: data.generatedAt,
    data
  };
}

module.exports = { buildCaseSummary, buildSummaryData, markdown, html, shanghaiStamp, fileStamp };
