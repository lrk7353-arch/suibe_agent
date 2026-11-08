const {execute}=require('./trade-tools.js');
const fields={price:'货价',freight:'运费',insurance:'保险费',fx:'汇率（人民币/外币）',duty:'关税率（%）',vat:'增值税率（%）'};
const patterns={price:'货价|货值',freight:'运费',insurance:'保险费',fx:'汇率',duty:'关税率|关税',vat:'增值税率|增值税'};
const currencyPattern=/美元|美金|USD|欧元|EUR|人民币|CNY|日元|JPY|港币|HKD/gi;
function currency(text){return [...new Set((text.match(currencyPattern)||[]).map(x=>({美金:'USD',美元:'USD',欧元:'EUR',人民币:'CNY',日元:'JPY',港币:'HKD'}[x]||x.toUpperCase())))];}
function tradeWorkflow(q,previous={}){
  const start=/进口成本|关税计算|到岸成本/.test(q);
  const active=previous.task==='landed_cost';
  if(!start&&!active)return null;
  if(active&&/^(取消|不算了|结束计算)[。！!]*$/.test(q))return {answer:'好的，已清空这次计算草案。你可以继续问校园问题。',context:{},options:[]};
  const extracted={};let problem='';
  const currencies=new Set(start?[]:previous.tradeCurrencies||[]);
  for(const [key,label] of Object.entries(patterns)){
    const matches=[...q.matchAll(new RegExp('(?:'+label+')\\s*(?:改为|改成|是|为|=|：|:)?\\s*(-?\\d+(?:\\.\\d+)?)\\s*(美元|美金|USD|欧元|EUR|人民币|CNY|日元|JPY|港币|HKD)?','gi'))];
    if(matches.length){
      if(new Set(matches.map(m=>m[1])).size>1){problem='同一参数出现了多个数值，请只保留一个数值重新填写。';extracted[key]=NaN;continue;}
      const m=matches.at(-1);extracted[key]=Number(m[1]);
      if(/^(?:万|千|亿|[eE][+-]?\d|[,，]\d)/.test(q.slice(m.index+m[0].length))){extracted[key]=NaN;continue;}
      if(['price','freight','insurance'].includes(key)&&m[2])currency(m[2]).forEach(c=>currencies.add(c));
    }
  }
  if(active&&!start&&!Object.keys(extracted).length){
    const bare=q.match(/^\s*(-?\d+(?:\.\d+)?)\s*(%|％)?\s*$/);
    if(bare&&Object.hasOwn(fields,previous.pendingField))extracted[previous.pendingField]=Number(bare[1]);
    else return null;
  }
  const args={...(start?{}:previous.tradeArgs||{}),...extracted};
  for(const [key,value] of Object.entries(extracted)){
    if(!Number.isFinite(value)||value<0||value>1e10||(key==='fx'&&value===0)||(['duty','vat'].includes(key)&&value>100)){
      delete args[key];problem=fields[key]+'数值无效：金额须非负，汇率须大于零，税率填写 0–100 的百分数。';
    }
  }
  if(currencies.size>1)return {answer:'货价、运费和保险费出现了不同币种。请先统一币种，再重新填写六项参数；这次草案已清空。',context:{},options:['进口成本试算'],mode:'本地参数校验'};
  const missing=Object.keys(fields).filter(k=>args[k]===undefined);
  const context={task:'landed_cost',tradeArgs:args,tradeCurrencies:[...currencies],pendingField:missing[0]||''};
  if(problem||missing.length)return {answer:(problem?problem+'\n':'')+(missing.length?'还需要'+missing.map(k=>fields[k]).join('、')+'。先告诉我'+fields[missing[0]]+'，也可以一次补齐。':'请核对并重新填写有歧义的参数。'),context,options:['取消'],mode:'本地工具 · 补齐参数'};
  execute('landed_cost',args);
  return {answer:'六项参数已整理好。请核对金额使用同一外币、汇率方向和税率；也可以直接说“运费改为 20”修正草案。',context,options:['取消'],toolProposal:{name:'landed_cost',args,provider:'local-rules'},mode:'本地工具 · 待核对'};
}
module.exports={tradeWorkflow};
