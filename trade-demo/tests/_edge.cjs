'use strict';
const { handleTurn } = require('../src/engine/engine.cjs');
const { createState } = require('../src/engine/state.cjs');

async function run(label, texts) {
  let state = createState();
  console.log('\n=== ' + label + ' ===');
  for (const text of texts) {
    const r = await handleTurn({ text, state, sessionId: label });
    state = r.state;
    console.log('> ' + text);
    console.log('  ' + r.answer.slice(0, 300));
    console.log(`  phase=${r.phase} ver=${state.version} pending=${JSON.stringify(state.pending)} result=${r.cards.result?.amounts.outlay.value || '-'}`);
  }
}

(async () => {
  await run('修改与恢复', ['帮我算进口成本', '100 件，每件 10 美元，FOB，运费 100 美元，保险 10 美元，汇率 7，关税 10%，增值税 13%', '把汇率改成 7.2', '恢复原来的汇率']);
  await run('歧义恢复', ['100 件，每件 10 美元，FOB，运费 100 美元，保险 10 美元，汇率 7，关税 10%，增值税 13%', '把汇率改成 7.2', '把汇率改成 7.3', '恢复原来的汇率', '第一个']);
  await run('校园暂停', ['100 件，每件 10 美元，FOB，运费 100 美元，保险 10 美元，汇率 7，关税 10%，增值税 13%', '图书馆借阅规则是什么？', '继续刚才的进口案例']);
  await run('CIF重复运费', ['另一个供应商报 CIF 总价 1,080 美元，运费 100 美元，其他条件一样']);
  await run('税率金额混淆', ['100 件，每件 10 美元，FOB，运费 100 美元，保险 10 美元，汇率 7，关税 777 元，增值税 13%']);
  await run('负数量', ['-5 件，每件 10 美元，FOB']);
  await run('单价总价混淆', ['100 件，单价 10 美元，总价 1000 美元，FOB']);
})();
