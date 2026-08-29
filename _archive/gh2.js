'use strict';
const https=require('https');
function get(u){return new Promise((res,rej)=>https.get(u,{headers:{'User-Agent':'node'}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(d))}).on('error',rej));}
(async()=>{
  const u='https://api.github.com/repos/ownlight6/qmc-decoder/contents/src/ekey_fetch.rs';
  const d=JSON.parse(await get(u));
  console.log(Buffer.from(d.content,'base64').toString('utf8'));
})().catch(e=>console.log('ERR',e.message));
