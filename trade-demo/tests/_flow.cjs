'use strict';
const { handleTurn } = require('../src/engine/engine.cjs');
const { createState } = require('../src/engine/state.cjs');

const turns = [
  '帮我算一下这批进口商品的成本。',
  '100 件，每件 10 美元，FOB。',
  '运费 100 美元、保险 10 美元，汇率 7，关税 10%，增值税 13%。',
  '如果汇率涨到 7.2 呢？',
  '另一个供应商报 CIF 总价 1,080 美元，其他条件一样，哪个支出更低？',
  '把两种方案整理成一份摘要。'
];

(async () => {
  let state = createState();
  for (const text of turns) {
    const r = await handleTurn({ text, state, sessionId: 'smoke' });
    state = r.state;
    console.log('\n> ' + text);
    console.log('< ' + r.answer);
    console.log(`  [phase=${r.phase} version=${state.version} scenarios=${state.scenarios.map(s => s.id + ':' + s.priceTerm).join(',')} tools=${r.toolCalls.map(t => t.name + ':' + t.ok).join(',')}]`);
    if (r.cards.result) console.log(`  [outlay=${r.cards.result.amounts.outlay.value} perUnit=${r.cards.result.amounts.perUnit.value}]`);
    if (r.cards.comparison) console.log(`  [comparison=${r.cards.comparison.kind || ''} cheaper=${r.cards.comparison.cheaper?.id} diff=${r.cards.comparison.differences?.[0]?.diffFromBaseline}]`);
    if (r.cards.sensitivity) console.log(`  [sens points=${r.cards.sensitivity.points.map(p => p.fxText + '=' + p.outlay).join(' ')}]`);
    if (r.cards.export) console.log(`  [export=${r.cards.export.primary.filename} ${r.cards.export.primary.bytes}B]`);
  }
})();
