const assert=require('node:assert/strict');
process.env.DEEPSEEK_API_KEY='test-placeholder-not-a-real-key';
delete process.env.XIAOMAO_OFFLINE;
let requests=[];
global.fetch=async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:'测试回答'}}]})};};
(async()=>{
const p=require('../providers.cjs');
for(const mode of ['local','auto','cloud'])assert.equal((await p.complete([{role:'user',content:'你好'}],mode)).provider,'cloud');
assert.equal(requests.length,3);
assert.ok(requests.every(r=>r.url==='https://api.deepseek.com/chat/completions'&&r.body.model==='deepseek-flash'));
delete process.env.DEEPSEEK_API_KEY;
await assert.rejects(()=>p.complete([]),e=>e.code==='not_configured');
console.log('PASS API routing, model name, missing-key guard (mock; no paid requests)');
})().catch(e=>{console.error(e);process.exitCode=1});
