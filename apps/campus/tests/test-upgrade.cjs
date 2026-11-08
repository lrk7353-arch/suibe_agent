const assert=require('node:assert/strict');
const {reply}=require('../assistant.cjs');
const {execute}=require('../trade-tools.js');
async function main(){
 let n=0;
 const check=(condition)=>{assert.ok(condition);n++;};
 let r=await reply('成绩核实什么时候申请？');check(r.options.includes('补考'));
 r=await reply('补考',r.context);check(r.answer.includes('一周内'));
 r=await reply('多久能查结果',r.context);check(r.answer.includes('三周'));
 r=await reply('解释机会成本',{},async card=>card.fact);check(r.context.topic==='机会成本');
 r=await reply('举个例子',r.context,async card=>card.example);check(r.answer.includes('兼职'));
 r=await reply('本科生可以借几本书');check(r.answer.includes('30'));
 r=await reply('校园网怎么连',r.context);check(r.context.task==='campus_network');
 r=await reply('SUIBE',r.context);check(r.sources.length===1);
 const cost=execute('landed_cost',{price:100,freight:10,insurance:0,fx:7,duty:10,vat:13}).result;
 check(cost.customs===770&&cost.duty===77&&cost.vat===110.11&&cost.total===957.11);
 check(execute('opportunity_cost',{alternativeA:10,alternativeB:20,alternativeC:30}).result.opportunityCost===30);
 for(const args of [{},{price:'100'},{price:NaN},{price:Infinity}]){assert.throws(()=>execute('landed_cost',args));n++;}
 assert.throws(()=>execute('__proto__',{}));n++;
 assert.throws(()=>execute('landed_cost',{price:100,freight:0,insurance:0,fx:0,duty:0,vat:0}));n++;
 console.log(n+' workflow and calculation checks passed');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
