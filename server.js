'use strict';
// 本地解密服务：提供 Apple 液态玻璃前端 + 上传解密接口
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URLSearchParams } = require('url');
const { decryptNcm } = require('./decryptor/ncm');
const { decryptQmc, probeQmc } = require('./decryptor/qmc');
const { decryptKwm } = require('./decryptor/kwm');
const { fetchEkey } = require('./decryptor/ekey_fetch');
const { classifyHead, decryptKgmaFile, decryptKggFile } = require('./decryptor/kugou');
const { buildZip } = require('./lib/zipstore');

const PORT = process.env.PORT || 8787;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vip-unlock-'));
const JOBS = new Map(); // id -> { outputPath, ext, name, meta | info, mode, coverPath, createdAt }
const MAX_UPLOAD = 512 * 1024 * 1024; // 单文件上限；192kHz Hi-Res flac 实测约 200MB，留一倍余量
// 两个值都可用环境变量覆盖：JOB_TTL_MIN=0 配合很短的 SWEEP_INTERVAL_MIN 即可验证回收路径
// 注意别写 `Number(env) || 默认值`：0 是 falsy，会被默认值顶掉
const envNum = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
const JOB_TTL_MS = envNum(process.env.JOB_TTL_MIN, 120) * 60 * 1000; // 产物保留时长，超时后连同临时目录一起回收
const SWEEP_INTERVAL_MS = envNum(process.env.SWEEP_INTERVAL_MIN, 10) * 60 * 1000;

// 回收单个任务：产物、封面，以及 kgg 那条链路留下的 kggrun-* 运行目录
function removeJob(id) {
  const job = JOBS.get(id);
  if (!job) return;
  JOBS.delete(id);
  for (const p of [job.outputPath, job.coverPath]) {
    if (p) fs.rm(p, { force: true }, () => {});
  }
  if (job.kind === 'kgg' && job.outputPath) {
    const dir = path.dirname(job.outputPath);
    if (path.basename(dir).startsWith('kggrun-')) {
      fs.rm(dir, { recursive: true, force: true }, () => {});
    }
  }
}

function sweepJobs() {
  const now = Date.now();
  for (const [id, job] of JOBS) {
    if (now - (job.createdAt || 0) >= JOB_TTL_MS) removeJob(id);
  }
}
const sweeper = setInterval(sweepJobs, SWEEP_INTERVAL_MS);
sweeper.unref(); // 定时器不阻止进程退出

const STALE_TMP_MS = 6 * 60 * 60 * 1000; // 陈旧临时目录的回收阈值

// 进程被强杀时（Windows 没有可靠的 SIGTERM）退出清理会失效，临时目录必然残留。
// 启动时兜底回收上一轮遗留的 vip-unlock-* 目录。自己的目录刚创建，mtime 很新，不会被误删。
function reapStaleTmpDirs() {
  const root = os.tmpdir();
  let entries;
  try { entries = fs.readdirSync(root); } catch (_) { return; }
  const now = Date.now();
  let n = 0;
  for (const name of entries) {
    if (!name.startsWith('vip-unlock-')) continue;
    const p = path.join(root, name);
    try {
      const st = fs.statSync(p);
      if (st.isDirectory() && now - st.mtimeMs > STALE_TMP_MS) {
        fs.rmSync(p, { recursive: true, force: true });
        n++;
      }
    } catch (_) { /* 可能正被别的实例使用，跳过 */ }
  }
  if (n) console.log(`已回收 ${n} 个遗留临时目录`);
}
reapStaleTmpDirs();

function cleanupAll() {
  clearInterval(sweeper);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}
process.on('exit', cleanupAll);
process.on('SIGINT', () => { cleanupAll(); process.exit(0); });
process.on('SIGTERM', () => { cleanupAll(); process.exit(0); });

// 把请求体以二进制流写入临时文件，返回 { filePath, got }
// 超过 maxBytes 直接掐断连接并抛 TOO_LARGE，避免先写满磁盘再报错
function readBodyToFile(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const filePath = path.join(TMP, `in_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    const w = fs.createWriteStream(filePath);
    let got = 0;
    let stopped = false;
    req.on('data', (c) => {
      if (stopped) return;
      got += c.length;
      if (got > maxBytes) {
        stopped = true;
        w.destroy();
        req.destroy();
        fs.rm(filePath, { force: true }, () => {});
        const err = new Error('上传体积超过上限');
        err.code = 'TOO_LARGE';
        reject(err);
        return;
      }
      w.write(c);
    });
    req.on('end', () => { if (!stopped) w.end(() => resolve({ filePath, got })); });
    req.on('error', (e) => { w.destroy(); reject(e); });
    w.on('error', reject);
  });
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function parseQ(res) {
  return new URLSearchParams(res.req.url.split('?')[1] || '');
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  // 上传的临时文件要在所有失败路径上回收，放到 try 外面以便 catch 里访问
  let uploadPath = null;
  try {
    // 静态资源
    if (url === '/' || url === '/index.html') return serveFile(res, path.join(__dirname, 'public', 'index.html'), 'text/html; charset=utf-8');
    if (url === '/app.js') return serveFile(res, path.join(__dirname, 'public', 'app.js'), 'text/javascript; charset=utf-8');
    if (url === '/style.css') return serveFile(res, path.join(__dirname, 'public', 'style.css'), 'text/css; charset=utf-8');

    // 解密接口：raw 二进制 body
    if (url === '/api/decrypt' && req.method === 'POST') {
      const contentLen = parseInt(req.headers['content-length'] || '0', 10);
      let ekey = decodeURIComponent(req.headers['x-ekey'] || '').trim();
      const origName = decodeURIComponent(req.headers['x-filename'] || 'audio');
      if (!contentLen || contentLen < 8) return sendJSON(res, 400, { error: '未收到文件数据' });
      // Content-Length 可信时直接挡掉，头被伪造或分块传输时由 readBodyToFile 流式兜底
      if (contentLen > MAX_UPLOAD) {
        return sendJSON(res, 413, { error: `文件过大，单文件上限 ${MAX_UPLOAD / 1024 / 1024} MB` });
      }

      const { filePath } = await readBodyToFile(req, MAX_UPLOAD);
      uploadPath = filePath;

      // 判型优先级：酷狗头部指纹 > .kwm 扩展名 > NCM 魔数 > QMC 统一探测（v1/v2）
      const headBuf = Buffer.alloc(28);
      {
        const fd = fs.openSync(filePath, 'r');
        fs.readSync(fd, headBuf, 0, 28, 0);
        fs.closeSync(fd);
      }
      const kuGouKind = classifyHead(headBuf);

      const lower = origName.toLowerCase();
      const fmt = kuGouKind !== 'other' ? kuGouKind
        : lower.endsWith('.kwm') ? 'kwm'
        : headBuf.subarray(0, 8).toString('ascii') === 'CTENFDAM' ? 'ncm'
        : 'qmc';

      const onProgress = () => {}; // 解密是同步流式完成，进度无处分发，保留钩子供后续扩展
      let jobId = Math.random().toString(36).slice(2, 10);
      let result;
      let autoEkey = false;
      if (fmt === 'kgma') {
        // 新版 KGMA：静态掩码算法，无需任何密钥；流式写盘，内存占用与文件大小脱钩
        const r = await decryptKgmaFile(filePath, path.join(TMP, `out_${jobId}`));
        if (r.ext === 'bin') throw new Error('解密失败：产物无法识别为有效音频');
        JOBS.set(jobId, { kind: 'kgma', outputPath: r.outputPath, ext: r.ext, name: origName, createdAt: Date.now() });
        fs.unlink(filePath, () => {});
        return sendJSON(res, 200, { ok: true, id: jobId, format: r.ext, mode: 'mask', source: 'kugou', meta: null, info: null, autoEkey: false });
      }
      if (fmt === 'kgg') {
        // KGG：调用本机 kgg-dec；密钥来自酷狗本地密钥库。
        // helper 会在独立运行目录内改名执行并消费掉上传临时文件
        const r = await decryptKggFile(filePath, TMP);
        JOBS.set(jobId, { kind: 'kgg', outputPath: r.outputPath, ext: r.ext, name: origName, createdAt: Date.now() });
        return sendJSON(res, 200, { ok: true, id: jobId, format: r.ext, mode: 'local-db', source: 'kugou', meta: null, info: null, autoEkey: false });
      }
      if (fmt === 'kwm') {
        // 酷我 KWM：1024 头剥离 + 32 字节密钥恢复，全程无需外部钥匙
        result = await decryptKwm(filePath, path.join(TMP, `out_${jobId}`), ekey, onProgress);
        JOBS.set(jobId, { kind: 'kwm', outputPath: result.outputPath, ext: result.format, name: origName, createdAt: Date.now() });
        fs.unlink(filePath, () => {});
        return sendJSON(res, 200, { ok: true, id: jobId, format: result.format, mode: 'key-recovered', source: 'kuwo', meta: null, info: null, autoEkey: false });
      }
      if (fmt === 'ncm') {
        result = await decryptNcm(filePath, path.join(TMP, `out_${jobId}`), onProgress, { coverPath: path.join(TMP, `cover_${jobId}`) });
        JOBS.set(jobId, { kind: 'ncm', outputPath: result.outputPath, ext: result.format, name: origName, meta: result.meta, coverPath: result.coverPath, createdAt: Date.now() });
      } else {
        // QMC 统一探测：v1 静态密钥 / v2 四类尾包（QTag/PcV1Legacy 内嵌钥匙可离线解密）
        const probe = probeQmc(filePath);
        const footer = probe.footer;
        const info = footer && footer.info;
        const embeddedKey = footer && footer.ekey;
        if (probe.type === 'v2' && !ekey && !embeddedKey) {
          // 无手动、无内嵌：MusicEx 尝试本机客户端自动取；STag 只能手动
          if (info) {
            ekey = await fetchEkey(info);
            autoEkey = !!ekey;
          }
          if (!ekey) {
            fs.unlink(filePath, () => {});
            const st = footer.kind === 'STag'
              ? '该文件（STag 尾包）未内嵌钥匙，请在下方手动粘贴 ekey 后重试'
              : '该 QQ音乐文件需要 ekey，自动获取失败：请确认 QQ音乐 已登录并保持运行，或在下方手动粘贴 ekey';
            return sendJSON(res, 400, { error: st, info: info || null, needEkey: true, footerKind: footer.kind });
          }
        }
        result = await decryptQmc(filePath, path.join(TMP, `out_${jobId}`), ekey, onProgress, probe);
        if (result.format === 'bin') throw new Error('解密失败：产物无法识别为有效音频（请检查 ekey 是否正确）');
        JOBS.set(jobId, { kind: 'qmc', outputPath: result.outputPath, ext: result.format, name: origName, info: result.info, mode: result.mode, createdAt: Date.now() });
      }
      fs.unlink(filePath, () => {});
      return sendJSON(res, 200, {
        ok: true, id: jobId, format: result.format, mode: result.mode || null,
        source: fmt === 'ncm' ? 'netease' : 'qq',
        meta: result.meta || null, info: result.info || null, autoEkey,
        keySource: result.keySource || null, footerKind: result.footerKind || null,
        cover: (result.coverPath || (JOBS.get(jobId) && JOBS.get(jobId).coverPath)) ? `/api/cover?id=${jobId}` : null,
      });
    }

    // 下载 / 播放解密产物
    if (url === '/api/audio' && req.method === 'GET') {
      const q = parseQ(res);
      const job = JOBS.get(q.get('id'));
      if (!job) return sendJSON(res, 404, { error: '未找到该任务' });
      const stat = fs.statSync(job.outputPath);
      const dl = q.get('dl') === '1';
      res.writeHead(200, {
        'Content-Type': job.ext === 'flac' ? 'audio/flac' : job.ext === 'mp3' ? 'audio/mpeg' : job.ext === 'm4a' ? 'audio/mp4' : job.ext === 'wav' ? 'audio/wav' : 'audio/ogg',
        'Content-Length': stat.size,
        'Accept-Ranges': 'bytes',
        ...(dl ? { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(baseName(job.name) + '.' + job.ext)}` } : {}),
      });
      return fs.createReadStream(job.outputPath).pipe(res);
    }

    // 专辑封面（NCM 内嵌）
    if (url === '/api/cover' && req.method === 'GET') {
      const q = parseQ(res);
      const job = JOBS.get(q.get('id'));
      if (!job || !job.coverPath || !fs.existsSync(job.coverPath)) return sendJSON(res, 404, { error: '无封面' });
      const type = path.extname(job.coverPath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=86400' });
      return fs.createReadStream(job.coverPath).pipe(res);
    }

    // 打包下载：多个产物合成 zip（store 模式，零压缩）
    if (url === '/api/zip' && req.method === 'GET') {
      const q = parseQ(res);
      const ids = (q.get('ids') || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!ids.length) return sendJSON(res, 400, { error: '未指定要打包的任务 id' });
      const entries = [];
      const used = new Set();
      for (const id of ids) {
        const job = JOBS.get(id);
        if (!job || !fs.existsSync(job.outputPath)) continue;
        let name = `${baseName(job.name)}.${job.ext}`;
        let n = 2;
        while (used.has(name.toLowerCase())) { name = `${baseName(job.name)} (${n}).${job.ext}`; n++; }
        used.add(name.toLowerCase());
        entries.push({ name, path: job.outputPath });
      }
      if (!entries.length) return sendJSON(res, 404, { error: '打包列表内没有有效任务' });
      const zipPath = path.join(TMP, `pack_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.zip`);
      const { count } = await buildZip(zipPath, entries);
      const stat = fs.statSync(zipPath);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`解密产物-${count}首.zip`)}`,
      });
      const stream = fs.createReadStream(zipPath);
      stream.on('close', () => fs.unlink(zipPath, () => {}));
      return stream.pipe(res);
    }

    sendJSON(res, 404, { error: '未知接口' });
  } catch (e) {
    // 解密失败时上传文件不再被后续流程消费，必须在这里回收，
    // 否则每个失败请求都会在 TMP 里留下一份，直到进程退出才清掉
    if (uploadPath) fs.unlink(uploadPath, () => {});
    if (!res.headersSent) {
      if (e.code === 'TOO_LARGE') {
        return sendJSON(res, 413, { error: `文件过大，单文件上限 ${MAX_UPLOAD / 1024 / 1024} MB` });
      }
      const needEkey = e.code === 'NEED_EKEY';
      return sendJSON(res, needEkey ? 400 : 500, { error: e.message, needEkey, footerKind: e.footerKind || null });
    }
    res.end();
  }
});

function baseName(n) {
  const b = path.basename(n || '');
  return b.replace(/\.(ncm|mflac|mflac0|mgg|mgg0|mgg1|mggl|mmp4|qmc0|qmc2|qmc3|qmc4|qmc6|qmc8|qmcflac|qmcogg|tkm|bkcmp3|bkcm4a|bkcflac|bkcwav|bkcape|bkcogg|bkcwma|666c6163|6d7033|6f6767|6d3461|776176|kgg|kgma|kgm|vpr|kwm|bin)$/i, '');
}

function serveFile(res, p, type) {
  if (!fs.existsSync(p)) return sendJSON(res, 404, { error: 'not found' });
  const data = fs.readFileSync(p);
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length });
  res.end(data);
}

server.listen(PORT, () => {
  console.log(`VipSongsUnlock 服务已启动: http://localhost:${PORT}`);
  console.log('支持的加密格式:');
  console.log('  .ncm  网易云（无需密钥，自动提取专辑封面）');
  console.log('  QQ音乐 v2: .mflac/.mgg（musicex/QTag/PcV1Legacy 内嵌钥匙可离线解密，STag 需手动粘贴 ekey，本机客户端运行时自动取钥匙）');
  console.log('  QQ音乐 v1: .qmcflac/.qmc0~8/.tkm/.bkc*/十六进制伪装扩展名（公开静态密钥，无需钥匙）');
  console.log('  酷狗: .kgma（无需密钥） / .kgg（依赖本机密钥库）');
  console.log('  酷我: .kwm（密钥自动恢复，无需钥匙）');
  console.log('  批量产物支持 zip 打包下载');
});