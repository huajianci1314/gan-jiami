'use strict';
const fs=require('fs');
const base=process.env.APPDATA+'/Tencent/QQMusic';
const pats=[Buffer.from('"authst":"','latin1'), Buffer.from('"authst": "','latin1')];
let found=false;
function walk(d, depth){
  if(depth>6) return;
  let items; try{ items=fs.readdirSync(d,{withFileTypes:true}); }catch(e){ return; }
  for(const it of items){
    const p=d+'/'+it.name;
    if(it.isDirectory()){ walk(p, depth+1); continue; }
    try{ const st=fs.statSync(p); if(st.size>50*1024*1024) continue; }catch(e){ continue; }
    try{
      const fh=fs.openSync(p,'r'); const buf=Buffer.alloc(fs.fstatSync(fh).size); fs.readSync(fh,buf,0,buf.length,0); fs.closeSync(fh);
      for(const pat of pats){
        const idx=buf.indexOf(pat);
        if(idx>=0){ found=true; console.log('AUTHST-PATTERN at', p, 'offset', idx); break; }
      }
    }catch(e){}
  }
}
walk(base, 0);
if(!found) console.log('no "authst": pattern in files under QQMusic dir');
