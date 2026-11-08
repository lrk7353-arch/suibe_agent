const assert=require('node:assert/strict');
const {complete}=require('../providers.cjs');
const original=global.fetch;
const ok=(reason,content='完整回答[1]')=>({ok:true,json:async()=>({choices:[{finish_reason:reason,message:{content}}],usage:{completion_tokens:512}})});
async function main(){
 let requests=[];
 global.fetch=async(url,options)=>{requests.push(JSON.parse(options.body));return ok(requests.length===1?'length':'stop');};
 assert.equal((await complete([{role:'user',content:'借阅服务'}])).answer,'完整回答[1]');
 assert.equal(requests.length,2);assert.equal(requests[0].max_tokens,512);assert.equal(requests[0].chat_template_kwargs.enable_thinking,false);assert.match(requests[1].messages[0].content,/180字/);
 global.fetch=async()=>ok('length','截断的答');await assert.rejects(()=>complete([]),{code:'output_limit'});
 global.fetch=async()=>({ok:false,status:503});await assert.rejects(()=>complete([]),{code:'http_error',status:503});
 global.fetch=async()=>{throw Object.assign(Error(),{name:'TimeoutError'});};await assert.rejects(()=>complete([]),{code:'timeout'});
 global.fetch=async()=>{throw TypeError('fetch failed');};await assert.rejects(()=>complete([]),{code:'unavailable'});
 global.fetch=async()=>ok('stop','');await assert.rejects(()=>complete([]),{code:'invalid_response'});
 global.fetch=async()=>ok('stop','<think>unfinished');await assert.rejects(()=>complete([]),{code:'invalid_response'});
 console.log('PASS: truncation retry, bounded attempts, local thinking setting, HTTP/timeout/offline/empty/unfinished reasoning classification');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{global.fetch=original;});
