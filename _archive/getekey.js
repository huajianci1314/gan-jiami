'use strict';
const https=require('https');
// 凭证已移除，运行时从环境变量读取。用法：
//   QQ_MUSIC_AUTHST=... QQ_MUSIC_UIN=... node getekey.js
// 正式实现见 decryptor/ekey_fetch.js
const authst = process.env.QQ_MUSIC_AUTHST || '';
const uin = process.env.QQ_MUSIC_UIN || '';
if (!authst) {
  console.error('缺少 QQ_MUSIC_AUTHST 环境变量，源码内不存放任何凭证');
  process.exit(1);
}
const body={comm:{authst,ct:'19',cv:'1859',uin,tmeLoginType:'3'},req_1:{module:'music.vkey.GetEVkey',method:'CgiGetEVkey',param:{filename:['AIM00049KhbW0Bjq0G.mflac'],guid:'10000',songmid:['004AxZur0wQjFR'],songtype:[1],uin,loginflag:1,platform:'27',ctx:1}}};
const data=JSON.stringify(body);
const req=https.request({host:'u.y.qq.com',path:'/cgi-bin/musicu.fcg',method:'POST',
  headers:{'Content-Type':'application/json','User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36','Referer':'https://y.qq.com/','Content-Length':Buffer.byteLength(data)}},res=>{
  let d='';res.on('data',c=>d+=c);res.on('end',()=>{
    try{ const j=JSON.parse(d); const mi=j.req_1&&j.req_1.data&&j.req_1.data.midurlinfo&&j.req_1.data.midurlinfo[0];
      console.log('HTTP',res.statusCode);
      console.log('req_1.code',j.req_1&&j.req_1.code,'| result',mi&&mi.result,'| ekey?',!!(mi&&mi.ekey));
      if(mi&&mi.ekey) console.log('EKEY='+mi.ekey);
      else console.log('raw:',d.slice(0,600));
    }catch(e){console.log('HTTP',res.statusCode,'parse err',e.message,'raw',d.slice(0,400));}
  });
});
req.on('error',e=>console.log('ERR',e.message));
req.write(data);req.end();
