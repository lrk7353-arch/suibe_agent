'use strict';
const tools = require('../src/engine/tools.cjs');
const scenario = {
  id: 'A', label: '方案 A', priceTerm: 'FOB', currency: 'USD', quantityUnit: '件',
  input: { quantity: '100', unitPrice: '10', freight: '100', insurance: '10', fx: '7', dutyRate: '10', vatRate: '13', domesticFees: '0', exciseRate: '0' }
};
const r = tools.calculateImportOutlay(scenario);
console.log(JSON.stringify({ ok: r.ok, code: r.code, amounts: r.ok ? r.amounts : r.validation, trace: r.ok ? r.trace.map(t => [t.id, t.raw, t.value]) : null }, null, 2));

const cif = {
  id: 'B', label: '方案 B', priceTerm: 'CIF', currency: 'USD', quantityUnit: '件',
  input: { quantity: '100', totalPrice: '1080', fx: '7', dutyRate: '10', vatRate: '13', domesticFees: '0', exciseRate: '0' }
};
console.log(JSON.stringify(tools.calculateImportOutlay(cif).amounts, null, 2));
console.log(JSON.stringify(tools.compareTradeScenarios({ scenarios: [scenario, cif] }), null, 2));
console.log(JSON.stringify(tools.analyzeExchangeSensitivity({ scenario, fxValues: ['7.2'] }).points, null, 2));
