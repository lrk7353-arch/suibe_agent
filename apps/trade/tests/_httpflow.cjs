'use strict';
const base = 'http://127.0.0.1:18866';
(async () => {
  let state;
  const turns = ['帮我算一下这批进口商品的成本。', '100 件，每件 10 美元，FOB。', '运费 100 美元、保险 10 美元，汇率 7，关税 10%，增值税 13%。', '如果汇率涨到 7.2 呢？', '另一个供应商报 CIF 总价 1,080 美元，其他条件一样，哪个支出更低？', '把两种方案整理成一份摘要。'];
  for (const text of turns) {
    const res = await fetch(base + '/api/turn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, state, sessionId: 'smoke-http' }) });
    const data = await res.json();
    if (!data.ok) { console.log('ERROR', data); break; }
    state = data.state;
    console.log(`\n> ${text}\n< ${data.answer.slice(0, 180)}`);
    console.log(`  phase=${data.phase} v=${state.version} outlay=${data.cards.result?.amounts.outlay.value || '-'} export=${data.cards.export?.primary?.filename || '-'}`);
  }
  const health = await (await fetch(base + '/api/health')).json();
  console.log('\nhealth.model=', health.model.mode);
})();
