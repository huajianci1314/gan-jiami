'use strict';
// ekey 取钥小工具：给一个 mflac/mgg 文件（或手填 songmid + filename），直接把钥匙打印出来。
// 存在的意义是手动补录：网页端自动取钥失败时，用它可以离线核对到底是凭证失效、档位不匹配，还是文件本身没带定位信息。
const fs = require('fs');
const { probeQmc, decryptQmc } = require('./decryptor/qmc');
const { getCredentials, getEkey } = require('./decryptor/ekey_fetch');

const HELP = `ekey 取钥工具

用法
  node ekey.js <文件.mflac>              读页脚自动定位曲目并取 ekey
  node ekey.js <文件> --out <产物>        取到钥匙后顺手解密
  node ekey.js --songmid <mid> --filename <名>   手填参数取钥匙（STag 文件用这个）
  node ekey.js --probe <文件>             只看页脚信息，不联网
  node ekey.js --cred                     只看本机凭证来源与健康度
  node ekey.js --json ...                 机器可读输出

选项
  --songmid <mid>      曲目 mediaMid，形如 004AxZur0wQjFR
  --filename <name>    服务端文件名，形如 AIM00049KhbW0Bjq0G.mflac（前缀代表音质档位）
  --uin <uin>          覆盖自动取到的 uin
  --out <路径>         取到钥匙后直接解密到该路径
  --json               输出 JSON
  --help               显示本帮助

凭证优先取环境变量 QQ_MUSIC_AUTHST / QQ_MUSIC_UIN，其次扫本机 QQ 音乐客户端内存，最后读 ekeycache.json。`;

// authst 正常形态是一串 base64url 字符。出现控制字符或引号通常意味着内存扫描越过了字符串边界，
// 这种凭证请求 GetEVkey 必被拒，与其等接口返回空，不如当场提示。
const DIRTY_RE = /[\x00-\x1f"'\s?]/;

function credHealth(authst) {
  if (!authst) return { ok: false, reason: '空值' };
  const m = String(authst).match(DIRTY_RE);
  if (m) return { ok: false, reason: `含非法字符 ${JSON.stringify(m[0])}，疑似内存读取越界` };
  if (authst.length < 16) return { ok: false, reason: `长度仅 ${authst.length}，明显不完整` };
  return { ok: true, reason: '正常' };
}

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { o.help = true; continue; }
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const key = a.slice(2);
    const eq = key.indexOf('=');
    if (eq !== -1) { o[key.slice(0, eq)] = key.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { o[key] = next; i++; }
    else o[key] = true;
  }
  return o;
}

async function resolveCred(opts) {
  if (process.env.QQ_MUSIC_AUTHST) {
    return {
      authst: process.env.QQ_MUSIC_AUTHST.trim(),
      uin: (process.env.QQ_MUSIC_UIN || '').trim(),
      source: 'env',
    };
  }
  const c = await getCredentials();
  if (!c || !c.authst) return null;
  return { authst: c.authst.trim(), uin: (c.uin || '').trim(), source: c.source || 'native/ps1' };
}

function pad(s, n) {
  // 中文字符按两个宽度算，保证冒号后的列对齐
  let w = 0;
  for (const ch of String(s)) w += /[\u2e80-\uffef]/.test(ch) ? 2 : 1;
  return String(s) + ' '.repeat(Math.max(0, n - w));
}

function emit(opts, lines, obj) {
  if (opts.json) {
    process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
    return;
  }
  for (const l of lines) process.stdout.write(l + '\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  // --probe 后面可以跟文件路径，也可以不带而用位置参数，两种写法都要认
  const file = opts._[0]
    || (typeof opts.file === 'string' ? opts.file : null)
    || (typeof opts.probe === 'string' ? opts.probe : null);

  if (opts.cred) {
    const c = await resolveCred(opts);
    if (!c) {
      emit(opts, ['凭证获取失败：没找到 QQ_MUSIC_AUTHST 环境变量，本机客户端也没在运行'], { ok: false, cred: null });
      return 1;
    }
    const h = credHealth(c.authst);
    const preview = c.authst.length > 32 ? c.authst.slice(0, 32) + '…' : c.authst;
    emit(opts, [
      `${pad('凭证来源', 10)}${c.source}`,
      `${pad('uin', 10)}${c.uin || '(空)'}`,
      `${pad('authst', 10)}${preview}（长度 ${c.authst.length}）`,
      `${pad('健康度', 10)}${h.ok ? '正常' : '异常：' + h.reason}`,
      ...(h.ok ? [] : ['', '建议：把 ekeycache.json 改成 {} 后重取，或改用环境变量注入干净凭证']),
    ], { ok: h.ok, source: c.source, uin: c.uin, authstLen: c.authst.length, health: h });
    return h.ok ? 0 : 1;
  }

  if (!file && !(opts.songmid && opts.filename)) {
    process.stdout.write(HELP + '\n');
    return 1;
  }

  let probe = null;
  let target = null;
  let embedded = null;

  if (file) {
    if (!fs.existsSync(file)) {
      emit(opts, [`文件不存在：${file}`], { ok: false, error: 'file-not-found' });
      return 1;
    }
    probe = probeQmc(file);
    const f = probe.footer;
    if (f && f.ekey) embedded = { ekey: f.ekey, kind: f.kind };
    if (f && f.info) {
      target = { filename: f.info.filename, mediaMid: f.info.mediaMid, songId: f.info.songId, kind: f.kind };
    }
  }
  if (opts.songmid && opts.filename) {
    target = { filename: opts.filename, mediaMid: opts.songmid, songId: null, kind: 'manual' };
  }

  if (opts.probe) {
    const f = probe && probe.footer;
    emit(opts, [
      `${pad('文件', 10)}${file}`,
      `${pad('探测结果', 10)}${probe ? probe.type : '未识别'}`,
      `${pad('尾包类型', 10)}${f ? f.kind : '(无)'}`,
      `${pad('内嵌钥匙', 10)}${embedded ? '有，可直接离线解密' : '无'}`,
      ...(target ? [
        `${pad('songId', 10)}${target.songId || '(未知)'}`,
        `${pad('mediaMid', 10)}${target.mediaMid}`,
        `${pad('filename', 10)}${target.filename}`,
      ] : []),
    ], {
      ok: true, file, type: probe ? probe.type : null,
      footerKind: f ? f.kind : null, embedded: !!embedded, target,
    });
    return 0;
  }

  if (embedded && !opts.out) {
    emit(opts, [
      `${pad('尾包类型', 10)}${embedded.kind}`,
      '该文件尾包已内嵌钥匙，无需联网取钥，直接上传即可解密。',
      '',
      'EKEY=' + embedded.ekey,
    ], { ok: true, needNetwork: false, footerKind: embedded.kind, ekey: embedded.ekey });
    return 0;
  }

  if (!target) {
    const kind = probe && probe.footer ? probe.footer.kind : null;
    const lines = [`${pad('尾包类型', 10)}${kind || '(无)'}`, ''];
    if (kind === 'STag') {
      lines.push('STag 尾包只带一个数字歌曲 id，没有 mediaMid，无法自动定位曲目。');
      lines.push('请到 QQ 音乐客户端或网页端找到这首歌的 songmid 与服务端文件名，再用 --songmid / --filename 手动取钥。');
    } else {
      lines.push('未能从文件中解析出 songmid 与 filename，请用 --songmid 与 --filename 手动指定。');
    }
    emit(opts, lines, { ok: false, error: 'no-target', footerKind: kind });
    return 1;
  }

  const cred = await resolveCred(opts);
  if (!cred) {
    emit(opts, [
      '取不到凭证：请确保 QQ 音乐客户端已登录并保持运行，或设置 QQ_MUSIC_AUTHST / QQ_MUSIC_UIN 环境变量后重试。',
    ], { ok: false, error: 'no-cred' });
    return 1;
  }
  const health = credHealth(cred.authst);
  if (!health.ok) {
    emit(opts, [
      `${pad('凭证来源', 10)}${cred.source}`,
      `凭证异常：${health.reason}`,
      '把 ekeycache.json 改成 {} 后重取，或改用环境变量注入干净凭证。',
    ], { ok: false, error: 'dirty-cred', source: cred.source, health });
    return 1;
  }

  const info = {
    filename: target.filename,
    mediaMid: target.mediaMid,
    songId: target.songId,
  };
  const ekey = await getEkey(info, cred.authst, opts.uin ? String(opts.uin) : cred.uin);

  const head = [
    `${pad('文件', 10)}${file || '(手动指定)'}`,
    `${pad('尾包类型', 10)}${target.kind}`,
    `${pad('mediaMid', 10)}${target.mediaMid}`,
    `${pad('filename', 10)}${target.filename}`,
    `${pad('凭证来源', 10)}${cred.source}`,
  ];

  if (!ekey) {
    emit(opts, [
      ...head,
      '',
      '接口未返回 ekey。常见原因：凭证已过期、该账号无权播放此音质、filename 档位与文件不符、或接口已变更。',
      '先用 node ekey.js --cred 确认凭证健康度，再核对 filename 前缀（M500 / M800 / C400 / AIM000 / F0M0）。',
    ], { ok: false, error: 'no-ekey', target, source: cred.source });
    return 1;
  }

  if (opts.out && typeof opts.out === 'string') {
    const r = await decryptQmc(file, opts.out, ekey, null, probe);
    const warn = r.format === 'bin' ? ['', '警告：产物未识别出音频魔数，钥匙可能不匹配'] : [];
    emit(opts, [
      ...head,
      '',
      `${pad('产物', 10)}${r.outputPath}`,
      `${pad('格式', 10)}${r.format}`,
      `${pad('模式', 10)}${r.mode}`,
      ...warn,
    ], { ok: r.format !== 'bin', ekey, output: r.outputPath, format: r.format, mode: r.mode });
    return r.format === 'bin' ? 1 : 0;
  }

  emit(opts, [...head, '', 'EKEY=' + ekey], {
    ok: true, ekey, mediaMid: target.mediaMid, filename: target.filename, source: cred.source,
  });
  return 0;
}

main().then((code) => process.exit(code || 0)).catch((e) => {
  process.stderr.write('执行失败：' + (e && e.message ? e.message : String(e)) + '\n');
  process.exit(1);
});
