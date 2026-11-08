const fs=require('fs');const path=require('path');
const config=JSON.parse(fs.readFileSync(process.env.SUIBE_KB_CONFIG||path.join(__dirname,'data/kb-active.json'),'utf8').replace(/^\uFEFF/,''));
const docs=fs.readFileSync(path.join(__dirname,config.release,'documents.jsonl'),'utf8').trim().split(/\r?\n/).map(JSON.parse).filter(d=>['campus','news','cross_campus'].includes(d.collection));
module.exports={config,docs};
