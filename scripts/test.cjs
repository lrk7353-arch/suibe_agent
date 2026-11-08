const {spawnSync}=require('node:child_process');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const suite=process.argv[2]||'all';
if(!['all','trade','api'].includes(suite))throw Error('Unknown suite');
const env={...process.env};
if(suite!=='api'&&!env.PYTHON){
  env.PYTHON=['python3','python'].find(p=>spawnSync(p,['--version']).status===0);
  if(!env.PYTHON)throw Error('Python 3 required; set PYTHON');
}
const tests=[];
if(suite!=='api')tests.push('apps/trade/tests/run-cases.cjs','apps/trade/tests/run-core-flow.cjs');
if(suite!=='trade')tests.push('apps/campus/tests/test-api-provider.cjs');
for(const file of tests){
 const result=spawnSync(process.execPath,[path.join(root,file)],{cwd:root,env,stdio:'inherit'});
 if(result.error)throw result.error;
 if(result.status!==0)process.exit(result.status||1);
}
