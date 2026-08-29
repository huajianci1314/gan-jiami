'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');

const MAGIC = Buffer.from('CTENFDAM', 'ascii');
const CORE_KEY = Buffer.from('hzHRAmso5kInbaxW', 'latin1');
const META_KEY = Buffer.from("#14ljk_!\\]&0U<'(", 'latin1');
const KEY_PREFIX = Buffer.from('neteasecloudmusic', 'ascii');
const META_PLAIN_PREFIX = Buffer.from("163 key(Don't modify):", 'ascii');
const META_PREFIX = Buffer.from('music:', 'ascii');
const KEY_XOR_MASK = 0x64;
const META_XOR_MASK = 0x63;

function u32le(buf, pos) {
  return buf.readUInt32LE(pos);
}

function aes128ecbDecrypt(key, data) {
  const dec = crypto.createDecipheriv('aes-128-ecb', key, null);
  dec.setAutoPadding(true);
  return Buffer.concat([dec.update(data), dec.final()]);
}

function buildKeyBox(key) {
  const box = new Uint8Array(256);
  for (let i = 0; i < 256; i++) box[i] = i;
  const kl = key.length;
  let lastByte = 0;
  let keyOffset = 0;
  for (let i = 0; i < 256; i++) {
    const swap = box[i];
    const c = (swap + lastByte + key[keyOffset]) & 0xff;
    keyOffset = keyOffset + 1 >= kl ? 0 : keyOffset + 1;
    box[i] = box[c];
    box[c] = swap;
    lastByte = c;
  }
  return box;
}

// 流式解密 audio：按文件绝对偏移计算出对应位置的异或密钥字节
class NcmXor extends Transform {
  constructor(box, baseOffset, options = {}) {
    super(options);
    this.box = box;
    this.offset = baseOffset;
  }
  _transform(chunk, _enc, cb) {
    for (let i = 0; i < chunk.length; i++) {
      const o = this.offset + i;
      const j = (o + 1) & 0xff;
      const a = this.box[j];
      const b = this.box[(a + j) & 0xff];
      chunk[i] ^= this.box[(a + b) & 0xff];
    }
    this.offset += chunk.length;
    cb(null, chunk);
  }
}

// 解析 ncm 头部，返回 { meta, format, audioStart, box, cover }
// 支持两种可能的 header 布局（meta 后是否带 CRC/gap 块）
// fileSize 用于边界校验（封面帧可能远超头部缓冲，需对照真实文件大小）
function parseNcm(buf, fileSize) {
  if (!buf.subarray(0, 8).equals(MAGIC)) throw new Error('不是有效的 .ncm 文件（魔数应为 CTENFDAM）');
  let pos = 10; // 8 magic + 2 gap
  const total = fileSize || buf.length;

  const keyLen = u32le(buf, pos);
  pos += 4;
  if (keyLen > total) throw new Error('ncm 头部密钥长度异常');
  const keyData = buf.subarray(pos, pos + keyLen);
  pos += keyLen;

  // 解密 AES key
  const xored = Buffer.from(keyData.map((b) => b ^ KEY_XOR_MASK));
  let dec;
  try {
    dec = aes128ecbDecrypt(CORE_KEY, xored);
  } catch (e) {
    throw new Error('AES key 解密失败：' + e.message);
  }
  let keyMaterial = dec;
  if (dec.subarray(0, KEY_PREFIX.length).equals(KEY_PREFIX)) keyMaterial = dec.subarray(KEY_PREFIX.length);
  const keyBox = buildKeyBox(keyMaterial);

  // meta
  const metaLen = u32le(buf, pos);
  pos += 4;
  let meta = null;
  if (metaLen > 0) {
    const metaRaw = buf.subarray(pos, pos + metaLen);
    pos += metaLen;
    try {
      const mx = Buffer.from(metaRaw.map((b) => b ^ META_XOR_MASK));
      let raw = mx;
      if (mx.subarray(0, META_PLAIN_PREFIX.length).equals(META_PLAIN_PREFIX)) raw = mx.subarray(META_PLAIN_PREFIX.length);
      const b64 = Buffer.from(raw.toString('binary'), 'base64');
      let mm = aes128ecbDecrypt(META_KEY, b64);
      if (mm.subarray(0, META_PREFIX.length).equals(META_PREFIX)) mm = mm.subarray(META_PREFIX.length);
      meta = JSON.parse(mm.toString('utf8'));
    } catch (_e) {
      meta = null;
    }
  }

  // 定位音频起点（ncmcrypt.py 布局）：meta 后跳过 5 字节(CRC32+图片版本)，再读封面帧。
  // 长度字段位于 meta 之后固定小偏移处，必然落在头部缓冲内；判断其是否延伸入文件用真实文件大小 total。
  // 音频起点 = 封面帧号字段(4) + img_len 字段(4) + 封面帧体(coverFrameLen)
  const imageSpace = u32le(buf, pos + 5);
  const imageSize = u32le(buf, pos + 9);
  const audioStart = pos + 5 + 8 + imageSpace;
  const coverStart = audioStart - imageSpace;

  return { meta, keyBox, audioStart, coverStart, imageSize };
}

// 封面图片类型嗅探
function sniffImage(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  return null;
}

async function decryptNcm(inputPath, outputPath, onProgress, options = {}) {
  const fd = fs.openSync(inputPath, 'r');
  const stat = fs.fstatSync(fd);
  const headLen = Math.min(64 * 1024, stat.size);
  const head = Buffer.alloc(headLen);
  fs.readSync(fd, head, 0, headLen, 0);

  const { meta, keyBox, audioStart, coverStart, imageSize } = parseNcm(head, stat.size);

  // 提取专辑封面（参考 music-geshizhuanhuan formats/ncm.py 的封面区解析）
  let coverPath = null;
  if (imageSize > 0 && coverStart >= 0 && coverStart + imageSize <= stat.size) {
    const coverBuf = Buffer.alloc(Math.min(imageSize, 16 * 1024 * 1024));
    fs.readSync(fd, coverBuf, 0, coverBuf.length, coverStart);
    const kind = sniffImage(coverBuf);
    if (kind) {
      const base = options.coverPath || (outputPath
        ? outputPath.replace(/\.[^.]+$/, '') + '.cover'
        : inputPath.slice(0, -path.extname(inputPath).length) + '.cover');
      coverPath = base + '.' + kind;
      try { fs.writeFileSync(coverPath, coverBuf); } catch (_e) { coverPath = null; }
    }
  }

  // 检测音频格式（解密首个字节块后看魔数，密钥流偏移相对音频起点归零）
  const probe = Buffer.alloc(4096);
  const n = fs.readSync(fd, probe, 0, Math.min(4096, stat.size - audioStart), audioStart);
  const pbuf = Buffer.from(probe.subarray(0, n));
  const box2 = keyBox;
  for (let i = 0; i < pbuf.length; i++) {
    const j = (i + 1) & 0xff;
    const a = box2[j];
    const b = box2[(a + j) & 0xff];
    pbuf[i] ^= box2[(a + b) & 0xff];
  }
  let ext = 'bin';
  if (pbuf.length >= 4 && pbuf.subarray(0, 4).toString('ascii') === 'fLaC') ext = 'flac';
  else if (pbuf.subarray(0, 3).toString('ascii') === 'ID3') ext = 'mp3';
  else if (pbuf.length >= 8 && pbuf.subarray(4, 8).toString('ascii') === 'ftyp') ext = 'm4a';
  else if (pbuf.length >= 4 && pbuf.toString('ascii', 0, 4) === 'OggS') ext = 'ogg';

  if (outputPath === null) {
    const base = inputPath.slice(0, -path.extname(inputPath).length);
    outputPath = base + '.' + ext;
  } else if (path.extname(outputPath) === '') {
    outputPath = outputPath + '.' + ext;
  }

  const out = fs.createWriteStream(outputPath);
  // 密钥流相对音频起点从 0 计；输入流已从 audioStart 开始
  const xor = new NcmXor(keyBox, 0);

  // 用流写入，从 audioStart 处开始读
  await new Promise((resolve, reject) => {
    let total = stat.size - audioStart;
    let done = 0;
    const rs = fs.createReadStream(inputPath, { start: audioStart });
    // 任一侧出错都要销毁整条流水线，否则会留下未关闭的 fd
    const fail = (e) => { rs.destroy(); xor.destroy(); out.destroy(); reject(e); };
    rs.pipe(xor).pipe(out);
    rs.on('data', () => {
      done = Math.min(total, done + 64 * 1024);
      onProgress && onProgress(done / total);
    });
    out.on('finish', resolve);
    rs.on('error', fail);
    xor.on('error', fail);
    out.on('error', fail);
  });

  fs.closeSync(fd);
  return { meta, format: ext, outputPath, coverPath };
}

module.exports = { decryptNcm, buildKeyBox, sniffImage };