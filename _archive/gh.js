'use strict';
const https=require('https');
function getJson(u){return new Promise((res,rej)=>{https.get(u,{headers:{'User-Agent':'node'}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}})}).on('error',rej);});}
(async()=>{
  const tree=await getJson('https://api.github.com/repos/ownlight6/qmc-decoder/git/trees/main?recursive=1');
  if(!tree.tree) return console.log('tree err', JSON.stringify(tree).slice(0,300));
  const rs=tree.tree.filter(n=>/ekey|api|fetch|auth|login|cookie/i.test(n.path)).map(n=>n.path);
  console.log('relevant files:\n'+rs.join('\n'));
})().catch(e=>console.log('ERR',e.message));
