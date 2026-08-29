'use strict';
/*
 * 合成样本自测：不依赖任何真实歌曲文件，全部样本由测试代码现场构造。
 * 覆盖：
 *   1. qmc v1 静态密钥往返（.qmcflac）
 *   2. qmc v1 强制回退（改名 .bin，无尾包，靠静态密钥试解识别）
 *   3. qmc v1 十六进制伪装扩展名（.666c6163 = flac）
 *   4. QTag 尾包 + 内嵌 ekey（RC4 模式）离线解密
 *   5. PcV1Legacy 尾包 + 内嵌 ekey（Map 模式）离线解密
 *   6. STag 尾包（无 ekey）→ 期望 NEED_EKEY
 *   7. kwm 1024 字节头剥离 + 32 字节循环异或密钥恢复
 *   8. zip store 结构逐字节校验（EOCD / 中央目录 / 本地头 / CRC / 文件名）
 *   9. RC4 段密钥边界：零字节种子与结果越界，密文由 Rust 语义参考实现生成
 *  10. EncV2 双阶段 ekey 解包并走完端到端
 *  11. ncm 密钥盒往返与封面字节提取（含 imageSpace / imageSize 两个长度字段）
 * 运行：node tests/selftest.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');
const {
  decryptQmc, probeQmc, qmc1Transform, parseEKey, deriveTeaKey, Qmc2, buildQmcRc4S,
  ENCV2_PREFIX, ENCV2_STAGE1_KEY, ENCV2_STAGE2_KEY,
} = require('../decryptor/qmc');
const { decryptKwm } = require('../decryptor/kwm');
const { decryptNcm, buildKeyBox } = require('../decryptor/ncm');
const {
  decryptKgmaFile, loadKeyTable, transformChunk, MAGIC, MEND, TAIL_NEW_KGMA, HEADER_LEN,
} = require('../decryptor/kugou');
const { buildZip, safeZipName, crc32OfChunk } = require('../lib/zipstore');

////////////////////////////////////////////////////////////
// 确定性伪随机（固定种子，失败可复现）
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pseudoBytes(len, seed) {
  const rnd = mulberry32(seed);
  const buf = Buffer.alloc(len);
  for (let i = 0; i < len; i++) buf[i] = (rnd() * 256) | 0;
  return buf;
}

////////////////////////////////////////////////////////////
// TC-TEA 加密（decryptor/qmc.js 里 teaDecrypt 的镜像，用于构造合法 ekey）
// 明文布局：[1 字节标志（低 3 位 = 垫长）][垫][2 字节盐][消息][7 字节零]
const TEA_DELTA = 0x9e3779b9n;
const M32 = 0xffffffffn;
function teaRound(v, sum, k1, k2) {
  const left = ((v << 4n) + k1) & M32;
  const right = ((v >> 5n) + k2) & M32;
  const mid = (sum + v) & M32;
  return (left ^ mid ^ right) & M32;
}
function teaEcbEncryptBlock(block, k) {
  let y = block >> 32n;
  let z = block & M32;
  let sum = 0n;
  for (let i = 0; i < 16; i++) {
    sum = (sum + TEA_DELTA) & M32;
    y = (y + teaRound(z, sum, k[0], k[1])) & M32;
    z = (z + teaRound(y, sum, k[2], k[3])) & M32;
  }
  return (y << 32n) | z;
}
function teaEncrypt(msg, key) {
  const total = msg.length + 10;
  const padded = total % 8 === 0 ? total : total + 8 - (total % 8);
  const pad = padded - total;
  const plain = Buffer.alloc(padded);
  plain[0] = 0x40 | pad;
  msg.copy(plain, 3 + pad);
  const k = [0, 1, 2, 3].map((i) => BigInt(key.readUInt32BE(i * 4)));
  const out = Buffer.alloc(padded);
  let iv1 = 0n, iv2 = 0n;
  for (let off = 0; off < padded; off += 8) {
    const p = plain.readBigUInt64BE(off);
    const toEnc = p ^ iv1;
    const c = teaEcbEncryptBlock(toEnc, k) ^ iv2;
    out.writeBigUInt64BE(c, off);
    iv1 = c;
    iv2 = toEnc;
  }
  return out;
}

// ncm 头部的 keyData 由 AES-128-ECB 加密后逐字节异或 0x64 得到，这里做加密方向用于构造样本
function aes128ecbEncrypt(key, data) {
  const enc = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([enc.update(data), enc.final()]);
}

// 构造可被 parseEKey 正常解析的 base64 ekey（非 EncV2 路径）
function makeEKey(keyBytes, seed) {
  const header = pseudoBytes(8, seed);
  const body = teaEncrypt(keyBytes, deriveTeaKey(header));
  const ekey = Buffer.concat([header, body]).toString('base64');
  const back = parseEKey(ekey);
  assert(back.equals(Buffer.concat([header, Buffer.from(keyBytes)])), 'ekey 构造自检失败');
  return ekey;
}

////////////////////////////////////////////////////////////
// RC4 参考实现：严格按 Rust 语义复刻，只用来构造密文
// 不能拿 Qmc2 自己加密再自己解密：RC4 是对称异或流，加解密共用同一份缺陷代码时
// 错误的密钥流会相互抵消，往返测试恒过。必须由独立参考实现产生密文才能暴露分叉。
// 分歧点集中在 calcSegmentKey 的 f64 → u32 转换：Rust 1.45 起是饱和转换
// （NaN 转 0，越过上界转 u32::MAX），JS 的 Math.trunc 没有这一层。
function refCalcSegmentKey(hash, id, seed) {
  const f = (hash / ((id + 1) * seed)) * 100.0;
  if (Number.isNaN(f)) return 0;
  if (f >= 0xffffffff) return 0xffffffff;
  if (f <= 0) return 0;
  return Math.trunc(f);
}
function refRc4Derive(n, s, st) {
  st.j = (st.j + 1) % n;
  st.k = (s[st.j] + st.k) % n;
  const t = s[st.j]; s[st.j] = s[st.k]; s[st.k] = t;
  return s[(s[st.j] + s[st.k]) % n];
}
function refSeg(offset, buf, start, count, n, key, hash, baseS) {
  const segId = (offset / 0x1400) | 0;
  let discard = refCalcSegmentKey(hash, segId, key[segId & 0x1ff]) & 0x1ff;
  discard += offset % 0x1400;
  const s = baseS.slice();
  const st = { j: 0, k: 0 };
  for (let d = 0; d < discard; d++) refRc4Derive(n, s, st);
  for (let k = 0; k < count; k++) buf[start + k] ^= refRc4Derive(n, s, st);
}
function refRc4Xor(key, buf) {
  const { n, hash, s: baseS } = buildQmcRc4S(key);
  let off = 0;
  let i = 0;
  let len = buf.length;
  if (off < 0x80) {
    const p = Math.min(len, 0x80 - off);
    for (let k = 0; k < p; k++) {
      const offk = off + k;
      buf[i + k] ^= key[refCalcSegmentKey(hash, offk, key[offk % n]) % n];
    }
    i += p; len -= p; off += p;
  }
  if (len <= 0) return;
  const toAlign = off % 0x1400;
  if (toAlign !== 0) {
    const p = Math.min(len, 0x1400 - toAlign);
    refSeg(off, buf, i, p, n, key, hash, baseS);
    i += p; len -= p; off += p;
  }
  while (len > 0x1400) {
    refSeg(off, buf, i, 0x1400, n, key, hash, baseS);
    i += 0x1400; len -= 0x1400; off += 0x1400;
  }
  if (len > 0) refSeg(off, buf, i, len, n, key, hash, baseS);
}

////////////////////////////////////////////////////////////
// 合成样本工具
function makeFlacAudio(len, seed) {
  return Buffer.concat([Buffer.from('fLaC', 'latin1'), pseudoBytes(len - 4, seed)]);
}
function be32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n, 0); return b; }
function le32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; }

// KGMA 的掩码变换，加解密不是同一个式子。
// xs 是半字节交换异或且为对合（xs(xs(x)) === x，已验证全部 256 个值）。
// 解密式为 p = xs(k ^ c) ^ msk，反解得到加密式 c = k ^ xs(p ^ msk)。
// 两者形式不同，拿 transformChunk 当加密用会构造出错的密文。
function kgmaXs(b) { return b ^ ((b & 0x0f) << 4); }
function kgmaEncrypt(buf, offset, ownKey, table) {
  const m = MEND.length;
  for (let i = 0; i < buf.length; i++) {
    const o = offset + i;
    const msk = kgmaXs(MEND[o % m] ^ table[o >>> 4]);
    buf[i] = ownKey[o % 17] ^ kgmaXs(buf[i] ^ msk);
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gan-jm-selftest-'));
let pass = 0, fail = 0;
async function runCase(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fail++;
    const msg = e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : String(e);
    console.error(`FAIL  ${name}\n      ${msg}`);
  }
}

(async () => {
  console.log(`自测临时目录：${TMP}\n`);

  // ---------- 1. qmc v1 静态密钥往返 ----------
  await runCase('qmc v1 往返（.qmcflac）', async () => {
    const audio = makeFlacAudio(64 * 1024 + 7, 1001);
    const enc = qmc1Transform(Buffer.from(audio), 0);
    assert(!enc.equals(audio), 'v1 加密后内容应发生变化');
    const p1 = path.join(TMP, 'song1.qmcflac');
    fs.writeFileSync(p1, enc);
    const probe = probeQmc(p1);
    assert(probe.type === 'v1', `probe 应判 v1，实际 ${probe.type}`);
    const o1 = path.join(TMP, 'song1.out.flac');
    const r1 = await decryptQmc(p1, o1, null, null, probe);
    assert(fs.readFileSync(o1).equals(audio), 'v1 解密输出与原文不一致');
    assert.strictEqual(r1.keySource, 'static');
    assert.strictEqual(r1.mode, 'v1-static');
    assert.strictEqual(r1.format, 'flac');
  });

  // ---------- 2. v1 强制回退（改名 .bin） ----------
  await runCase('qmc v1 强制回退（.bin 改名）', async () => {
    const audio = makeFlacAudio(8 * 1024, 1002);
    const enc = qmc1Transform(Buffer.from(audio), 0);
    const p2 = path.join(TMP, 'song2.bin');
    fs.writeFileSync(p2, enc);
    const probe = probeQmc(p2);
    assert(probe.type === 'v1' && probe.forced, '改名 v1 应走强制回退分支');
    const o2 = path.join(TMP, 'song2.out.flac');
    await decryptQmc(p2, o2, null, null, probe);
    assert(fs.readFileSync(o2).equals(audio), '强制回退解密输出不一致');
  });

  // ---------- 3. 十六进制伪装扩展名 ----------
  await runCase('qmc v1 十六进制伪装扩展名（.666c6163）', async () => {
    const audio = makeFlacAudio(4 * 1024, 1003);
    const enc = qmc1Transform(Buffer.from(audio), 0);
    const p3 = path.join(TMP, 'song3.666c6163');
    fs.writeFileSync(p3, enc);
    const probe = probeQmc(p3);
    assert(probe.type === 'v1', '伪装扩展名应命中 V1_EXTS');
    const o3 = path.join(TMP, 'song3.out.flac');
    await decryptQmc(p3, o3, null, null, probe);
    assert(fs.readFileSync(o3).equals(audio), '伪装扩展名解密输出不一致');
  });

  // ---------- 4. QTag + 内嵌 ekey（RC4） ----------
  await runCase('QTag 尾包内嵌 ekey（RC4 模式）', async () => {
    const keyBytes = pseudoBytes(320, 2001);
    const ekey = makeEKey(keyBytes, 2002);
    const cipher = new Qmc2(ekey);
    assert.strictEqual(cipher.mode, 'rc4', '320 字节钥匙应走 RC4');
    const audio = makeFlacAudio(9 * 1024, 2003);
    const encBody = Buffer.from(audio);
    cipher.decrypt(encBody, 0);
    const payload = Buffer.from(`${ekey},123,2`, 'latin1');
    const p4 = path.join(TMP, 'song4.mflac');
    fs.writeFileSync(p4, Buffer.concat([encBody, payload, be32(payload.length), Buffer.from('QTag', 'latin1')]));
    const o4 = path.join(TMP, 'song4.out.flac');
    const r4 = await decryptQmc(p4, o4, null);
    assert(fs.readFileSync(o4).equals(audio), 'QTag 离线解密输出不一致');
    assert.strictEqual(r4.footerKind, 'QTag');
    assert.strictEqual(r4.keySource, 'embedded');
    assert.strictEqual(r4.mode, 'rc4');
  });

  // ---------- 5. PcV1Legacy + 内嵌 ekey（Map） ----------
  await runCase('PcV1Legacy 尾包内嵌 ekey（Map 模式）', async () => {
    const keyBytes = pseudoBytes(24, 3001);
    const ekey = makeEKey(keyBytes, 3002);
    const cipher = new Qmc2(ekey);
    assert.strictEqual(cipher.mode, 'map', '短钥匙应走 Map');
    const audio = makeFlacAudio(3 * 1024 + 5, 3003);
    const encBody = Buffer.from(audio);
    cipher.decrypt(encBody, 0);
    const ekeyBuf = Buffer.from(ekey, 'latin1');
    const p5 = path.join(TMP, 'song5.mgg');
    fs.writeFileSync(p5, Buffer.concat([encBody, ekeyBuf, le32(ekeyBuf.length)]));
    const o5 = path.join(TMP, 'song5.out.flac');
    const r5 = await decryptQmc(p5, o5, null);
    assert(fs.readFileSync(o5).equals(audio), 'PcV1Legacy 离线解密输出不一致');
    assert.strictEqual(r5.footerKind, 'PcV1Legacy');
    assert.strictEqual(r5.keySource, 'embedded');
    assert.strictEqual(r5.mode, 'map');
  });

  // ---------- 6. STag 无 ekey → NEED_EKEY ----------
  await runCase('STag 尾包无 ekey → NEED_EKEY', async () => {
    const ekey = makeEKey(pseudoBytes(24, 4001), 4002);
    const cipher = new Qmc2(ekey);
    const audio = makeFlacAudio(2 * 1024, 4003);
    const encBody = Buffer.from(audio);
    cipher.decrypt(encBody, 0);
    const payload = Buffer.from('123456,2,320', 'latin1');
    const p6 = path.join(TMP, 'song6.mflac');
    fs.writeFileSync(p6, Buffer.concat([encBody, payload, be32(payload.length), Buffer.from('STag', 'latin1')]));
    let caught = null;
    try { await decryptQmc(p6, path.join(TMP, 'song6.out.flac'), null); } catch (e) { caught = e; }
    assert(caught, 'STag 无钥匙应抛错');
    assert.strictEqual(caught.code, 'NEED_EKEY', `错误码应为 NEED_EKEY，实际 ${caught.code}`);
    assert.strictEqual(caught.footerKind, 'STag');
  });

  // ---------- 7. kwm 密钥恢复 ----------
  await runCase('kwm 1024 头剥离 + 密钥恢复', async () => {
    const key = pseudoBytes(32, 5001);
    const body = Buffer.alloc(8192);
    // 前 64 字节全零 → 密文中出现相邻相同块，触发恢复第一策略
    Buffer.from('ID3', 'latin1').copy(body, 64);
    body.set(pseudoBytes(8125, 5002), 67);
    const encBody = Buffer.from(body);
    for (let i = 0; i < encBody.length; i++) encBody[i] ^= key[i & 31];
    const header = pseudoBytes(1024, 5003);
    const p7 = path.join(TMP, 'song7.kwm');
    fs.writeFileSync(p7, Buffer.concat([header, encBody]));
    const o7 = path.join(TMP, 'song7.out.mp3');
    const r7 = await decryptKwm(p7, o7, null);
    assert(fs.readFileSync(o7).equals(body), 'kwm 解密输出与原文不一致');
    assert.strictEqual(r7.format, 'mp3');
    assert.strictEqual(r7.keySource, 'kwm-recovered');
  });

  // ---------- 8. zip 结构逐字节校验 ----------
  await runCase('zip store 结构（EOCD/中央目录/本地头/CRC）', async () => {
    const zdir = path.join(TMP, 'zipsrc');
    fs.mkdirSync(zdir, { recursive: true });
    const files = [
      { name: 'a.txt', data: Buffer.from('hello zip 测试', 'utf8') },
      { name: 'b.flac', data: pseudoBytes(5000, 6001) },
      { name: '歌手/中文名.flac', data: makeFlacAudio(2000, 6002) },
    ];
    const entries = files.map((f) => {
      const fp = path.join(zdir, ...f.name.split('/'));
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, f.data);
      return { name: safeZipName(f.name), path: fp };
    });
    const zipPath = path.join(TMP, 'out.zip');
    const { size, count } = await buildZip(zipPath, entries);
    const z = fs.readFileSync(zipPath);
    assert.strictEqual(z.length, size, '返回大小与实际不一致');
    assert.strictEqual(count, files.length);
    // EOCD
    assert.strictEqual(z.readUInt32LE(z.length - 22), 0x06054b50, 'EOCD 签名');
    assert.strictEqual(z.readUInt16LE(z.length - 22 + 10), files.length, 'EOCD 条目数');
    const cdStart = z.readUInt32LE(z.length - 22 + 16);
    const cdSize = z.readUInt32LE(z.length - 22 + 12);
    assert.strictEqual(cdStart + cdSize + 22, z.length, 'EOCD 偏移自洽');
    // 中央目录逐条
    let off = cdStart;
    for (const f of files) {
      assert.strictEqual(z.readUInt32LE(off), 0x02014b50, '中央目录签名');
      assert.strictEqual(z.readUInt16LE(off + 10), 0, '应为 store 模式');
      const crc = z.readUInt32LE(off + 16);
      const sz = z.readUInt32LE(off + 20);
      const nameLen = z.readUInt16LE(off + 28);
      const name = z.subarray(off + 46, off + 46 + nameLen).toString('utf8');
      assert.strictEqual(name, safeZipName(f.name), `文件名不符：${name}`);
      assert.strictEqual(sz, f.data.length, `尺寸不符：${name}`);
      const localOff = z.readUInt32LE(off + 42);
      assert.strictEqual(z.readUInt32LE(localOff), 0x04034b50, '本地头签名');
      const localNameLen = z.readUInt16LE(localOff + 26);
      const dataStart = localOff + 30 + localNameLen;
      const data = z.subarray(dataStart, dataStart + sz);
      assert(data.equals(f.data), `数据内容不符：${name}`);
      const crcCalc = (crc32OfChunk(0xffffffff, data) ^ 0xffffffff) >>> 0;
      assert.strictEqual(crcCalc, crc, `CRC 不符：${name}`);
      off += 46 + nameLen;
    }
    assert.strictEqual(off, cdStart + cdSize, '中央目录总长自洽');
    // safeZipName 防路径逃逸
    assert.strictEqual(safeZipName('..\\..\\evil.mp3'), 'evil.mp3');
    assert.strictEqual(safeZipName('/a//b/./c.mp3'), 'a/b/c.mp3');
  });

  // ---------- 9. RC4 段密钥边界：含零字节密钥 + 跨多段 ----------
  // calcSegmentKey 的 divisor 由密钥字节 seed 参与，两类输入会让 JS 与 Rust 分叉：
  //   seed 为 0 → f64 除零；seed 偏小 → hash*100/divisor 越过 u32 上界。
  // 固定种子的随机密钥命中不了这两处（RC4 用例 4 即如此），这里显式埋值。
  // 密文由 refRc4Xor 按 Rust 语义生成，被测代码若分叉则密钥流对不上，输出必然不同。
  await runCase('RC4 段密钥边界（零字节种子 + 结果越界，对照 Rust 语义）', async () => {
    const keyBytes = pseudoBytes(400, 7001);
    // parseEKey 会在 keyBytes 前拼 8 字节 header，故 keyBytes[i] 对应最终 key[i + 8]。
    // key[8] = 0 命中除零；key[9] = 1 命中越界（divisor = 10*1，结果约 3e10）；
    // key[10] = 2 同样越界；key[23] = 0 再补一处除零。
    keyBytes[0] = 0; keyBytes[1] = 1; keyBytes[2] = 2; keyBytes[15] = 0;
    const ekey = makeEKey(keyBytes, 7002);
    const key = parseEKey(ekey);
    assert.strictEqual(key.length, 408, '最终密钥应为 8 字节头 + 400 字节体');
    const cipher = new Qmc2(ekey);
    assert.strictEqual(cipher.mode, 'rc4', '408 字节钥匙应走 RC4');

    // 长度跨 26 个 OTHER_SEG 段：segId 0..25，segId & 0x1ff 恰好覆盖到 key[23]，
    // 首段 128 字节也会采样到 key[8..10]。两类分叉都被走到。
    const audio = makeFlacAudio(26 * 0x1400 + 777, 7003);
    const encBody = Buffer.from(audio);
    refRc4Xor(key, encBody);
    assert(!encBody.equals(audio), '参考实现加密后内容应发生变化');

    const payload = Buffer.from(`${ekey},123,2`, 'latin1');
    const p9 = path.join(TMP, 'song9.mflac');
    fs.writeFileSync(p9, Buffer.concat([encBody, payload, be32(payload.length), Buffer.from('QTag', 'latin1')]));
    const o9 = path.join(TMP, 'song9.out.flac');
    const r9 = await decryptQmc(p9, o9, null);
    assert(fs.readFileSync(o9).equals(audio), 'RC4 段密钥边界下解密输出与原文不一致');
    assert.strictEqual(r9.mode, 'rc4');
    assert.strictEqual(r9.keySource, 'embedded');
  });

  // ---------- 10. EncV2 双阶段取钥 ----------
  // MusicEx 路径的 ekey 长这样：先用 stage2 密钥 TEA 加密内层 base64，整块再用 stage1 加密一次。
  // 这条路径此前没有任何用例覆盖，属于 HANDOFF 记录的盲区之一。
  await runCase('EncV2 双阶段 ekey 解包 + 端到端（RC4）', async () => {
    const keyBytes = pseudoBytes(320, 8001);
    const header = pseudoBytes(8, 8002);
    const body = teaEncrypt(keyBytes, deriveTeaKey(header));
    const innerB64 = Buffer.concat([header, body]).toString('base64');
    // 包装方向与 parseEKey 的解包方向严格相反
    const s2 = teaEncrypt(Buffer.from(innerB64, 'latin1'), ENCV2_STAGE2_KEY);
    const s1 = teaEncrypt(s2, ENCV2_STAGE1_KEY);
    const ekey = Buffer.concat([ENCV2_PREFIX, s1]).toString('base64');

    const parsed = parseEKey(ekey);
    assert(parsed.equals(Buffer.concat([header, keyBytes])), 'EncV2 解包结果与内层密钥不一致');
    const cipher = new Qmc2(ekey);
    assert.strictEqual(cipher.mode, 'rc4', '320 字节钥匙应走 RC4');

    const audio = makeFlacAudio(2 * 0x1400 + 33, 8003);
    const encBody = Buffer.from(audio);
    refRc4Xor(parsed, encBody);
    const payload = Buffer.from(`${ekey},123,2`, 'latin1');
    const p10 = path.join(TMP, 'song10.mflac');
    fs.writeFileSync(p10, Buffer.concat([encBody, payload, be32(payload.length), Buffer.from('QTag', 'latin1')]));
    const o10 = path.join(TMP, 'song10.out.flac');
    const r10 = await decryptQmc(p10, o10, null);
    assert(fs.readFileSync(o10).equals(audio), 'EncV2 端到端解密输出不一致');
    assert.strictEqual(r10.mode, 'rc4');
  });

  // ---------- 11. ncm 密钥盒往返 + 封面提取 ----------
  // 封面区两个长度字段（imageSpace / imageSize）此前没有回归证据，这里按 ncmcrypt 布局构造样本验证。
  await runCase('ncm 密钥盒往返 + 封面字节提取', async () => {
    const CORE_KEY = Buffer.from('hzHRAmso5kInbaxW', 'latin1');
    const KEY_PREFIX = Buffer.from('neteasecloudmusic', 'ascii');
    const keyMaterial = pseudoBytes(16, 9001);
    const keyBox = buildKeyBox(keyMaterial);

    const encKeyData = aes128ecbEncrypt(CORE_KEY, Buffer.concat([KEY_PREFIX, keyMaterial]));
    const keyData = Buffer.from(encKeyData.map((b) => b ^ 0x64));

    const audio = makeFlacAudio(32 * 1024 + 5, 9002);
    const encAudio = Buffer.from(audio);
    for (let i = 0; i < encAudio.length; i++) {
      const j = (i + 1) & 0xff;
      const a = keyBox[j];
      const b = keyBox[(a + j) & 0xff];
      encAudio[i] ^= keyBox[(a + b) & 0xff];
    }
    assert(!encAudio.equals(audio), 'ncm 加密后内容应发生变化');

    // 封面用 JPEG 魔数开头，便于 sniffImage 识别
    const cover = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), pseudoBytes(4096 - 4, 9003)]);
    const head = Buffer.concat([
      Buffer.from('CTENFDAM', 'ascii'),
      Buffer.alloc(2),
      le32(keyData.length),
      keyData,
      le32(0), // metaLen 取 0，简化样本
      Buffer.alloc(5), // CRC32 + 图片版本
      le32(cover.length),
      le32(cover.length),
    ]);
    const p11 = path.join(TMP, 'song11.ncm');
    fs.writeFileSync(p11, Buffer.concat([head, cover, encAudio]));

    const o11 = path.join(TMP, 'song11.out');
    const r11 = await decryptNcm(p11, o11, null, { coverPath: path.join(TMP, 'song11.cover') });
    assert.strictEqual(r11.format, 'flac', 'ncm 应识别为 flac');
    assert(fs.readFileSync(o11).equals(audio), 'ncm 解密输出与原文不一致');
    assert(r11.coverPath && fs.existsSync(r11.coverPath), '未提取出封面文件');
    assert(fs.readFileSync(r11.coverPath).equals(cover), '封面字节与内嵌内容不一致');
  });

  // ---------- 12. KGMA 流式解密 ----------
  // 改造前是整文件入内存再复制一份缓冲，这里验证改成分块后结果不变。
  // 掩码偏移按相对音频起点的绝对位置取模，分块边界处理错了就会在这里暴露，
  // 所以样本长度特意跨过 4MB 分块线。
  const kgmaKeyTable = path.join(__dirname, '..', 'native', 'kugou', 'kugou_key.bin');
  if (fs.existsSync(kgmaKeyTable)) {
    await runCase('KGMA 流式解密（跨 4MB 分块，对照整块参考）', async () => {
      const table = loadKeyTable();
      const key16 = pseudoBytes(16, 10001);
      const ownKey = Buffer.alloc(17); // 第 17 字节恒为 0
      key16.copy(ownKey, 0);

      const head = Buffer.alloc(HEADER_LEN);
      Buffer.from(MAGIC).copy(head, 0);
      Buffer.from(TAIL_NEW_KGMA).copy(head, 20);
      key16.copy(head, 0x1c);

      const audio = makeFlacAudio(4 * 1024 * 1024 + 1024, 10002);
      const encBody = Buffer.from(audio);
      kgmaEncrypt(encBody, 0, ownKey, table);
      assert(!encBody.equals(audio), 'KGMA 加密后内容应发生变化');

      const p12 = path.join(TMP, 'song12.kgma');
      fs.writeFileSync(p12, Buffer.concat([head, encBody]));
      const o12 = path.join(TMP, 'song12.out');
      const r12 = await decryptKgmaFile(p12, o12);
      assert.strictEqual(r12.ext, 'flac', 'KGMA 应识别为 flac');
      const got = fs.readFileSync(r12.outputPath);
      assert(got.equals(audio), `KGMA 流式解密输出不一致（${got.length} vs ${audio.length}）`);
    });
  } else {
    console.log('SKIP  KGMA 用例（缺少 native/kugou/kugou_key.bin）');
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail) {
    console.error(`失败样本保留在 ${TMP} 供排查`);
    process.exitCode = 1;
  } else {
    fs.rmSync(TMP, { recursive: true, force: true });
  }
})();
