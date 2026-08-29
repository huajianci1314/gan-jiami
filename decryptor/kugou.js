'use strict';
// 酷狗加密解密模块
// - KGMA(新版 KGM 容器): 纯 JS 移植版逐字节解密, 无需任何外部密钥
//   算法来源 ghtz08/kugou-kgm-decoder (src/decoder/kugou.rs), 已用其自带测试向量做过字节级校验
// - KGG: 调用本机 native/kgg-dec/kgg-dec.exe, 密钥取自酷狗客户端本地密钥库
//   (%AppData%/Kugou8/KGMusicV3.db); 前提是该歌曲在本机酷狗里播放过至少一次

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HEADER_LEN = 1024;

// 共享容器魔数 16 字节(kgm/kgma/kmm/vpr 家族)
const MAGIC = Buffer.from([
  0x7C, 0xD5, 0x32, 0xEB, 0x86, 0x02, 0x7F, 0x4B,
  0xA8, 0xAF, 0xA6, 0x8E, 0x0F, 0xFF, 0x99, 0x14,
]);

// 新版 KGMA 头部 20..27 固定为 03 00 00 00 01 00 00 00
// KGG 同位置为 05 00 00 00 FF FF FF FF
const TAIL_NEW_KGMA = Buffer.from([0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00]);
const TAIL_KGG = Buffer.from([0x05, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0xFF]);

// 公共掩码短表(272 字节, 原样转录自 kugou.rs 的 PUB_KEY_MEND)
const MEND = [
  0xB8, 0xD5, 0x3D, 0xB2, 0xE9, 0xAF, 0x78, 0x8C, 0x83, 0x33, 0x71, 0x51, 0x76, 0xA0,
  0xCD, 0x37, 0x2F, 0x3E, 0x35, 0x8D, 0xA9, 0xBE, 0x98, 0xB7, 0xE7, 0x8C, 0x22, 0xCE,
  0x5A, 0x61, 0xDF, 0x68, 0x69, 0x89, 0xFE, 0xA5, 0xB6, 0xDE, 0xA9, 0x77, 0xFC, 0xC8,
  0xBD, 0xBD, 0xE5, 0x6D, 0x3E, 0x5A, 0x36, 0xEF, 0x69, 0x4E, 0xBE, 0xE1, 0xE9, 0x66,
  0x1C, 0xF3, 0xD9, 0x02, 0xB6, 0xF2, 0x12, 0x9B, 0x44, 0xD0, 0x6F, 0xB9, 0x35, 0x89,
  0xB6, 0x46, 0x6D, 0x73, 0x82, 0x06, 0x69, 0xC1, 0xED, 0xD7, 0x85, 0xC2, 0x30, 0xDF,
  0xA2, 0x62, 0xBE, 0x79, 0x2D, 0x62, 0x62, 0x3D, 0x0D, 0x7E, 0xBE, 0x48, 0x89, 0x23,
  0x02, 0xA0, 0xE4, 0xD5, 0x75, 0x51, 0x32, 0x02, 0x53, 0xFD, 0x16, 0x3A, 0x21, 0x3B,
  0x16, 0x0F, 0xC3, 0xB2, 0xBB, 0xB3, 0xE2, 0xBA, 0x3A, 0x3D, 0x13, 0xEC, 0xF6, 0x01,
  0x45, 0x84, 0xA5, 0x70, 0x0F, 0x93, 0x49, 0x0C, 0x64, 0xCD, 0x31, 0xD5, 0xCC, 0x4C,
  0x07, 0x01, 0x9E, 0x00, 0x1A, 0x23, 0x90, 0xBF, 0x88, 0x1E, 0x3B, 0xAB, 0xA6, 0x3E,
  0xC4, 0x73, 0x47, 0x10, 0x7E, 0x3B, 0x5E, 0xBC, 0xE3, 0x00, 0x84, 0xFF, 0x09, 0xD4,
  0xE0, 0x89, 0x0F, 0x5B, 0x58, 0x70, 0x4F, 0xFB, 0x65, 0xD8, 0x5C, 0x53, 0x1B, 0xD3,
  0xC8, 0xC6, 0xBF, 0xEF, 0x98, 0xB0, 0x50, 0x4F, 0x0F, 0xEA, 0xE5, 0x83, 0x58, 0x8C,
  0x28, 0x2C, 0x84, 0x67, 0xCD, 0xD0, 0x9E, 0x47, 0xDB, 0x27, 0x50, 0xCA, 0xF4, 0x63,
  0x63, 0xE8, 0x97, 0x7F, 0x1B, 0x4B, 0x0C, 0xC2, 0xC1, 0x21, 0x4C, 0xCC, 0x58, 0xF5,
  0x94, 0x52, 0xA3, 0xF3, 0xD3, 0xE0, 0x68, 0xF4, 0x00, 0x23, 0xF3, 0x5E, 0x0A, 0x7B,
  0x93, 0xDD, 0xAB, 0x12, 0xB2, 0x13, 0xE8, 0x84, 0xD7, 0xA7, 0x9F, 0x0F, 0x32, 0x4C,
  0x55, 0x1D, 0x04, 0x36, 0x52, 0xDC, 0x03, 0xF3, 0xF9, 0x4E, 0x42, 0xE9, 0x3D, 0x61,
  0xEF, 0x7C, 0xB6, 0xB3, 0x93, 0x50,
];

const KEY_TABLE_PATH = path.join(__dirname, '..', 'native', 'kugou', 'kugou_key.bin');
const KGG_DEC_EXE = path.join(__dirname, '..', 'native', 'kgg-dec', 'kgg-dec.exe');

// 公开密钥大表约 70MB, 惰性加载一次常驻内存
let _table = null;
function loadKeyTable() {
  if (_table) return _table;
  if (!fs.existsSync(KEY_TABLE_PATH)) {
    throw new Error('缺少酷狗公共密钥表 native/kugou/kugou_key.bin');
  }
  _table = fs.readFileSync(KEY_TABLE_PATH);
  return _table;
}

function xorShift(b) {
  // b ^= (b & 0x0f) << 4
  return b ^ ((b & 0x0f) << 4);
}

// 读头分类: 返回 'kgma' | 'kgg' | 'other'; buf 至少 28 字节
function classifyHead(buf) {
  if (!buf || buf.length < 28) return 'other';
  if (!buf.subarray(0, 16).equals(MAGIC)) return 'other';
  const tail = buf.subarray(20, 28);
  if (tail.equals(TAIL_NEW_KGMA)) return 'kgma';
  if (tail.equals(TAIL_KGG)) return 'kgg';
  return 'other';
}

function sniffAudioExt(buf) {
  if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'fLaC') return 'flac';
  if (buf.length >= 3 && buf.subarray(0, 3).toString('ascii') === 'ID3') return 'mp3';
  if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'OggS') return 'ogg';
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3';
  if (buf.length >= 12 && buf.subarray(4, 8).toString('ascii') === 'ftyp') return 'm4a';
  if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'RIFF') return 'wav';
  return null;
}

// 逐块还原。offset 是相对音频起点的绝对偏移，掩码表与内部密钥都按它取模，
// 因此分块处理结果必须与整块处理逐字节一致。
function transformChunk(buf, offset, ownKey, table) {
  const n = buf.length;
  const m = MEND.length;
  for (let i = 0; i < n; i++) {
    const o = offset + i;
    const med = xorShift(ownKey[o % 17] ^ buf[i]);
    const msk = xorShift(MEND[o % m] ^ table[o >>> 4]);
    buf[i] = med ^ msk;
  }
}

// 读头部判定容器类型并抽出内部密钥，顺带解出真实音频格式
// 只读 1024 字节头加 4096 字节探测区，不载入整文件
function probeKgmaHead(fd, size) {
  const head = Buffer.alloc(HEADER_LEN);
  fs.readSync(fd, head, 0, HEADER_LEN, 0);
  const kind = classifyHead(head);
  if (kind !== 'kgma') {
    throw new Error(kind === 'kgg'
      ? '该文件实为 KGG 容器，请以 .kgg 方式处理'
      : '不是支持的新版酷狗 KGMA 文件');
  }
  if (size <= HEADER_LEN) throw new Error('KGMA 文件头不完整');

  const ownKey = Buffer.alloc(17);
  head.copy(ownKey, 0, 0x1c, 0x2c); // 16 字节内部密钥, 第 17 字节恒为 0

  const probeLen = Math.min(4096, size - HEADER_LEN);
  const probe = Buffer.alloc(probeLen);
  fs.readSync(fd, probe, 0, probeLen, HEADER_LEN);
  transformChunk(probe, 0, ownKey, loadKeyTable());
  return { ownKey, ext: sniffAudioExt(probe) || 'bin' };
}

function resolveOutputPath(inputPath, outputPath, ext) {
  if (outputPath === null || outputPath === undefined) {
    return inputPath.slice(0, -path.extname(inputPath).length) + '.' + ext;
  }
  return path.extname(outputPath) === '' ? outputPath + '.' + ext : outputPath;
}

// KGMA 解密：流式读写，返回 Promise<{ outputPath, ext }>
// 原实现整文件入内存再复制一份缓冲，192kHz Hi-Res 曲目峰值可达文件体积的三倍加 70MB 公钥表。
// 改为定长分块后内存占用与文件大小脱钩，固定在一个块。
function decryptKgmaFile(filePath, outputPath) {
  const size = fs.statSync(filePath).size;
  const fd = fs.openSync(filePath, 'r');
  let ownKey, ext;
  try {
    ({ ownKey, ext } = probeKgmaHead(fd, size));
  } finally {
    fs.closeSync(fd);
  }

  const finalPath = resolveOutputPath(filePath, outputPath, ext);
  const table = loadKeyTable();
  const CHUNK = 4 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    const rs = fs.createReadStream(filePath, { start: HEADER_LEN, highWaterMark: CHUNK });
    const ws = fs.createWriteStream(finalPath);
    let offset = 0;
    rs.on('data', (chunk) => {
      const b = Buffer.from(chunk);
      transformChunk(b, offset, ownKey, table);
      offset += b.length;
      // 背压：写缓冲满时暂停读取，避免块在内存里堆积
      if (!ws.write(b)) {
        rs.pause();
        ws.once('drain', () => rs.resume());
      }
    });
    // 任一侧出错都要把另一侧一并销毁，否则会留下未关闭的 fd
    const fail = (e) => { rs.destroy(); ws.destroy(); reject(e); };
    rs.on('end', () => ws.end());
    rs.on('error', fail);
    ws.on('error', fail);
    ws.on('finish', () => resolve({ outputPath: finalPath, ext }));
  });
}

// 定位本机酷狗密钥库
function findKggDb() {
  const cand = [];
  if (process.env.APPDATA) cand.push(path.join(process.env.APPDATA, 'Kugou8', 'KGMusicV3.db'));
  if (process.env.LOCALAPPDATA) cand.push(path.join(process.env.LOCALAPPDATA, 'KGMusic', 'KGMusicV3.db'));
  for (const p of cand) {
    try { if (fs.statSync(p).isFile()) return p; } catch (_) {}
  }
  return null;
}

// KGG: 调用本机 kgg-dec.exe 解密。实测 v0.6.1 有两个硬性约束:
//   1. 参数解析要求以 `--` 分隔选项与待处理文件, 缺了它一律打印 Usage 直接拒绝;
//   2. 产物名 = 输入名 + "_kgg-dec" 后缀, 落在输入所在目录。
// 因此每次调用都开独立运行目录, 输入统一改名 in.kgg 再执行(相对路径 + ASCII 名,
// 规避中文用户目录进 argv 的隐患), 目录里除输入外的唯一文件即产物。
// 返回 Promise<{ outputPath, ext }>
function decryptKggFile(filePath, tmpDir) {
  return new Promise((resolve, reject) => {
    const db = findKggDb();
    if (!db) {
      return reject(new Error('未找到本机酷狗密钥库(KGMusicV3.db)，请先安装并登录酷狗音乐'));
    }
    const runDir = fs.mkdtempSync(path.join(tmpDir, 'kggrun-'));
    const inner = path.join(runDir, 'in.kgg');
    try {
      fs.renameSync(filePath, inner); // 同盘移动, 近零开销; 原 uploaded 文件随之消失
      let stdoutBuf = '';
      try {
        const { stdout } = execFileSync(KGG_DEC_EXE, ['--db', db, '--', 'in.kgg'],
          { cwd: runDir, timeout: 15 * 60 * 1000, encoding: 'utf8' }) || {};
        stdoutBuf = String(stdout || '');
      } catch (runErr) {
        stdoutBuf = String((runErr && (runErr.stderr || runErr.stdout)) || '') + String(runErr.message || '');
      }
      const outName = fs.readdirSync(runDir).find((f) => f !== 'in.kgg');
      if (!outName) {
        const tail = stdoutBuf.trim().split(/\r?\n/).filter(Boolean).pop() || 'kgg-dec 未产生输出';
        throw new Error('KGG 解密失败：' + tail +
          '。请确认这首歌已在本机酷狗客户端中完整播放过一次(密钥才会写入本地密钥库)');
      }
      const produced = path.join(runDir, outName);
      const head = Buffer.alloc(4);
      const fd = fs.openSync(produced, 'r');
      fs.readSync(fd, head, 0, 4, 0);
      fs.closeSync(fd);
      resolve({ outputPath: produced, ext: sniffAudioExt(head) || 'flac' });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

// 后几项供测试构造样本用：掩码变换是自身可逆的，测试用同一函数生成密文
module.exports = {
  classifyHead, decryptKgmaFile, decryptKggFile, sniffAudioExt,
  MAGIC, MEND, TAIL_NEW_KGMA, HEADER_LEN, loadKeyTable, transformChunk,
};
