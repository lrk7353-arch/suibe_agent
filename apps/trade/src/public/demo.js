'use strict';
const $ = id => document.getElementById(id);
const SESSION_KEY = 'trade-demo-session-id';
const sessionId = (() => {
  try {
    const existing = sessionStorage.getItem(SESSION_KEY);
    if (existing) return existing;
    const created = 's' + Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem(SESSION_KEY, created);
    return created;
  } catch {
    return 's' + Math.random().toString(36).slice(2, 10);
  }
})();

const DEMO_CHIPS = [
  { step: '①', label: '开始算成本', text: '帮我算一下这批进口商品的成本。' },
  { step: '②', label: '数量与单价', text: '100 件，每件 10 美元，FOB。' },
  { step: '③', label: '运费、汇率与税率', text: '运费 100 美元、保险 10 美元，汇率 7，关税 10%，增值税 13%。' },
  { step: '④', label: '汇率试算 7.2', text: '如果汇率涨到 7.2 呢？' },
  { step: '⑤', label: '比较 CIF 报价', text: '另一个供应商报 CIF 总价 1,080 美元，其他条件一样，哪个支出更低？' },
  { step: '⑥', label: '导出摘要', text: '把两种方案整理成一份摘要。' }
];

let state = null;
let last = null;
let busy = false;
let level = 'quick';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function toast(text) {
  const node = $('toast');
  node.textContent = text;
  node.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => node.classList.remove('show'), 2400);
}

function setPet(pet) {
  const node = $('petStatus');
  const mood = pet?.mood || 'idle';
  node.className = 'pet-status' + (mood === 'alert' ? ' alert' : mood === 'remind' ? ' remind' : mood === 'cheer' ? ' cheer' : '');
  node.textContent = pet?.text || '等你开口';
}

function setBusy(value) {
  busy = value;
  $('send').disabled = value;
  $('q').disabled = value;
  $('send').textContent = value ? '计算中' : '发送';
}

function appendUser(text) {
  const wrap = el('article', 'message me');
  wrap.append(el('span', 'who', '你'), el('div', 'bubble', text));
  $('log').append(wrap);
  $('log').scrollTop = $('log').scrollHeight;
}

function appendBot(data) {
  const wrap = el('article', 'message bot');
  wrap.append(el('span', 'who', '小贸'));
  wrap.append(el('div', 'bubble', data.answer));
  if (data.detail) {
    const detail = document.createElement('details');
    detail.className = 'detail';
    detail.open = level === 'learn';
    detail.append(el('summary', '', '展开学习过程：公式与代入'));
    detail.append(el('pre', '', data.detail));
    wrap.append(detail);
  }
  const tools = [...new Set((data.toolCalls || []).map(t => t.name))];
  const parser = data.parser || { mode: 'simulated', name: 'rules-v1' };
  const parserLabel = parser.mode === 'simulated' ? `${parser.name}（模拟）` : `${parser.name}（真实模型）`;
  wrap.append(el('div', 'meta-line', `解析：${parserLabel}　｜　${data.mode || '本地处理'}　｜　状态 v${data.state?.version ?? '—'}`));
  if (tools.length) wrap.lastChild.title = `本次执行：${tools.join(' · ')}`;
  if (data.cards?.learning?.prompt) {
    const thinking = el('div', 'thinking');
    const button = el('button', '', `想一想：${data.cards.learning.prompt}`);
    button.type = 'button';
    button.addEventListener('click', () => send(data.cards.learning.prompt));
    thinking.append(button);
    wrap.append(thinking);
  }
  const actions = (data.actions || []).filter(a => a.kind !== 'download');
  if (actions.length) {
    const bar = el('div', 'answer-actions');
    for (const action of actions) {
      const button = el('button', action.primary ? 'primary' : '', action.label);
      button.type = 'button';
      button.addEventListener('click', () => runAction(action));
      bar.append(button);
    }
    wrap.append(bar);
  }
  $('log').append(wrap);
  const log = $('log');
  const top = wrap.offsetTop - log.offsetTop - 6;
  log.scrollTop = Math.max(0, Math.min(top, log.scrollHeight - log.clientHeight));
}

function appendError(message, retryText) {
  const wrap = el('article', 'message bot');
  wrap.append(el('span', 'who', '小贸'), el('div', 'bubble', message));
  if (retryText) {
    const bar = el('div', 'answer-actions');
    const retry = el('button', 'primary', '重试这次输入');
    retry.type = 'button';
    retry.addEventListener('click', () => send(retryText));
    bar.append(retry);
    wrap.append(bar);
  }
  $('log').append(wrap);
  $('log').scrollTop = $('log').scrollHeight;
}

async function send(text, displayText = text) {
  if (busy) return;
  const input = String(text || '').trim();
  if (!input) return;
  setBusy(true);
  appendUser(displayText);
  setPet({ mood: 'idle', text: '正在核对条件' });
  try {
    const res = await fetch('/api/turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: input, state, sessionId })
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) throw Object.assign(new Error(data?.message || `服务返回 ${res.status}`), { code: data?.code });
    state = data.state;
    last = data;
    appendBot(data);
    renderCards(data);
    renderChips();
    setPet(data.pet);
    $('stateVersion').textContent = `状态 v${state?.version ?? '—'}`;
    if (data.cards?.result || data.cards?.comparison || data.cards?.export) $('tabDot').hidden = false;
    if (data.error?.code) toast('这次没有计算，参数已保留');
  } catch (err) {
    appendError(`这次没有收到回复（${err.message}）。你刚才的输入和已填参数都还在，可以重试。`, displayText === text ? text : null);
    setPet({ mood: 'alert', text: '连接未完成' });
    toast('网络或服务异常，参数未丢失');
  } finally {
    setBusy(false);
    $('q').focus();
  }
}

function runAction(action) {
  if (!action) return;
  if (action.kind === 'download') return downloadFormat(action.format);
  if (action.kind === 'example') return send('__example_fill__', '填入示例值（标准教学案例）');
  if (action.kind === 'reset') return resetAll();
  return send(action.text || action.label);
}

function renderChips() {
  const box = $('chips');
  box.replaceChildren();
  for (const chip of DEMO_CHIPS) {
    const button = el('button', '', `${chip.step} ${chip.label}`);
    button.type = 'button';
    button.title = chip.text;
    button.setAttribute('aria-label', `${chip.step} ${chip.label}：${chip.text}`);
    button.addEventListener('click', () => send(chip.text));
    box.append(button);
  }
}

function cardHead(title, tagText, tagClass = '') {
  const head = el('div', 'card-head');
  const h2 = el('h2', '', title);
  head.append(h2);
  if (tagText) head.append(el('span', `tag ${tagClass}`.trim(), tagText));
  return head;
}

function renderCards(data) {
  const box = $('cards');
  box.replaceChildren();
  const cards = data.cards || {};
  const scenarios = cards.conditions?.scenarios || [];
  if (!scenarios.length) {
    box.append(exampleCard());
    return;
  }
  if (cards.result) box.append(summaryStrip(cards.result));
  box.append(conditionsCard(cards.conditions, data));
  if (cards.result) box.append(resultCard(cards.result));
  if (cards.comparison) box.append(comparisonCard(cards.comparison));
  if (cards.sensitivity) box.append(sensitivityCard(cards.sensitivity));
  box.append(basisCard(cards.basis, cards.result));
  box.append(learningCard(cards.learning));
  if (cards.export) box.append(exportCard(cards.export));
  box.append(actionsCard(data.actions));
  if (level === 'learn') document.body.classList.add('learn-mode');
}

function summaryStrip(result) {
  const strip = el('div', 'summary-strip');
  const main = el('div', 'summary-main');
  main.append(el('span', 'summary-label', `${result.label} · ${result.priceTerm} 口径 · 含进口税费支出`));
  const value = el('strong', 'summary-value', result.amounts.outlay.value);
  value.append(el('small', '', '元'));
  main.append(value);
  const sub = el('div', 'summary-sub');
  sub.append(document.createTextNode('每件 '), el('b', '', result.amounts.perUnit.value), document.createTextNode(` 元/${result.quantityUnit || '件'}`));
  strip.append(main, sub);
  return strip;
}

function exampleCard() {
  const card = el('section', 'card');
  card.append(cardHead('标准教学案例（固定数据）', '可复算 · 非实时查询', 'warn'));
  card.append(el('p', 'card-note teaching', '以下数字是课堂案例的人为设定，不是实时汇率、税则或任何商品的现行税率。每项都可以在开始后修改。'));
  const table = el('table', 'example-table');
  const thead = el('thead');
  const hr = el('tr');
  for (const t of ['参数', '设定值']) hr.append(el('th', '', t));
  thead.append(hr);
  const tbody = el('tbody');
  const rows = [
    ['商品数量', '100 件'],
    ['商品报价', 'FOB 每件 10.00 美元'],
    ['国际运费', '整批 100.00 美元'],
    ['保险费', '整批 10.00 美元'],
    ['汇率', '1 美元 = 7.0000 元人民币'],
    ['关税税率', '10.00%'],
    ['进口增值税税率', '13.00%'],
    ['消费税', '本案例不涉及（0）'],
    ['国内其他费用', '暂按 0 计']
  ];
  for (const [k, v] of rows) {
    const tr = el('tr');
    tr.append(el('td', '', k), el('td', '', v));
    tbody.append(tr);
  }
  table.append(thead, tbody);
  card.append(table);
  card.append(el('div', 'example-formula', '计税价格 =（商品总价 + 国际运费 + 保险费）× 汇率\n关税 = 计税价格 × 关税税率\n进口增值税 =（计税价格 + 关税）× 进口增值税税率\n含进口税费支出合计 = 计税价格 + 关税 + 进口增值税'));
  const bar = el('div', 'actions-bar');
  const start = el('button', 'primary', '用标准案例开始演示');
  start.type = 'button';
  start.addEventListener('click', () => send('__example_fill__', '用标准教学案例演示'));
  bar.append(start);
  card.append(bar);
  card.append(el('p', 'basis-note', '人工参考结果：计税价格 7,770.00 元；关税 777.00 元；进口增值税 1,111.11 元；合计 9,658.11 元；每件 96.58 元。'));
  return card;
}

function conditionsCard(conditions, data) {
  const card = el('section', 'card');
  const active = conditions.scenarios.find(s => s.id === conditions.activeId);
  card.append(cardHead('案例条件卡', `状态 v${conditions.version}`, 'active'));
  card.append(el('p', 'card-note', '每项标注来源；缺失项不会被默认填充。点击“修改”会通过对话改写条件，并留下状态记录。'));
  if (conditions.lastChange) {
    const change = conditions.lastChange;
    const banner = el('div', 'change-banner');
    const allNew = change.fields.every(f => f.fromRaw === null || f.fromRaw === undefined || f.fromRaw === '');
    const text = change.fields.length > 3
      ? (allNew ? `本次写入 ${change.fields.length} 项条件，均标注来源，逐项见下表。` : `本次修改 ${change.fields.length} 项，逐项变化见下表。`)
      : (change.fields.length > 1
        ? `本次${allNew ? '写入' : '修改'} ${change.fields.length} 项：${change.fields.map(f => `${f.label} ${f.from} → ${f.to}`).join('；')}`
        : `本次变更：${change.label} ${change.from} → ${change.to}（其他参数保留）`);
    banner.textContent = text;
    card.append(banner);
  }
  for (const scenario of conditions.scenarios) {
    const block = el('div', 'cond-scenario' + (scenario.id === conditions.activeId ? ' active' : ''));
    const head = el('div', 'cond-scenario-head');
    const left = el('div');
    left.append(el('strong', '', scenario.label), el('span', 'sub', `　${scenario.priceTerm || '口径待确认'} · ${scenario.complete ? '条件已齐' : `还差 ${scenario.missing.length} 项`}`));
    head.append(left);
    head.append(el('span', `tag ${scenario.complete ? 'good' : 'warn'}`, scenario.id === conditions.activeId ? '当前方案' : '可比较'));
    block.append(head);
    const grid = el('div', 'cond-grid');
    const header = el('div', 'cond-row header');
    header.append(el('span', '', '参数'), el('span', '', '数值'), el('span', '', '单位'), el('span', '', '来源'), el('span', '', ''));
    grid.append(header);
    const errorFields = new Set((scenario.errors || []).map(e => e.field));
    for (const row of scenario.rows) {
      const rowEl = el('div', 'cond-row');
      if (!row.applicable) rowEl.classList.add('na');
      else if (row.value === null) rowEl.classList.add('missing');
      if (errorFields.has(row.field)) rowEl.classList.add('invalid');
      rowEl.append(el('span', 'label', row.label));
      rowEl.append(el('span', 'value', row.display ?? (row.value === null ? '待填写' : row.value)));
      rowEl.append(el('span', 'unit', row.unit || '—'));
      rowEl.append(el('span', 'source', row.sourceText));
      const edit = el('button', 'edit', row.value === null && row.applicable ? '填写' : '修改');
      edit.type = 'button';
      edit.disabled = !row.applicable;
      edit.hidden = !row.applicable;
      edit.addEventListener('click', () => openEditor(rowEl, scenario, row, false));
      rowEl.append(edit);
      grid.append(rowEl);
    }
    block.append(grid);
    if (scenario.errors?.length) {
      const list = el('ul', 'error-list');
      for (const error of scenario.errors) list.append(el('li', '', error.message));
      block.append(list);
    }
    if (scenario.note) block.append(el('p', 'basis-note', `口径说明：${scenario.note}`));
    if (scenario.rows.some(r => r.note && r.source === 'derived')) {
      for (const row of scenario.rows.filter(r => r.note && r.source === 'derived')) {
        block.append(el('p', 'basis-note', `${row.label}：${row.note}`));
      }
    }
    card.append(block);
  }
  const notes = el('div', 'notes');
  for (const a of conditions.assumptions || []) {
    const p = el('p');
    p.append(el('b', '', '假设 · '), document.createTextNode(a.text));
    notes.append(p);
  }
  card.append(notes);
  return card;
}

function openEditor(rowEl, scenario, row, wasMissing) {
  const field = row.field;
  const isSelect = field === 'priceTerm' || field === 'currency';
  const wrap = el('div', 'cond-edit');
  const label = el('span', 'label', row.label);
  let input;
  if (isSelect) {
    input = document.createElement('select');
    const options = field === 'priceTerm' ? ['FOB', 'CFR', 'CIF'] : ['USD', 'EUR', 'JPY', 'HKD', 'GBP'];
    for (const value of options) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      input.append(option);
    }
    input.value = row.value ?? (field === 'priceTerm' ? 'FOB' : 'USD');
  } else {
    input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.placeholder = wasMissing ? '输入数值' : '';
    input.value = row.value ?? '';
    input.autocomplete = 'off';
  }
  const unit = el('span', 'unit', row.unit || '');
  const save = el('button', 'save', '写入');
  save.type = 'button';
  const cancel = el('button', '', '取消');
  cancel.type = 'button';
  wrap.append(label, input, unit, save, cancel);
  rowEl.replaceChildren(wrap);
  input.focus();
  if (input.select) input.select();
  cancel.addEventListener('click', () => {
    if (last) renderCards(last);
    else $('cards').replaceChildren(exampleCard());
  });
  const submit = () => {
    const value = String(input.value || '').trim();
    if (!value) return toast('请先填写数值');
    const instruction = instructionFor(field, value, scenario);
    if (!instruction) return toast('这个字段暂不支持修改');
    send(instruction, `修改${row.label}：${value}${row.unit || ''}`);
  };
  save.addEventListener('click', submit);
  input.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); submit(); }
    if (ev.key === 'Escape') renderCards(last);
  });
}

function instructionFor(field, value, scenario) {
  const cur = scenario.currency === 'USD' ? '美元' : scenario.currency === 'EUR' ? '欧元' : scenario.currency === 'JPY' ? '日元' : scenario.currency === 'HKD' ? '港币' : scenario.currency === 'GBP' ? '英镑' : '美元';
  const unit = scenario.quantityUnit || '件';
  const map = {
    quantity: `数量改成 ${value} ${unit}`,
    priceTerm: `报价口径改成 ${value}`,
    currency: `报价币种改成 ${value}`,
    unitPrice: `单价改成 ${value} ${cur}`,
    totalPrice: `总价改成 ${value} ${cur}`,
    freight: `运费改成 ${value} ${cur}`,
    insurance: `保险改成 ${value} ${cur}`,
    fx: `汇率改成 ${value}`,
    dutyRate: `关税税率改成 ${value}%`,
    vatRate: `进口增值税税率改成 ${value}%`,
    domesticFees: `国内其他费用改成 ${value} 元`,
    exciseRate: `消费税税率改成 ${value}%`
  };
  return map[field] || null;
}

function resultCard(result) {
  const card = el('section', 'card');
  const tag = result.stale ? '参数已变 · 需重算' : (result.priceTerm === 'CIF' ? 'CIF 口径' : result.priceTerm === 'CFR' ? 'CFR 口径' : 'FOB 口径');
  card.append(cardHead('结果卡', tag, result.stale ? 'warn' : 'active'));
  const hero = el('div', 'result-hero');
  const big = el('div', 'big-number', result.amounts.outlay.value);
  big.append(el('small', '', '元'));
  hero.append(big);
  const per = el('div', 'per-unit');
  per.append(document.createTextNode('每件对应支出'), el('b', '', result.amounts.perUnit.value), document.createTextNode(`元/${result.quantityUnit || '件'}`));
  hero.append(per);
  card.append(hero);
  const comp = el('div', 'composition');
  for (const item of result.composition) {
    const row = el('div', 'comp-row');
    row.append(el('span', 'name', item.label));
    const bar = el('span', 'bar');
    const fill = document.createElement('i');
    fill.style.width = `${Math.max(0, Math.min(100, Number(item.share) || 0))}%`;
    bar.append(fill);
    row.append(bar, el('span', 'amount', item.amountText), el('span', 'share', item.shareText));
    comp.append(row);
  }
  card.append(comp);
  card.append(el('p', 'scope-line', result.scopeNote));
  card.append(el('p', 'included-note', `费用口径：${result.includedCosts.note}。金额来源：本地确定性工具，未使用模型生成的数字。`));
  const meta = el('div', 'result-meta');
  meta.append(el('span', 'tag', `结果指纹 ${result.resultHash.slice(0, 8)}`));
  meta.append(el('span', 'tag', `输入指纹 ${result.inputHash.slice(0, 8)}`));
  if (Number(result.domesticFees.value) > 0) meta.append(el('span', 'tag warn', `另含国内费用 ${result.domesticFees.text}`));
  card.append(meta);
  return card;
}

function comparisonCard(comparison) {
  const card = el('section', 'card');
  if (!comparison.ok) {
    card.append(cardHead('方案对比', '口径不一致', 'warn'));
    card.append(el('p', 'card-note', comparison.message || '暂时无法比较。'));
    if (comparison.reasons?.length) {
      const ul = el('ul', 'error-list');
      for (const reason of comparison.reasons) ul.append(el('li', '', reason));
      card.append(ul);
    }
    return card;
  }
  card.append(cardHead('方案对比卡', '已统一为 CIF 等值', 'good'));
  const scroll = el('div', 'compare-scroll');
  const table = el('table', 'compare-table');
  const thead = el('thead');
  const hr = el('tr');
  for (const t of ['方案', '报价口径', 'CIF 等值', '支出合计', '每件']) hr.append(el('th', '', t));
  thead.append(hr);
  const tbody = el('tbody');
  for (const s of comparison.scenarios) {
    const tr = el('tr', s.id === comparison.cheaper.id ? 'win' : '');
    tr.append(el('td', '', s.label), el('td', '', s.priceTerm), el('td', '', s.cifEquivalent), el('td', '', s.outlayText), el('td', '', s.perUnitText));
    tbody.append(tr);
  }
  table.append(thead, tbody);
  scroll.append(table);
  card.append(scroll);
  const diff = comparison.differences[0];
  const banner = el('div', 'diff-banner' + (comparison.sameCost ? ' warn' : ''));
  banner.append(el('span', '', comparison.sameCost ? '两个方案支出相同。' : `${comparison.cheaper.label} 更低，少 `));
  if (!comparison.sameCost) {
    banner.append(el('b', '', `${diff.diffText.replace(/^[+-]/, '')}`), el('span', '', `（${diff.diffPercentText}，每件少 ${diff.perUnitDiffText.replace(/^[+-]/, '')}）`));
  }
  card.append(banner);
  const notes = el('div');
  notes.append(el('p', 'basis-note', comparison.basisNote));
  const baselineLabel = comparison.scenarios.find(s => s.id === comparison.baselineId)?.label || '基准方案';
  for (const d of comparison.differences) {
    if (d.equal) notes.append(el('p', 'basis-note', `${d.label} 与${baselineLabel} 支出相同。`));
    else {
      const dir = d.diffFromBaseline.startsWith('-') ? '少' : '多';
      notes.append(el('p', 'basis-note', `${d.label} 比${baselineLabel} ${dir} ${d.diffText.replace(/^[+-]/, '')}（${d.diffPercentText}），每件${dir} ${d.perUnitDiffText.replace(/^[+-]/, '')}。`));
    }
  }
  card.append(notes);
  return card;
}

function sensitivityCard(sens) {
  const card = el('section', 'card');
  card.append(cardHead('汇率试算卡', `不影响原方案 · 弹性约 ${sens.elasticity ?? '—'}`, 'active'));
  const table = el('table', 'sens-table');
  const thead = el('thead');
  const hr = el('tr');
  for (const t of ['汇率', '计税价格', '关税', '进口增值税', '支出合计', '每件', '变化']) hr.append(el('th', '', t));
  thead.append(hr);
  const tbody = el('tbody');
  const target = sens.points.find(p => !p.isBaseline);
  for (const p of sens.points) {
    const tr = el('tr', p.isBaseline ? 'base' : (target && p.fx === target.fx ? 'target' : ''));
    tr.append(el('td', '', p.fxText), el('td', '', p.taxableValueText), el('td', '', `${p.duty} 元`), el('td', '', `${p.vat} 元`), el('td', '', p.outlayText), el('td', '', p.perUnitText), el('td', '', p.deltaText));
    tbody.append(tr);
  }
  table.append(thead, tbody);
  card.append(table);
  card.append(el('p', 'dir-note', `${sens.note} 当前试算基于 ${sens.exposureText} 的 CIF 等值，原方案汇率未改变。`));
  return card;
}

function basisCard(basis, result) {
  const details = document.createElement('details');
  details.className = 'basis';
  details.open = level === 'learn';
  const summary = document.createElement('summary');
  summary.append(document.createTextNode('计算依据：公式、舍入、来源与适用范围'));
  details.append(summary);
  const body = el('div', 'basis-body');
  if (basis?.trace?.length) {
    const block = el('div', 'basis-block');
    block.append(el('h3', '', '公式与代入'));
    const list = el('ol', 'trace');
    for (const step of basis.trace) {
      const li = document.createElement('li');
      li.append(el('span', 't-label', step.label), el('span', 't-value', `${step.value} ${step.currency === 'CNY' ? '元' : '美元'}`), el('span', 't-formula', step.formula));
      if (step.raw && Number(step.raw) !== Number(step.value)) li.append(el('span', 't-raw', `未舍入 ${step.raw}`));
      list.append(li);
    }
    block.append(list);
    body.append(block);
  }
  const rounding = el('div', 'basis-block');
  rounding.append(el('h4', '', '舍入规则'));
  const rul = el('ul');
  for (const rule of basis?.roundingRules || []) rul.append(el('li', '', rule));
  rounding.append(rul);
  body.append(rounding);
  const assumptions = el('div', 'basis-block');
  assumptions.append(el('h4', '', '假设与适用范围'));
  const aul = el('ul');
  for (const a of basis?.assumptions || []) aul.append(el('li', '', `${a.text}（${a.source}）`));
  assumptions.append(aul);
  body.append(assumptions);
  const notIncluded = el('div', 'basis-block');
  notIncluded.append(el('h4', '', '尚未计入'));
  const nul = el('ul');
  for (const item of basis?.notIncluded || []) nul.append(el('li', '', item));
  notIncluded.append(nul);
  body.append(notIncluded);
  const sources = el('div', 'basis-block');
  sources.append(el('h4', '', '来源与依据'));
  for (const s of basis?.sources || []) {
    const p = el('p', 'source-item');
    p.append(el('b', '', `${s.label}（${s.kind}）：`), document.createTextNode(s.text));
    sources.append(p);
  }
  body.append(sources);
  if (result) {
    const consistency = el('div', 'basis-block');
    consistency.append(el('h4', '', '复算与一致性'));
    const p = el('p', 'source-item');
    p.append(el('b', '', '结果指纹：'), document.createTextNode(result.resultHash));
    consistency.append(p);
    consistency.append(el('p', 'source-item', '页面显示的金额直接来自工具结果；导出时会再次逐方案重算并核对指纹。'));
    body.append(consistency);
  }
  details.append(body);
  return details;
}

function learningCard(learning) {
  const card = el('section', 'card learn-only');
  card.append(cardHead('展开学习过程', '概念与思考入口', 'active'));
  const grid = el('div', 'learn-grid');
  for (const item of learning?.cards || []) {
    const box = el('div', 'learn-item');
    box.append(el('strong', '', item.term), el('p', '', item.text));
    grid.append(box);
  }
  card.append(grid);
  const prompt = el('div', 'prompt-box');
  prompt.append(el('b', '', '接着想一个问题：'), document.createTextNode(learning?.prompt || '汇率变化对这笔订单影响多大？'));
  const button = el('button', '', '让小贸试算这个汇率影响 →');
  button.type = 'button';
  button.addEventListener('click', () => send(learning?.prompt || '汇率变化影响多大？'));
  prompt.append(document.createElement('br'), button);
  card.append(prompt);
  return card;
}

function exportCard(exported) {
  const card = el('section', 'card');
  card.append(cardHead('案例摘要', '已按当前状态生成', 'good'));
  const file = el('div', 'export-file');
  file.append(el('div', 'file-icon', 'MD'));
  const meta = el('div', 'file-meta');
  meta.append(el('strong', '', exported.primary.filename));
  meta.append(el('small', '', `状态 v${exported.primary.stateVersion} · ${exported.primary.bytes} 字节 · 校验码 ${exported.primary.checksum.slice(0, 12)}…`));
  file.append(meta);
  card.append(file);
  const actions = el('div', 'export-actions');
  const formats = [['markdown', '下载 Markdown'], ['html', '下载 HTML'], ['json', '下载 JSON']];
  for (const [format, label] of formats) {
    if (!exported.formats[format]) continue;
    const button = el('button', format === 'markdown' ? 'primary' : '', label);
    button.type = 'button';
    button.addEventListener('click', () => downloadFormat(format));
    actions.append(button);
  }
  const preview = el('button', '', '预览摘要内容');
  preview.type = 'button';
  preview.addEventListener('click', () => openPreview(exported));
  actions.append(preview);
  card.append(actions);
  const checks = el('ul', 'check-list');
  for (const text of ['输入条件、单位与来源', '公式代入与分步舍入', '结果与方案对比', '假设、未计入项目与适用范围', '导出前重算与指纹核对']) {
    checks.append(el('li', '', text));
  }
  card.append(checks);
  return card;
}

function actionsCard(actions) {
  const card = el('section', 'card');
  card.append(cardHead('后续操作', '也可以直接在对话里说'));
  const bar = el('div', 'actions-bar');
  for (const action of (actions || []).filter(a => a.kind !== 'download')) {
    const button = el('button', action.primary ? 'primary' : '', action.label);
    button.type = 'button';
    button.addEventListener('click', () => runAction(action));
    bar.append(button);
  }
  const reset = el('button', '', '重新开始');
  reset.type = 'button';
  reset.addEventListener('click', resetAll);
  bar.append(reset);
  card.append(bar);
  return card;
}

function downloadFormat(format) {
  const file = last?.cards?.export?.formats?.[format];
  if (!file) return toast('请先生成摘要');
  const blob = new Blob([file.content], { type: file.mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  toast(`已下载 ${file.filename}`);
}

function openPreview(exported) {
  const body = $('previewBody');
  body.replaceChildren();
  const data = last?.cards;
  const summary = el('p', 'card-note', `文件：${exported.primary.filename}　状态 v${exported.primary.stateVersion}　校验码：${exported.primary.checksum}`);
  body.append(summary);
  if (data?.result) {
    const table = el('table');
    const tbody = el('tbody');
    const rows = [
      ['方案', `${data.result.label}（${data.result.priceTerm}）`],
      ['含进口税费支出合计', data.result.amounts.outlay.text],
      ['每件对应支出', data.result.amounts.perUnit.text],
      ['计税价格', data.result.amounts.taxableValue.text],
      ['关税', data.result.amounts.duty.text],
      ['进口增值税', data.result.amounts.vat.text]
    ];
    for (const [k, v] of rows) {
      const tr = el('tr');
      tr.append(el('td', '', k), el('td', '', v));
      tbody.append(tr);
    }
    table.append(tbody);
    body.append(table);
  }
  if (data?.comparison?.ok) {
    const diff = data.comparison.differences[0];
    body.append(el('p', '', `${data.comparison.cheaper.label} 更低：${diff.diffText}（${diff.diffPercentText}），已统一为 CIF 等值口径。`));
  }
  body.append(el('p', 'card-note', '完整摘要包含输入条件、公式代入、结果、对比（如有）、假设、未计入项目、来源与复算指纹。下载 HTML 可直接打印或保存为 PDF。'));
  const bar = el('div', 'actions-bar');
  const html = el('button', 'primary', '下载 HTML 查看完整排版');
  html.type = 'button';
  html.addEventListener('click', () => { downloadFormat('html'); $('preview').close(); });
  bar.append(html);
  body.append(bar);
  $('preview').showModal();
}

async function resetAll() {
  try {
    const res = await fetch('/api/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }) });
    const data = await res.json();
    state = data.state || null;
  } catch {
    state = null;
  }
  last = null;
  $('log').replaceChildren();
  $('cards').replaceChildren(exampleCard());
  $('stateVersion').textContent = '状态 v1';
  $('tabDot').hidden = true;
  $('q').value = '';
  $('count').textContent = '0 / 500';
  setPet({ mood: 'idle', text: '等你开口' });
  switchView('chat');
  toast('已重新开始');
}

function switchView(view) {
  document.body.dataset.view = view;
  $('tabChat').setAttribute('aria-selected', view === 'chat' ? 'true' : 'false');
  $('tabCards').setAttribute('aria-selected', view === 'cards' ? 'true' : 'false');
  if (view === 'cards') $('tabDot').hidden = true;
}

function autoHeight(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(120, textarea.scrollHeight)}px`;
}

function init() {
  renderChips();
  $('cards').replaceChildren(exampleCard());
  document.body.dataset.view = 'chat';
  if (window.matchMedia('(min-width: 1081px)').matches) document.body.dataset.view = '';
  $('composer').addEventListener('submit', ev => {
    ev.preventDefault();
    const value = $('q').value;
    if (!value.trim()) return;
    $('q').value = '';
    $('count').textContent = '0 / 500';
    autoHeight($('q'));
    send(value);
  });
  $('q').addEventListener('input', () => {
    $('count').textContent = `${$('q').value.length} / 500`;
    autoHeight($('q'));
  });
  $('q').addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      $('composer').requestSubmit();
    }
  });
  $('reset').addEventListener('click', resetAll);
  $('tabChat').addEventListener('click', () => switchView('chat'));
  $('tabCards').addEventListener('click', () => switchView('cards'));
  $('previewClose').addEventListener('click', () => $('preview').close());
  $('preview').addEventListener('click', ev => { if (ev.target === $('preview')) $('preview').close(); });
  $('levelQuick').addEventListener('click', () => setLevel('quick'));
  $('levelLearn').addEventListener('click', () => setLevel('learn'));
  fetch('/api/health').then(r => r.json()).then(data => {
    const conn = $('conn');
    const real = data.model?.mode && data.model.mode !== 'simulated';
    const mode = real ? `真实模型 · ${data.model.name}` : '离线可复现 · 模拟模型';
    conn.textContent = mode;
    conn.classList.add('ok');
    conn.title = real
      ? '真实模型只负责参数提案；金额由确定性工具计算，调用是否成功以服务端记录为准'
      : `离线规则解析；经贸专项用例 ${data.cases?.total || 0} 条`;
  }).catch(() => {
    const conn = $('conn');
    conn.textContent = '服务未连接';
    conn.classList.add('warn');
  });
}

function setLevel(next) {
  level = next;
  document.body.classList.toggle('learn-mode', level === 'learn');
  $('levelQuick').classList.toggle('active', level === 'quick');
  $('levelLearn').classList.toggle('active', level === 'learn');
  $('levelQuick').setAttribute('aria-pressed', level === 'quick' ? 'true' : 'false');
  $('levelLearn').setAttribute('aria-pressed', level === 'learn' ? 'true' : 'false');
  document.querySelectorAll('details.basis').forEach(d => { d.open = level === 'learn'; });
  document.querySelectorAll('.message .detail').forEach(d => { d.open = level === 'learn'; });
}

init();
