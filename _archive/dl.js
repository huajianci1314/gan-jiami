'use strict';
const https=require('https'), fs=require('fs');
const url='https://github.com/ownlight6/qmc-decoder/releases/download/v1.3.0/QMC.Decoder_1.3.0_x64_en-US.msi';
const out='e:/CloudMusic/VipSongsDownload/_tools/qmc-decoder.msi';
function get(u, redirects){
  return new Promise((resolve,reject)=>{
    const req=https.get(u,{headers:{'User-Agent':'node','Accept':'*/*'}},res=>{
      if(res.statusCode>=300 && res.statusCode<400 && res.headers.location){
        res.resume();
        if(redirects>4) return reject(new Error('too many redirects'));
        return resolve(get(res.headers.location, redirects+1));
      }
      resolve(res);
    });
    req.on('error',reject);
  });
}
get(url,0).then(res=>{
  console.log('final status',res.statusCode,'final url',res.req.path.slice(0,40));
  const w=fs.createWriteStream(out);
  res.pipe(w);
  w.on('finish',()=>console.log('saved bytes',fs.statSync(out).size));
}).catch(e=>console.log('ERR',e.message));
