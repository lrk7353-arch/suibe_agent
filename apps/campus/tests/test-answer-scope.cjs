const assert=require('node:assert/strict');
const {reply}=require('../assistant.cjs');const {eligibleEvidence}=require('../rag.cjs');
(async()=>{const original=global.fetch;let queried='';global.fetch=async(_url,opts)=>{queried=JSON.parse(opts.body).question;return {ok:true,json:async()=>({hits:[{distance:.1,title:'华东师范大学关于2025年辅修专业报名的通知',source_url:'https://jwc.suibe.edu.cn/notice.htm',text:'辅修学费165元/学分'},{distance:.1,title:'经管学科参考（附件：1801）',text:'学费和校园贷款',source_url:'https://lib.suibe.edu.cn/a.pdf'}]})};};try{for(const q of ['学费是多少','学费怎么交']){const r=await reply(q);assert.equal(r.context.task,'clarify_tuition');assert.equal(r.sources,undefined);assert.equal(queried,'');}const r=await reply('本科',{task:'clarify_tuition'});assert.match(queried,/本科.*学费/);assert.equal(r.sources,undefined);assert.ok(!r.answer.includes('165'));}finally{global.fetch=original;}
const external={title:'华东师范大学关于2025年辅修专业报名的通知',source_url:'https://jwc.suibe.edu.cn/a',text:'辅修学费165元'};
assert.equal(eligibleEvidence(external,'本科生学费'),false);
assert.equal(eligibleEvidence(external,'华东师范大学辅修学费'),true);
assert.equal(eligibleEvidence({title:'经管学科参考（附件：1801）',text:'学费'},'本科生学费'),false);
assert.equal(eligibleEvidence({title:'经管学科参考（附件：1801）'},'经管学科参考文献'),true);
assert.equal(eligibleEvidence({title:'上海对外经贸大学本科收费标准',text:'学费'},'本科生学费'),true);
assert.equal(eligibleEvidence({title:'上海对外经贸大学硕士学费标准'},'本科生学费'),false);
assert.equal(eligibleEvidence({title:'图书馆新专业信息（附件：0701',text:'学费'},'本科生学费'),false);
assert.equal(eligibleEvidence({title:'校园贷款文献',text:'学费'},'本科生学费'),false);
console.log('PASS tuition clarification through /reply, scope isolation, research preservation, explicit cross-school lookup');})().catch(e=>{console.error(e);process.exitCode=1;});
