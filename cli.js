'use strict';
// 统一解密 CLI：自动识别 .ncm / .mflac 格式并解密
// 用法:
//   node cli.js <input> [output] [--ekey <QQ音乐ekey>]
const fs = require('fs');
const path = require('path');
const { decryptNcm } = require('./decryptor/ncm');
const { decryptQmc, parseMusicex } = require('./decryptor/qmc');
const { fetchEkey } = require('./decryptor/ekey_fetch');

function detectFormat(p) {
  const fd = fs.openSync(p, 'r');
  const head = Buffer.alloc(8);
  fs.readSync(fd, head, 0, 8, 0);
  fs.closeSync(fd);
  if (head.subarray(0, 8).toString('ascii') === 'CTENFDAM') return 'ncm';
  return 'mflac';
}

async function main() {
  const args = process.argv.slice(2);
  const idx = args.findIndex((a) => a === '--ekey');
  let ekey = null;
  if (idx !== -1) {
    ekey = args[idx + 1];
    args.splice(idx, 2);
  }
  const [input, output] = args;
  if (!input) {
    console.log('用法: node cli.js <输入文件> [输出文件] [--ekey <QQ音乐ekey>]');
    process.exit(1);
  }
  const fmt = detectFormat(input);
  console.log('检测格式:', fmt === 'ncm' ? '.ncm 网易云 ' : '.mflac QQ音乐 musicex');
  const onProgress = (r) => {
    process.stderr.write(`\r进度 ${Math.round(r * 100)}%`);
  };

  if (fmt === 'ncm') {
    const res = await decryptNcm(input, output || null, onProgress);
    process.stderr.write('\n');
    console.log('解密完成 ->', res.outputPath, '格式:', res.format);
    console.log('元数据:', res.meta ? JSON.stringify(res.meta) : '无');
  } else {
    const info = parseMusicex(input);
    if (!ekey) {
      console.log('该文件是 QQ音乐 musicex 格式，页脚不内嵌密钥，正在自动获取 ekey...');
      ekey = await fetchEkey(info);
      if (ekey) {
        console.log('自动获取 ekey 成功。');
      } else {
        console.log('自动获取失败（请确认 QQ音乐 已登录并保持运行），歌曲ID:', info.songId, '| media_mid:', info.mediaMid);
        console.log('请通过 --ekey <ekey> 传入密钥。');
        process.exit(2);
      }
    }
    const res = await decryptQmc(input, output || null, ekey, onProgress);
    process.stderr.write('\n');
    console.log('解密完成 ->', res.outputPath, '格式:', res.format, '| 密钥长度:', res.keyLength, '| 模式:', res.mode);
  }
}

main().catch((e) => {
  console.error('\n解密失败:', e.message);
  process.exit(1);
});