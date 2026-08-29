'use strict';
// 酷我音乐 KWM 解密器（老版格式：1024 字节头 + 32 字节循环异或密钥）
// 移植自 HRuiCcc/music-geshizhuanhuan music_unlock/formats/kwm.py
const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');
const { sniffExtFromHead } = require('./qmc');

const HEADER_LEN = 1024;
const KEY_LEN = 32;
const MAX_SCAN_CHUNKS = 2048; // 密钥恢复扫描的 32 字节块数上限

// 解密头可能以静音（0x00）开头（如 mp3 前导静音），嗅探前先跳过前导零字节
function sniffStripped(buf) {
  let start = 0;
  while (start < buf.length && buf[start] === 0) start++;
  return sniffExtFromHead(buf.subarray(start, Math.min(start + 64, buf.length)));
}

// 恢复 32 字节密钥：相邻相同块（明文全零区）> 尾块前后交换 > 前 64 块逐试
function recoverKey(scanBuf, bodyHead, chunkCount) {
  const probeOf = (key) => {
    const probe = Buffer.from(bodyHead);
    for (let i = 0; i < probe.length; i++) probe[i] ^= key[i & (KEY_LEN - 1)];
    return sniffStripped(probe);
  };

  const candidates = [];
  let prev = scanBuf.subarray(0, KEY_LEN);
  for (let i = 1; i < chunkCount; i++) {
    const chunk = scanBuf.subarray(i * KEY_LEN, (i + 1) * KEY_LEN);
    if (chunk.equals(prev)) candidates.push(Buffer.from(chunk));
    prev = chunk;
  }
  // 候选 2：扫描到的最后一块前后 16 字节交换（老工具的回退方案）
  const tail = Buffer.from(prev);
  candidates.push(Buffer.concat([tail.subarray(KEY_LEN / 2), tail.subarray(0, KEY_LEN / 2)]));

  for (const key of candidates) {
    if (probeOf(key) !== 'bin') return { key, format: probeOf(key) };
  }
  // 扩大范围：前 64 块全部当候选试一遍
  const limit64 = Math.min(64, chunkCount);
  for (let i = 0; i < limit64; i++) {
    const key = scanBuf.subarray(i * KEY_LEN, (i + 1) * KEY_LEN);
    const fmt = probeOf(key);
    if (fmt !== 'bin') return { key: Buffer.from(key), format: fmt };
  }
  // 兜底：仍按第一候选输出
  return { key: candidates[0], format: probeOf(candidates[0]) };
}

async function decryptKwm(inputPath, outputPath, _ekey, onProgress) {
  const size = fs.statSync(inputPath).size;
  if (size < HEADER_LEN + KEY_LEN * 2) {
    throw new Error('文件过短，不是合法的酷我 KWM 文件');
  }

  // 一次性读入扫描区（最多 64KB）与体部前 4096 字节用于试解
  const bodyLen = size - HEADER_LEN;
  const chunkCount = Math.min(MAX_SCAN_CHUNKS, Math.floor(bodyLen / KEY_LEN));
  const scanLen = chunkCount * KEY_LEN;
  const fd = fs.openSync(inputPath, 'r');
  let scanBuf, bodyHead;
  try {
    scanBuf = Buffer.alloc(scanLen);
    fs.readSync(fd, scanBuf, 0, scanLen, HEADER_LEN);
    bodyHead = Buffer.alloc(Math.min(4096, bodyLen));
    fs.readSync(fd, bodyHead, 0, bodyHead.length, HEADER_LEN);
  } finally {
    fs.closeSync(fd);
  }

  const { key, format } = recoverKey(scanBuf, bodyHead, chunkCount);
  const ext = format === 'bin' ? 'mp3' : format; // 兜底密钥嗅探失败时按 mp3 输出

  if (outputPath === null) {
    const base = inputPath.slice(0, -path.extname(inputPath).length);
    outputPath = base + '.' + ext;
  }

  const rs = fs.createReadStream(inputPath, { start: HEADER_LEN });
  const out = fs.createWriteStream(outputPath);
  const xor = new (class extends Transform {
    constructor() { super(); this.off = 0; }
    _transform(chunk, _e, cb) {
      const b = Buffer.from(chunk);
      for (let i = 0; i < b.length; i++) b[i] ^= key[(this.off + i) & (KEY_LEN - 1)];
      this.off += b.length;
      cb(null, b);
    }
  })();

  await new Promise((resolve, reject) => {
    let done = 0;
    const total = bodyLen;
    // 任一侧出错都要销毁整条流水线，否则会留下未关闭的 fd
    const fail = (e) => { rs.destroy(); xor.destroy(); out.destroy(); reject(e); };
    rs.on('data', (c) => { done += c.length; onProgress && onProgress(done / total); });
    rs.on('error', fail);
    xor.on('error', fail);
    out.on('error', fail);
    out.on('finish', resolve);
    rs.pipe(xor).pipe(out);
  });

  return { format: ext, outputPath, info: null, keySource: 'kwm-recovered', footerKind: null };
}

module.exports = { decryptKwm, HEADER_LEN, KEY_LEN };
