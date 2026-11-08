const assert=require('node:assert/strict');
const {tradeWorkflow:run}=require('../trade-workflow.cjs');
const {cleanContext}=require('../context.cjs');
const {reply}=require('../assistant.cjs');
async function main(){
  let r=run('进口成本货价100美元');assert.equal(r.context.pendingField,'freight');
  r=run('10',cleanContext(r.context));assert.equal(r.context.tradeArgs.freight,10);
  r=run('保险费0美元，汇率7，关税10%，增值税13%',cleanContext(r.context));assert.equal(r.toolProposal.args.vat,13);
  r=run('运费改为20',cleanContext(r.context));assert.equal(r.toolProposal.args.freight,20);
  assert.equal(run('校园网怎么连',r.context),null);
  assert.deepEqual(run('取消',r.context).context,{});
  assert.equal(run('进口成本货价100美元，运费10欧元').mode,'本地参数校验');
  for(const q of ['进口成本货价1万元','进口成本货价1e5','进口成本货价1,000美元','进口成本货价100，货价200','进口成本货价-1'])assert.equal(run(q).context.tradeArgs.price,undefined,q);
  r=run('进口成本货价100，运费0，保险费0，汇率0，关税101，增值税13');assert.equal(r.context.pendingField,'fx');assert.equal(r.context.tradeArgs.duty,undefined);
  assert.deepEqual(cleanContext({task:'landed_cost',tradeArgs:{price:Infinity,freight:2,evil:5},pendingField:'evil'}).tradeArgs,{freight:2});
  const t=Date.now();r=await reply('进口成本货价100，运费10，保险费0，汇率7，关税10%，增值税13%');assert.equal(r.toolProposal.provider,'local-rules');console.log('Local proposal elapsed: '+(Date.now()-t)+' ms');
  const original=global.fetch;
  try{
    global.fetch=async url=>{if(String(url).includes('18767'))return {ok:true,json:async()=>({hits:[{distance:.1,title:'服务指南',source_url:'https://example.org/guide',text:'可核对的原文',chunk_id:'one'}]})};throw Error('offline model');};
    const fallback=await require('../rag.cjs').askRag('座位预约流程',{},'local');assert.equal(fallback.sources[0].text,'可核对的原文');assert.ok(fallback.mode.includes('原文回退'));
  }finally{global.fetch=original;}
  console.log('Optimization workflow, validation and model-offline regression checks passed');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
