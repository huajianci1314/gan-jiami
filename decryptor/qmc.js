'use strict';
const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');

////////////////////////////////////////////////////////////
// QMC v1 静态密钥（.qmcflac/.qmc0~8/.tkm/.bkc* 等老格式，128 字节公开密钥表）
const V1_STATIC_KEY = Buffer.from([
  0xC3, 0x4A, 0xD6, 0xCA, 0x90, 0x67, 0xF7, 0x52, 0xD8, 0xA1, 0x66, 0x62, 0x9F, 0x5B, 0x09, 0x00,
  0xC3, 0x5E, 0x95, 0x23, 0x9F, 0x13, 0x11, 0x7E, 0xD8, 0x92, 0x3F, 0xBC, 0x90, 0xBB, 0x74, 0x0E,
  0xC3, 0x47, 0x74, 0x3D, 0x90, 0xAA, 0x3F, 0x51, 0xD8, 0xF4, 0x11, 0x84, 0x9F, 0xDE, 0x95, 0x1D,
  0xC3, 0xC6, 0x09, 0xD5, 0x9F, 0xFA, 0x66, 0xF9, 0xD8, 0xF0, 0xF7, 0xA0, 0x90, 0xA1, 0xD6, 0xF3,
  0xC3, 0xF3, 0xD6, 0xA1, 0x90, 0xA0, 0xF7, 0xF0, 0xD8, 0xF9, 0x66, 0xFA, 0x9F, 0xD5, 0x09, 0xC6,
  0xC3, 0x1D, 0x95, 0xDE, 0x9F, 0x84, 0x11, 0xF4, 0xD8, 0x51, 0x3F, 0xAA, 0x90, 0x3D, 0x74, 0x47,
  0xC3, 0x0E, 0x74, 0xBB, 0x90, 0xBC, 0x3F, 0x92, 0xD8, 0x7E, 0x11, 0x13, 0x9F, 0x23, 0x95, 0x5E,
  0xC3, 0x00, 0x09, 0x5B, 0x9F, 0x62, 0x66, 0xA1, 0xD8, 0x52, 0xF7, 0x67, 0x90, 0xCA, 0xD6, 0x4A,
]);
const V1_BOUNDARY = 0x7fff;

// v1 变换：密钥索引 = (offset <= 0x7FFF ? offset : offset % 0x7FFF) % 128。
// 按边界分段处理，段内相位恒定，循环铺密钥流异或。
function qmc1Transform(buf, offsetStart) {
  const key = V1_STATIC_KEY;
  let pos = offsetStart;
  let i = 0;
  const total = buf.length;
  while (i < total) {
    let phase, take;
    if (pos <= V1_BOUNDARY) {
      take = Math.min(V1_BOUNDARY + 1 - pos, total - i);
      phase = pos % 128;
    } else {
      const r = pos % V1_BOUNDARY;
      take = Math.min(V1_BOUNDARY - r, total - i);
      phase = r % 128;
    }
    let j = 0;
    while (j < take) {
      const k = (phase + j) % 128;
      const run = Math.min(128 - k, take - j);
      for (let m = 0; m < run; m++) buf[i + j + m] ^= key[k + m];
      j += run;
    }
    i += take;
    pos += take;
  }
  return buf;
}

// v1 扩展名集合（含十六进制伪装扩展名：666c6163=flac 6d7033=mp3 6f6767=ogg 6d3461=m4a 776176=wav）
const V1_EXTS = new Set([
  '.tkm', '.bkcmp3', '.bkcm4a', '.bkcflac', '.bkcwav', '.bkcape', '.bkcogg', '.bkcwma',
  '.666c6163', '.6d7033', '.6f6767', '.6d3461', '.776176',
  '.qmcflac', '.qmcogg', '.qmc0', '.qmc2', '.qmc3', '.qmc4', '.qmc6', '.qmc8',
]);
const V2_EXTS = new Set(['.mflac', '.mflac0', '.mgg', '.mgg0', '.mgg1', '.mggl', '.mmp4']);

////////////////////////////////////////////////////////////
// QMC v2 文件尾包解析：QTag（安卓内嵌 ekey）/ STag（安卓无 ekey）/ MusicEx（PC 新版）/ PcV1Legacy（PC 老版内嵌 ekey）
const MAX_EKEY_LEN = 0x500;
const B64_CHARS = new Set(Buffer.from('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=', 'latin1'));

function isBase64Text(buf) {
  if (!buf.length) return false;
  for (const b of buf) if (!B64_CHARS.has(b)) return false;
  return true;
}

// 读文件尾部最多 1024 字节并解析，返回 { kind, size, ekey, info } 或 null
function parseQmcFooter(inputPath) {
  const size = fs.statSync(inputPath).size;
  const tailLen = Math.min(1024, size);
  const fd = fs.openSync(inputPath, 'r');
  let tail;
  try {
    tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
  } finally {
    fs.closeSync(fd);
  }
  const tailLatin = tail.toString('latin1');

  // 安卓 STag：[csv][4B 大端长度]STag，无 ekey
  if (tailLen >= 8 && tailLatin.endsWith('STag')) {
    const body = tail.subarray(0, tailLen - 4);
    const payloadLen = body.readUInt32BE(body.length - 4);
    const payload = body.subarray(body.length - 4 - payloadLen, body.length - 4);
    const parts = payload.toString('utf8').split(',');
    if (parts.length === 3 && parts[1] === '2' && /^\d+$/.test(parts[0])) {
      return { kind: 'STag', size: payloadLen + 8, ekey: null, info: null };
    }
    return null;
  }

  // 安卓 QTag：[csv][4B 大端长度]QTag，内嵌 ekey
  if (tailLen >= 8 && tailLatin.endsWith('QTag')) {
    const body = tail.subarray(0, tailLen - 4);
    const payloadLen = body.readUInt32BE(body.length - 4);
    const payload = body.subarray(body.length - 4 - payloadLen, body.length - 4);
    const parts = payload.toString('utf8').split(',');
    if (parts.length === 3 && parts[2] === '2' && /^\d+$/.test(parts[1]) && isBase64Text(Buffer.from(parts[0], 'latin1'))) {
      return { kind: 'QTag', size: payloadLen + 8, ekey: parts[0], info: null };
    }
    return null;
  }

  // PC 新版 MusicEx
  if (tailLen >= 16 && tailLatin.endsWith('musicex\0')) {
    const info = parseMusicex(inputPath);
    return { kind: 'MusicEx', size: info.footerSize, ekey: null, info };
  }

  // PC 经典 PcV1Legacy：[ekey][4B 小端长度]
  if (tailLen >= 8) {
    const payloadLen = tail.readUInt32LE(tailLen - 4);
    if (payloadLen > 0 && payloadLen <= MAX_EKEY_LEN && payloadLen + 4 <= tailLen) {
      let ekeyBuf = tail.subarray(tailLen - 4 - payloadLen, tailLen - 4);
      const zero = ekeyBuf.indexOf(0);
      if (zero !== -1) ekeyBuf = ekeyBuf.subarray(0, zero);
      if (isBase64Text(ekeyBuf)) {
        return { kind: 'PcV1Legacy', size: payloadLen + 4, ekey: ekeyBuf.toString('latin1'), info: null };
      }
    }
  }
  return null;
}

// 统一判型入口：v1 扩展名 / 尾包嗅探 / v1 回退试解
function probeQmc(inputPath) {
  const ext = path.extname(inputPath).toLowerCase();
  if (V1_EXTS.has(ext)) return { type: 'v1', footer: null };
  const footer = parseQmcFooter(inputPath);
  if (footer) return { type: 'v2', footer };
  // 无尾包：可能是改名的 v1 文件，用静态密钥试解头部后嗅探
  const fd = fs.openSync(inputPath, 'r');
  let head;
  try {
    head = Buffer.alloc(64);
    fs.readSync(fd, head, 0, 64, 0);
  } finally {
    fs.closeSync(fd);
  }
  qmc1Transform(head, 0);
  if (sniffExtFromHead(head) !== 'bin') return { type: 'v1', footer: null, forced: true };
  throw new Error('不是支持的 QQ 音乐格式（未找到尾包，静态密钥试解亦无法识别音频头）');
}

// 通用音频容器嗅探（fLaC/OggS/ID3/RIFF+WAVE/ftyp/裸 mp3 帧同步）
function sniffExtFromHead(buf) {
  if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === 'fLaC') return 'flac';
  if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === 'OggS') return 'ogg';
  if (buf.length >= 3 && buf.subarray(0, 3).toString('latin1') === 'ID3') return 'mp3';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WAVE') return 'wav';
  if (buf.length >= 8 && buf.subarray(4, 8).toString('latin1') === 'ftyp') return 'm4a';
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3';
  return 'bin';
}

////////////////////////////////////////////////////////////
// TC-TEA（腾讯加固版，随机盐 + 变形 CBC），与 jixunmoe/tc_tea_rust 一致
const TEA_DELTA = 0x9e3779b9n;
const M32 = 0xffffffffn;
const SALT_LEN = 2;
const ZERO_LEN = 7;

function teaSingleRound(value, sum, key1, key2) {
  const left = ((value << 4n) + key1) & M32;
  const right = ((value >> 5n) + key2) & M32;
  const mid = (sum + value) & M32;
  return (left ^ mid ^ right) & M32;
}

function teaEcbDecryptBlock(block, k) {
  let y = block >> 32n;
  let z = block & M32;
  let sum = (TEA_DELTA * 16n) & M32;
  for (let i = 0; i < 16; i++) {
    z = (z - teaSingleRound(y, sum, k[2], k[3])) & M32;
    y = (y - teaSingleRound(z, sum, k[0], k[1])) & M32;
    sum = (sum - TEA_DELTA) & M32;
  }
  return (y << 32n) | z;
}

function teaKeyWords(keyBytes) {
  const k = [];
  for (let i = 0; i < 4; i++) {
    k.push(BigInt(keyBytes.readUInt32BE(i * 4)));
  }
  return k;
}

// 解密 tc_tea 密文，返回明文主体（去掉头部随机盐与尾部零填充）
function teaDecrypt(data, key) {
  if (data.length % 8 !== 0 || data.length < 10) {
    throw new Error('TC-TEA 数据长度非法');
  }
  const k = teaKeyWords(key);
  const out = Buffer.alloc(data.length);
  let iv1 = 0n;
  let iv2 = 0n;
  for (let off = 0; off < data.length; off += 8) {
    const cipherBlock = data.readBigUInt64BE(off);
    const result = cipherBlock ^ iv2;
    const nextIv2 = teaEcbDecryptBlock(result, k);
    const plain = nextIv2 ^ iv1;
    out.writeBigUInt64BE(plain, off);
    iv1 = cipherBlock;
    iv2 = nextIv2;
  }
  const padSize = out[0] & 0b111;
  const start = 1 + padSize + SALT_LEN;
  const end = data.length - ZERO_LEN;
  for (let i = end; i < data.length; i++) {
    if (out[i] !== 0) throw new Error('TC-TEA 尾部填充校验失败');
  }
  return out.subarray(start, end);
}

////////////////////////////////////////////////////////////
// ekey 解析（映射到 qmc2.rs parse_ekey）
const ENCV2_PREFIX = Buffer.from('QQMusic EncV2,Key:', 'ascii');
const ENCV2_STAGE1_KEY = Buffer.from('386ZJY!@#*$%^&)(', 'latin1');
const ENCV2_STAGE2_KEY = Buffer.from('**#!(#$%&^a1cZ,T', 'latin1');

function simpleMakeKey(seed, size) {
  const res = Buffer.alloc(size);
  for (let i = 0; i < size; i++) {
    const value = seed + i * 0.1;
    res[i] = Math.floor(Math.abs(100 * Math.tan(value))) & 0xff;
  }
  return res;
}

function deriveTeaKey(ekeyHeader) {
  const simple = simpleMakeKey(106, 8);
  const teaKey = Buffer.alloc(16);
  for (let i = 0; i < 16; i += 2) {
    teaKey[i] = simple[i / 2];
    teaKey[i + 1] = ekeyHeader[i / 2];
  }
  return teaKey;
}

function parseEKey(ekey) {
  const trimmed = ekey.replace(/\0+$/g, '');
  let decoded = Buffer.from(trimmed, 'base64');
  if (decoded.length === 0) throw new Error('ekey base64 解码为空');

  // EncV2
  if (decoded.subarray(0, ENCV2_PREFIX.length).equals(ENCV2_PREFIX)) {
    const blob = decoded.subarray(ENCV2_PREFIX.length);
    const s1 = teaDecrypt(blob, ENCV2_STAGE1_KEY);
    const s2 = teaDecrypt(s1, ENCV2_STAGE2_KEY);
    decoded = Buffer.from(s2.toString('latin1').replace(/\s+/g, ''), 'base64');
  }

  if (decoded.length < 8) throw new Error('ekey 解码后过短 (<8)');
  const header = decoded.subarray(0, 8);
  const body = decoded.subarray(8);
  if (body.length === 0) return Buffer.from(header);

  const teaKey = deriveTeaKey(header);
  try {
    const decBody = teaDecrypt(body, teaKey);
    return Buffer.concat([header, decBody]);
  } catch (_e) {
    return Buffer.from(decoded);
  }
}

////////////////////////////////////////////////////////////
// QMC2 Map 密码（key <= 300）
function scrambleByIndex(value, index) {
  const rotation = (index + 4) & 0b111;
  return (((value << rotation) | (value >> rotation)) & 0xff) >>> 0;
}

function mapL(key, offset) {
  let ol = offset;
  if (ol > 0x7fff) ol %= 0x7fff;
  const index = ((ol * ol + 71214) % key.length) >>> 0;
  return scrambleByIndex(key[index], index);
}

////////////////////////////////////////////////////////////
// QMC2 RC4 密码（key > 300）
const FIRST_SEG = 0x80;
const OTHER_SEG = 0x1400;
const U32_MAX = 0xffffffff;

function calcHashBase(data) {
  let hash = 1;
  for (const v of data) {
    if (v === 0) continue;
    const next = (hash * v) >>> 0;
    if (next === 0 || next <= hash) break;
    hash = next;
  }
  return hash;
}

function buildQmcRc4S(key) {
  const n = key.length;
  let s;
  if (n <= 256) {
    s = [];
    for (let i = 0; i < n; i++) s.push(i);
  } else {
    s = [];
    for (let i = 0; i <= 255; i++) s.push(i);
    let i = 256;
    while (s.length < n) { s.push(i % 256); i++; }
  }
  let j = 0;
  for (let i = 0; i < n; i++) {
    j = (j + s[i] + key[i]) % n;
    const t = s[i]; s[i] = s[j]; s[j] = t;
  }
  return { s, n, hash: calcHashBase(key), key };
}

// 复刻 Rust `as u32` 的饱和转换语义（Rust 1.45 起）：NaN 转 0，超出 u32 上界转 u32::MAX，其余向零截断。
// 原版用 f64 算出 key 后由编译器做饱和转换，JS 的 Math.trunc 没有这层处理，会留下两类分叉：
//   1. seed 为 0 时 divisor 归零，f64 除零得 ±Infinity（或 hash 为 0 时得 NaN）；
//   2. hash 中位数在 3e9 量级，hash*100/divisor 在 seed 偏小时轻松越过 u32 上界。
// 随机密钥实测分叉率约 1.3%，其中溢出上界一项占比高于除零，两者必须一起处理。
function calcSegmentKey(hash, id, seed) {
  const divisor = (id + 1) * seed;
  const key = (hash / divisor) * 100.0;
  if (Number.isNaN(key)) return 0;
  if (key >= U32_MAX) return U32_MAX;
  if (key <= 0) return 0;
  return Math.trunc(key);
}

function rc4Derive(n, s, st) {
  st.j = (st.j + 1) % n;
  st.k = (s[st.j] + st.k) % n;
  const t = s[st.j]; s[st.j] = s[st.k]; s[st.k] = t;
  const idx = s[st.j] + s[st.k];
  return s[idx % n];
}

class Qmc2 {
  constructor(ekey) {
    this.key = parseEKey(ekey);
    if (this.key.length > 300) {
      this.mode = 'rc4';
      this.rc4 = buildQmcRc4S(this.key);
    } else {
      this.mode = 'map';
    }
  }
  decrypt(buf, offset) {
    let off = offset >>> 0;
    if (this.mode === 'map') {
      for (let i = 0; i < buf.length; i++) buf[i] ^= mapL(this.key, off + i);
      return;
    }
    // RC4
    const { n, key, hash } = this.rc4;
    let i = 0;
    let len = buf.length;
    if (off < FIRST_SEG) {
      const p = Math.min(len, FIRST_SEG - off);
      for (let k = 0; k < p; k++) {
        const offk = off + k;
        const key1 = key[offk % n];
        const key2 = calcSegmentKey(hash, offk, key1);
        buf[i + k] ^= key[key2 % n];
      }
      i += p; len -= p; off += p;
    }
    if (len <= 0) return;
    const toAlign = off % OTHER_SEG;
    if (toAlign !== 0) {
      const p = Math.min(len, OTHER_SEG - toAlign);
      this._encOther(off, buf, i, p);
      i += p; len -= p; off += p;
    }
    while (len > OTHER_SEG) {
      this._encOther(off, buf, i, OTHER_SEG);
      i += OTHER_SEG; len -= OTHER_SEG; off += OTHER_SEG;
    }
    if (len > 0) this._encOther(off, buf, i, len);
  }
  _encOther(offset, buf, start, count) {
    const { n, key, hash, s: baseS } = this.rc4;
    const segId = (offset / OTHER_SEG) | 0;
    const segIdSmall = segId & 0x1ff;
    let discard = calcSegmentKey(hash, segId, key[segIdSmall]) & 0x1ff;
    discard += offset % OTHER_SEG;
    const s = baseS.slice();
    const st = { j: 0, k: 0 };
    for (let d = 0; d < discard; d++) rc4Derive(n, s, st);
    for (let k = 0; k < count; k++) buf[start + k] ^= rc4Derive(n, s, st);
  }
}

////////////////////////////////////////////////////////////
// musicex 页脚解析
function parseMusicex(filePath) {
  const size = fs.statSync(filePath).size;
  const fd = fs.openSync(filePath, 'r');
  try {
    const tail = Buffer.alloc(16);
    fs.readSync(fd, tail, 0, 16, size - 16);
    if (tail.subarray(8, 16).toString('latin1') !== 'musicex\0') {
      throw new Error('不是 musicex 格式（尾部应为 musicex\\0）');
    }
    const footerSize = tail.readUInt32LE(0);
    const version = tail.readUInt32LE(4);
    const footerStart = size - footerSize;
    const foot = Buffer.alloc(footerSize);
    fs.readSync(fd, foot, 0, footerSize, footerStart);

    const readUtf16 = (off, max) => {
      let stop = off + max;
      for (let i = off; i < off + max; i += 2) {
        if (foot[i] === 0 && foot[i + 1] === 0) { stop = i; break; }
      }
      return foot.subarray(off, stop).toString('utf16le');
    };

    return {
      songId: foot.readUInt32LE(0),
      quality1: foot.readUInt32LE(4),
      mediaMid: readUtf16(0x0c, 60),
      filename: readUtf16(0x48, 68),
      footerSize,
      version,
      audioLength: size - footerSize,
    };
  } finally {
    fs.closeSync(fd);
  }
}

////////////////////////////////////////////////////////////
// 解密入口：probe 可由调用方传入（避免重复判型）
// 返回值新增 keySource（static/manual/embedded）与 footerKind
async function decryptQmc(inputPath, outputPath, ekey, onProgress, probe) {
  const p = probe || probeQmc(inputPath);
  const fileSize = fs.statSync(inputPath).size;

  // ---------- v1：公开静态密钥，全文件解密，无需钥匙 ----------
  if (p.type === 'v1') {
    const head = Buffer.alloc(64);
    const fd0 = fs.openSync(inputPath, 'r');
    try { fs.readSync(fd0, head, 0, 64, 0); } finally { fs.closeSync(fd0); }
    qmc1Transform(head, 0);
    const ext = sniffExtFromHead(head);

    if (outputPath === null) {
      const base = inputPath.slice(0, -path.extname(inputPath).length);
      outputPath = base + '.' + ext;
    }

    const rs = fs.createReadStream(inputPath);
    const out = fs.createWriteStream(outputPath);
    const xor = new (class extends Transform {
      constructor() { super(); this.off = 0; }
      _transform(chunk, _e, cb) {
        const b = Buffer.from(chunk);
        qmc1Transform(b, this.off);
        this.off += b.length;
        cb(null, b);
      }
    })();

    await new Promise((resolve, reject) => {
      let done = 0;
      const total = fileSize;
    // 任一侧出错都要销毁整条流水线，否则会留下未关闭的 fd
    const fail = (e) => { rs.destroy(); xor.destroy(); out.destroy(); reject(e); };
    rs.on('data', (c) => { done += c.length; onProgress && onProgress(done / total); });
    rs.on('error', fail);
    xor.on('error', fail);
    out.on('error', fail);
    out.on('finish', resolve);
    rs.pipe(xor).pipe(out);
  });

  return { format: ext, outputPath, info: null, keyLength: 128, mode: 'v1-static', keySource: 'static', footerKind: null };
  }

  // ---------- v2：Qmc2（Map/RC4），钥匙优先级：手动 > 文件内嵌 > 本机客户端（由上层处理） ----------
  const footer = p.footer;
  const manualKey = typeof ekey === 'string' ? ekey.trim() : '';
  const usedEkey = manualKey || (footer && footer.ekey);
  if (!usedEkey) {
    const err = new Error('该文件未内嵌解密钥匙，需要手动提供 ekey 才能解密');
    err.code = 'NEED_EKEY';
    err.footerKind = footer ? footer.kind : null;
    throw err;
  }
  const keySource = manualKey ? 'manual' : 'embedded';

  const audioLength = fileSize - footer.size;
  const cipher = new Qmc2(usedEkey);

  // 探测格式
  const pb = Buffer.alloc(Math.min(4096, audioLength));
  const rd = fs.openSync(inputPath, 'r');
  fs.readSync(rd, pb, 0, pb.length, 0);
  fs.closeSync(rd);
  cipher.decrypt(pb, 0);
  const ext = sniffExtFromHead(pb);

  if (outputPath === null) {
    const base = inputPath.slice(0, -path.extname(inputPath).length);
    outputPath = base + '.' + ext;
  }

  const rs = fs.createReadStream(inputPath, { start: 0, end: audioLength - 1 });
  const out = fs.createWriteStream(outputPath);
  const xor = new (class extends Transform {
    constructor() { super(); this.off = 0; }
    _transform(chunk, _e, cb) {
      const b = Buffer.from(chunk);
      cipher.decrypt(b, this.off);
      this.off += b.length;
      cb(null, b);
    }
  })();

  await new Promise((resolve, reject) => {
    let done = 0;
    const total = audioLength;
    // 任一侧出错都要销毁整条流水线，否则会留下未关闭的 fd
    const fail = (e) => { rs.destroy(); xor.destroy(); out.destroy(); reject(e); };
    rs.on('data', (c) => { done += c.length; onProgress && onProgress(done / total); });
    rs.on('error', fail);
    xor.on('error', fail);
    out.on('error', fail);
    out.on('finish', resolve);
    rs.pipe(xor).pipe(out);
  });

  return { format: ext, outputPath, info: footer.info, keyLength: cipher.key.length, mode: cipher.mode, keySource, footerKind: footer.kind };
}

module.exports = { parseMusicex, decryptQmc, parseEKey, teaDecrypt, buildQmcRc4S, Qmc2, simpleMakeKey, mapL, calcHashBase, calcSegmentKey, deriveTeaKey, probeQmc, parseQmcFooter, qmc1Transform, sniffExtFromHead, V1_EXTS, V2_EXTS, ENCV2_PREFIX, ENCV2_STAGE1_KEY, ENCV2_STAGE2_KEY };