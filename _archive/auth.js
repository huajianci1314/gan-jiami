'use strict';
const fs=require('fs');
const base=process.env.APPDATA+'/Tencent/QQMusic';
for(const f of ['SetCookie.dat','_SetCookie.dat']){
  const p=base+'/'+f;
  if(!fs.existsSync(p)) continue;
  const d=fs.readFileSync(p);
  console.log(`\n[${f}] size=${d.length} ascii sample: ${JSON.stringify(d.subarray(0,80).toString('latin1'))}`);
  // look for "authst":"
  const m=d.toString('latin1');
  const idx=m.indexOf('"authst":"');
  if(idx>=0){ const s=d.subarray(idx+10); let e=0; for(let i=0;i<s.length;i++){if(s[i]===34){e=i;break;}} let tok=''; for(let i=0;i<e&&i<s.length;i++) tok+=String.fromCharCode(s[i]); console.log('  authst found len',tok.length); }
  else console.log('  no "authst":" pattern');
}
