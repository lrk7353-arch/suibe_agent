'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { handleTurn } = require('../src/engine/engine.cjs');
const { createState } = require('../src/engine/state.cjs');

const ROOT = path.resolve(__dirname, '..');
const SAMPLES = path.join(ROOT, 'samples');
const FIXED_NOW = Date.UTC(2026, 10, 8, 14, 0, 0); // 2026-11-08 22:00 Asia/Shanghai

async function run(turns) {
  let state = createState(FIXED_NOW);
  let last = null;
  for (const text of turns) {
    last = await handleTurn({ text, state, sessionId: 'sample', now: FIXED_NOW });
    state = last.state;
  }
  return last;
}

(async () => {
  fs.mkdirSync(SAMPLES, { recursive: true });
  const baseTurns = [
    '帮我算一下这批进口商品的成本。',
    '100 件，每件 10 美元，FOB。',
    '运费 100 美元、保险 10 美元，汇率 7，关税 10%，增值税 13%。'
  ];
  const single = await run([...baseTurns, '把两种方案整理成一份摘要。']);
  const double = await run([...baseTurns, '另一个供应商报 CIF 总价 1,080 美元，其他条件一样，哪个支出更低？', '把两种方案整理成一份摘要。']);
  if (!single.cards.export || !double.cards.export) throw new Error('示例导出未生成');
  const formats = ['markdown', 'html', 'json'];
  const singleMap = { markdown: '小贸-进口成本案例-单方案示例.md', html: '小贸-进口成本案例-单方案示例.html', json: '小贸-进口成本案例-单方案示例.json' };
  const doubleMap = { markdown: '小贸-进口成本案例-示例.md', html: '小贸-进口成本案例-示例.html', json: '小贸-进口成本案例-示例.json' };
  for (const fmt of formats) {
    fs.writeFileSync(path.join(SAMPLES, singleMap[fmt]), single.cards.export.formats[fmt].content, 'utf8');
    fs.writeFileSync(path.join(SAMPLES, doubleMap[fmt]), double.cards.export.formats[fmt].content, 'utf8');
  }
  const readme = [
    '# 示例导出文件',
    '',
    '这些文件由 `tests/make-samples.cjs` 用固定教学数据与固定时间生成，用于直接检查展示质量，不是现场运行截图。',
    '',
    '| 文件 | 内容 | 校验码（SHA-256 前 16 位） |',
    '|---|---|---|',
    `| 小贸-进口成本案例-示例.md | 方案 A（FOB）与方案 B（CIF）对比 | \`${double.cards.export.primary.checksum.slice(0, 16)}\` |`,
    `| 小贸-进口成本案例-示例.html | 同上，可直接打印或另存 PDF | \`${double.cards.export.formats.html.checksum.slice(0, 16)}\` |`,
    `| 小贸-进口成本案例-示例.json | 同上，结构化数据 | \`${double.cards.export.formats.json.checksum.slice(0, 16)}\` |`,
    `| 小贸-进口成本案例-单方案示例.md | 只含方案 A（FOB） | \`${single.cards.export.primary.checksum.slice(0, 16)}\` |`,
    `| 小贸-进口成本案例-单方案示例.html | 同上 | \`${single.cards.export.formats.html.checksum.slice(0, 16)}\` |`,
    `| 小贸-进口成本案例-单方案示例.json | 同上 | \`${single.cards.export.formats.json.checksum.slice(0, 16)}\` |`,
    '',
    '固定数据：100 件，FOB 每件 10.00 美元，整批运费 100.00 美元，保险费 10.00 美元，汇率 7.0000，关税 10%，进口增值税 13%，消费税与国内其他费用按案例约定为 0。',
    '',
    '人工参考：计税价格 7,770.00 元；关税 777.00 元；进口增值税 1,111.11 元；合计 9,658.11 元；每件 96.58 元。CIF 1,080 美元方案合计 9,397.08 元。',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(SAMPLES, 'README.md'), readme, 'utf8');
  console.log('samples written');
  console.log(JSON.stringify({
    single: single.cards.export.primary,
    double: double.cards.export.primary
  }, null, 2));
})();
