'use strict';
const fs = require('fs');
function crc8(data){
  let c=0; for(const v of data){ c^=v; for(let i=0;i<8;i++){ c = (c&0x80)? ((c<<1)^0x07)&0xff : (c<<1)&0xff; } } return c&0xff;
}
const BS={0:192,1:576,2:1152,3:2304,4:4608,5:8192,8:256,9:512,10:1024,11:2048,12:4096,13:8192,14:16384,15:32768};
const BPS={0:0,1:0,2:16,3:20,4:24,5:32};
function headerLen(buf){
  // returns framed header total length or null
  if(buf.length<10||buf[0]!==0xff||(buf[1]&0xfe)!==0xf8) return null;
  const bs_code=buf[2]>>4, sr_code=buf[2]&0x0f, ch_code=buf[3]>>4, ss=(buf[3]>>1)&7;
  if((buf[3]&1)!==0) return null;
  let n=4, first=buf[n], u=1;
  if(first&0x80){
    if((first&0xc0)===0xc0){ u++;
      if((first&0xe0)===0xe0){ u++;
        if((first&0xf0)===0xf0){ u++;
          if((first&0xf8)===0xf8){ u++;
            if((first&0xfc)===0xfc) u++; } } } }
  }
  n+=u;
  if(bs_code===6) n+=1; else if(bs_code===7) n+=3;
  if(sr_code===12) n+=1; else if(sr_code===13||sr_code===14) n+=2;
  return n+1;
}
function validFramesAt(src, start, count){
  let ok=0, pos=start, end=Math.min(src.length, start+count);
  while(pos<end-8){
    const h=headerLen(src.subarray(pos,pos+32));
    if(h!==null && pos+h<=src.length){
      if(crc8(src.subarray(pos,pos+h-1))===src[pos+h-1]){ ok++; pos+=h; continue; }
    }
    pos++;
  }
  return ok;
}
// region scan of fresh NCM output
const p=process.argv[2];
const fd=fs.openSync(p,'r'); const size=fs.fstatSync(fd).size;
const ALLOC=8*1024*1024; const buf=Buffer.alloc(ALLOC);
const REGION=16*1024*1024;
let idx=0;
// read whole file in chunks but track region each 16MB
const whole=[];
let r=0;
console.log('scanning',p,'size',size);
// sample-based: for region [base, base+REGION), count valid frames in that window
for(let base=0; base<size; base+=REGION){
  // read region into buffer (cap)
  const want=Math.min(REGION+1024, size-base);
  const rb=Buffer.alloc(want);
  fs.readSync(fd, rb, 0, want, base);
  const ok=validFramesAt(rb,0,rb.length);
  console.log(`region@${(base/1024/1024).toFixed(0)}MB validFrames=${ok}`);
}
fs.closeSync(fd);