'use strict';
// 零依赖 ZIP 打包（store 模式，不压缩）
// 音频（flac/mp3/ogg/m4a）本身已压缩，再压缩无收益，store 模式 CPU 零成本。
// 结构：local file header + 数据 + central directory + EOCD，文件名 UTF-8（flag bit 11）。
const fs = require('fs');
const path = require('path');

// CRC32 查表
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32OfChunk(crc, chunk) {
  let c = crc;
  for (let i = 0; i < chunk.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ chunk[i]) & 0xff];
  return c >>> 0;
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

// 流式拷贝文件数据到 zip 当前位置，边拷边算 CRC32
function copyComputingCrc(fd, filePath, outOffset) {
  return new Promise((resolve, reject) => {
    const rs = fs.createReadStream(filePath, { highWaterMark: 512 * 1024 });
    let crc = 0xffffffff;
    let pos = outOffset;
    rs.on('data', (chunk) => {
      rs.pause();
      crc = crc32OfChunk(crc, chunk);
      fs.write(fd, chunk, 0, chunk.length, pos, (err) => {
        if (err) { rs.destroy(); reject(err); return; }
        pos += chunk.length;
        rs.resume();
      });
    });
    rs.on('error', reject);
    rs.on('end', () => resolve((crc ^ 0xffffffff) >>> 0));
  });
}

// entries: [{ name: 'zip 内路径', path: '本地绝对路径' }]
async function buildZip(outputPath, entries) {
  if (entries.length > 65535) throw new Error('打包文件数超出 zip 上限（65535）');
  const fd = fs.openSync(outputPath, 'w');
  let pos = 0;
  const central = [];
  const now = dosDateTime(new Date());

  try {
    for (const ent of entries) {
      const stat = fs.statSync(ent.path);
      if (stat.size > 0xffffffff) throw new Error(`文件过大无法打包：${ent.name}`);
      const nameBuf = Buffer.from(ent.name, 'utf8');
      const headerOffset = pos;

      const header = Buffer.alloc(30 + nameBuf.length);
      header.writeUInt32LE(0x04034b50, 0);      // local file header 签名
      header.writeUInt16LE(20, 4);              // version needed
      header.writeUInt16LE(0x0800, 6);          // flag bit 11：UTF-8 文件名
      header.writeUInt16LE(0, 8);               // method = store
      header.writeUInt16LE(now.time, 10);
      header.writeUInt16LE(now.date, 12);
      header.writeUInt32LE(0, 14);              // crc 占位，流式拷贝后回填
      header.writeUInt32LE(stat.size, 18);      // compressed size
      header.writeUInt32LE(stat.size, 22);      // uncompressed size
      header.writeUInt16LE(nameBuf.length, 26);
      header.writeUInt16LE(0, 28);              // extra len
      nameBuf.copy(header, 30);
      fs.writeSync(fd, header, 0, header.length, pos);
      pos += header.length;

      const crc = await copyComputingCrc(fd, ent.path, pos);
      pos += stat.size;

      const crcBuf = Buffer.alloc(4);
      crcBuf.writeUInt32LE(crc, 0);
      fs.writeSync(fd, crcBuf, 0, 4, headerOffset + 14);

      central.push({ nameBuf, size: stat.size, crc, offset: headerOffset });
    }

    // central directory
    const cdStart = pos;
    for (const ent of central) {
      const rec = Buffer.alloc(46 + ent.nameBuf.length);
      rec.writeUInt32LE(0x02014b50, 0);
      rec.writeUInt16LE(20, 4);                 // version made by
      rec.writeUInt16LE(20, 6);                 // version needed
      rec.writeUInt16LE(0x0800, 8);             // UTF-8 flag
      rec.writeUInt16LE(0, 10);                 // method = store
      rec.writeUInt16LE(now.time, 12);
      rec.writeUInt16LE(now.date, 14);
      rec.writeUInt32LE(ent.crc, 16);
      rec.writeUInt32LE(ent.size, 20);
      rec.writeUInt32LE(ent.size, 24);
      rec.writeUInt16LE(ent.nameBuf.length, 28);
      rec.writeUInt16LE(0, 30);                 // extra len
      rec.writeUInt16LE(0, 32);                 // comment len
      rec.writeUInt16LE(0, 34);                 // disk number start
      rec.writeUInt16LE(0, 36);                 // internal attrs
      rec.writeUInt32LE(0, 38);                 // external attrs
      rec.writeUInt32LE(ent.offset, 42);
      ent.nameBuf.copy(rec, 46);
      fs.writeSync(fd, rec, 0, rec.length, pos);
      pos += rec.length;
    }
    const cdSize = pos - cdStart;

    // EOCD
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    fs.writeSync(fd, eocd, 0, 22, pos);
    pos += 22;
  } finally {
    fs.closeSync(fd);
  }
  return { size: pos, count: central.length };
}

// 规范化 zip 内路径（统一 posix 分隔符，拒绝 .. 逃逸）
function safeZipName(name) {
  const normalized = name.replace(/\\/g, '/').replace(/\/+/g, '/');
  const parts = normalized.split('/').filter((p) => p && p !== '.' && p !== '..');
  return parts.join('/');
}

module.exports = { buildZip, safeZipName, crc32OfChunk };
