'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const dz = $('#dropzone'), fileInput = $('#fileInput'), pickBtn = $('#pickBtn');
  const queuePanel = $('#queuePanel'), queueList = $('#queueList'), qCount = $('#qCount'), clearBtn = $('#clearBtn');
  const zipBtn = $('#zipBtn'), albumEl = $('#album');
  const resultPanel = $('#resultPanel'), resName = $('#resName'), resMeta = $('#resMeta');
  const badgeFmt = $('#badgeFmt'), badgeMode = $('#badgeMode');
  const playBtn = $('#playBtn'), dlBtn = $('#dlBtn'), againBtn = $('#againBtn'), player = $('#player');
  const playerBar = $('#playerBar'), ppBtn = $('#ppBtn'), pTrack = $('#pTrack'), tCur = $('#tCur'), tDur = $('#tDur');

  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const RE_NCM = /\.ncm$/i;
  // 与后端判型保持同步：QMC v2 / v1（含十六进制伪装扩展名与 bkc* 系列）/ 酷我 kwm
  const RE_QMC = /\.(mflac|mflac0|mgg|mgg0|mgg1|mggl|mmp4|qmc0|qmc2|qmc3|qmc4|qmc6|qmc8|qmcflac|qmcogg|tkm|bkcmp3|bkcm4a|bkcflac|bkcwav|bkcape|bkcogg|bkcwma|666c6163|6d7033|6f6767|6d3461|776176)$/i;
  const RE_KG  = /\.(kgg|kgma|kgm)$/i;
  const RE_KWM = /\.kwm$/i;
  const SRC_LABEL = { netease: '网易云 ncm', qq: 'QQ音乐', kugou: '酷狗音乐', kuwo: '酷我音乐' };
  const MODE_LABEL = { map: 'Map 解密', rc4: 'RC4 解密', mask: '静态掩码', 'local-db': '本机密钥库', 'key-recovered': '密钥恢复', 'v1-static': '内置密钥表' };
  const KEY_SOURCE_LABEL = { static: '内置密钥表', manual: '手动钥匙', embedded: '内嵌钥匙', 'kwm-recovered': '密钥恢复' };
  const TITLE_DEFAULT = '拖入加密音频（可多选），或点击这里导入';

  let currentId = null;   // 结果面板当前展示的作业 id

  /* ---------- 常驻动画：粒子流 / 背景视差 ---------- */
  function initFX() {
    if (REDUCED) return;
    const cv = document.getElementById('fx');
    const ctx = cv.getContext('2d');
    const blobsEl = document.getElementById('blobs');
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    const COLORS = ['#7f8cff', '#ff9ec0', '#7fc6ff', '#ffd978', '#c3b3ff'];
    let W = 0, H = 0, parts = [];

    // 预渲染发光粒子贴图，避免每帧建渐变
    const sprites = COLORS.map((c) => {
      const s = document.createElement('canvas'); s.width = s.height = 64;
      const g = s.getContext('2d');
      const rg = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      rg.addColorStop(0, c + 'ff'); rg.addColorStop(.35, c + 'aa'); rg.addColorStop(1, c + '00');
      g.fillStyle = rg; g.fillRect(0, 0, 64, 64);
      return s;
    });

    function resize() {
      W = innerWidth; H = innerHeight;
      cv.width = W * DPR; cv.height = H * DPR;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      const n = Math.round(Math.min(64, Math.max(24, (W * H) / 26000)));
      parts = Array.from({ length: n }, () => spawn(true));
    }
    function spawn(anywhere) {
      return {
        x: Math.random() * W,
        y: anywhere ? Math.random() * H : H + 20,
        r: 1.2 + Math.random() * 2.6,
        vy: .18 + Math.random() * .45,
        amp: 8 + Math.random() * 22,
        f: .25 + Math.random() * .7,
        ph: Math.random() * Math.PI * 2,
        tw: 1 + Math.random() * 2,
        ph2: Math.random() * Math.PI * 2,
        al: .18 + Math.random() * .4,
        sp: sprites[(Math.random() * sprites.length) | 0],
      };
    }

    // 音乐符号粒子：♪ ♫ ♩ ♬ 缓升 · 摇曳 · 微旋（霓虹发光）
    const GLYPHS = ['♪', '♫', '♩', '♬'];
    const NOTE_C = ['#8b93ff', '#39d5ff', '#ff7ad9'];
    let notes = [], nextNote = 1.2;
    function spawnNote(fromBottom) {
      return {
        g: GLYPHS[(Math.random() * GLYPHS.length) | 0],
        c: NOTE_C[(Math.random() * NOTE_C.length) | 0],
        x: W * (.06 + Math.random() * .88),
        y: fromBottom ? H + 30 : Math.random() * H,
        vy: .32 + Math.random() * .5,
        sz: 12 + Math.random() * 13,
        rot: (Math.random() - .5) * .8,
        vr: (Math.random() - .5) * .012,
        amp: 14 + Math.random() * 22,
        f: .3 + Math.random() * .55,
        ph: Math.random() * Math.PI * 2,
        tw: .8 + Math.random() * 1.6,
        ph2: Math.random() * Math.PI * 2,
        al: .12 + Math.random() * .22,
      };
    }

    addEventListener('resize', resize);
    resize();

    // 背景随光标轻视差（含缓动）
    let mx = W / 2, my = H / 2, cx = mx, cy = my;
    addEventListener('mousemove', (e) => { mx = e.clientX; my = e.clientY; });

    let t = 0;
    (function loop() {
      requestAnimationFrame(loop);
      if (document.hidden) return;
      t += 1 / 60;
      ctx.clearRect(0, 0, W, H);
      for (const p of parts) {
        p.y -= p.vy;
        if (p.y < -24) Object.assign(p, spawn(false));
        const x = p.x + Math.sin(t * p.f * 6 + p.ph) * p.amp * .4;
        const a = p.al * (.55 + .45 * Math.sin(t * p.tw * 2 + p.ph2));
        const s = p.r * 9;
        ctx.globalAlpha = a;
        ctx.drawImage(p.sp, x - s / 2, p.y - s / 2, s, s);
      }
      ctx.globalAlpha = 1;

      // 音乐符号更新与绘制
      nextNote -= 1 / 60;
      if (nextNote <= 0 && notes.length < 7) {
        notes.push(spawnNote(false));
        nextNote = 2 + Math.random() * 3.4;
      }
      for (let i = notes.length - 1; i >= 0; i--) {
        const n = notes[i];
        n.y -= n.vy;
        n.rot += n.vr;
        if (n.y < -40) { notes.splice(i, 1); continue; }
        const nx = n.x + Math.sin(t * n.f * 6 + n.ph) * n.amp * .5;
        const na = n.al * (.55 + .45 * Math.sin(t * n.tw * 2 + n.ph2));
        ctx.save();
        ctx.translate(nx, n.y);
        ctx.rotate(n.rot);
        ctx.font = `${n.sz.toFixed(1)}px "Segoe UI Symbol", serif`;
        ctx.textAlign = 'center';
        ctx.shadowColor = n.c;
        ctx.shadowBlur = 14;
        ctx.fillStyle = n.c;
        ctx.globalAlpha = na;
        ctx.fillText(n.g, 0, 0);
        ctx.restore();
      }
      ctx.globalAlpha = 1;

      cx += (mx - cx) * .05; cy += (my - cy) * .05;
      const dx = cx / innerWidth - .5, dy = cy / innerHeight - .5;
      blobsEl.style.transform = `translate(${(-dx * 26).toFixed(1)}px, ${(-dy * 18).toFixed(1)}px)`;
    })();
  }

  /* ---------- 导入区光标倾斜（悬停跟随） ---------- */
  function initTilt() {
    if (REDUCED || !matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    const MAX = 5;
    let rx = 0, ry = 0, tX = 0, tY = 0, raf = null;
    const step = () => {
      rx += (tX - rx) * .16; ry += (tY - ry) * .16;
      dz.style.transform = `perspective(900px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`;
      if (Math.abs(rx - tX) > .04 || Math.abs(ry - tY) > .04 || tX || tY) {
        raf = requestAnimationFrame(step);
      } else { raf = null; if (!tX && !tY) dz.style.transform = ''; }
    };
    const kick = () => { if (!raf) raf = requestAnimationFrame(step); };
    const reset = () => { tX = 0; tY = 0; kick(); };
    dz.addEventListener('mousemove', (e) => {
      const r = dz.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - .5;
      const py = (e.clientY - r.top) / r.height - .5;
      tX = -py * MAX * 2; tY = px * MAX * 2; kick();
      // 光标追光坐标（CSS 通过 --mx/--my 渲染 spotlight）
      dz.style.setProperty('--mx', ((px + .5) * 100).toFixed(1) + '%');
      dz.style.setProperty('--my', ((py + .5) * 100).toFixed(1) + '%');
    });
    dz.addEventListener('mouseleave', reset);
    window.__dzResetTilt = reset;
  }

  /* ---------- Web Audio：播放时接入实时频谱 ---------- */
  let audioCtx = null, analyser = null, freqData = null;
  function ensureAudio() {
    if (analyser || REDUCED) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      audioCtx = new AC();
      const src = audioCtx.createMediaElementSource(player);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = .82;
      src.connect(analyser);
      analyser.connect(audioCtx.destination);
      freqData = new Uint8Array(analyser.frequencyBinCount);
    } catch (_) { /* 直连失败则保持纯合成波纹 */ }
  }

  /* ---------- 常驻声波层：闲置合成波纹 ↔ 播放真实频谱 ---------- */
  let waveSetLive = null;
  function initWave() {
    if (REDUCED) return;
    const cv = $('#wave');
    const ctx = cv.getContext('2d');
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    let W = 0, H = 170;
    const resize = () => {
      W = innerWidth;
      H = cv.clientHeight || 170;
      cv.width = W * DPR; cv.height = H * DPR;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    };
    addEventListener('resize', resize);
    resize();

    // 多条错频正弦反向漂移，叠出液态涌动的底层
    const LAYERS = [
      { ph: 0,   f: .0085, sp: .55,  amp: .48, rgb: '57,213,255',  al: .30, lw: 1.5 },
      { ph: 2.1, f: .0125, sp: -.78, amp: .36, rgb: '139,147,255', al: .26, lw: 1.7 },
      { ph: 4.4, f: .019,  sp: 1.02, amp: .27, rgb: '255,122,217', al: .22, lw: 1.3 },
      { ph: 1.2, f: .027,  sp: -1.4, amp: .17, rgb: '127,198,255', al: .18, lw: 1.1 },
    ];

    const BINS = 96;
    const sm = new Float32Array(BINS);
    let t = 0, mix = 0, live = false;
    waveSetLive = (v) => {
      live = !!v;
      if (live && audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    };

    // 中部隆起的包络，让波峰聚在舞台中心
    const env = (x) => Math.exp(-Math.pow(x / W - .5, 2) / .12);

    (function loop() {
      requestAnimationFrame(loop);
      if (document.hidden) return;
      t += 1 / 60;
      mix += ((live && analyser ? 1 : 0) - mix) * .06;

      const hasData = !!(analyser && freqData && mix > .02);
      if (hasData) {
        analyser.getByteFrequencyData(freqData);
        for (let i = 0; i < BINS; i++) {
          // 幂律映射让低频占更宽视觉区间，再做时间平滑防抖
          const idx = Math.floor(Math.pow(i / BINS, 1.55) * (freqData.length - 1));
          sm[i] += (freqData[idx] / 255 - sm[i]) * .25;
        }
      }

      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';

      // 底层：合成波纹持续涌动（播放时随 mix 压平让位给频谱）
      for (const L of LAYERS) {
        ctx.beginPath();
        for (let i = 0; i <= 72; i++) {
          const x = (i / 72) * W;
          const swell = .62 + .38 * Math.sin(t * .35 * L.sp + L.ph);
          const w1 = Math.sin(x * L.f + t * 1.7 * L.sp + L.ph);
          const w2 = Math.sin(x * L.f * 2.4 - t * 1.1 * L.sp + L.ph * 1.7);
          const hgt = H * L.amp * swell * (1 - mix * .8) * (.45 + .55 * env(x));
          const y = H - 16 - hgt * (w1 * .72 + w2 * .28);
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.strokeStyle = `rgba(${L.rgb},${L.al})`;
        ctx.lineWidth = L.lw;
        ctx.stroke();
        ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
        ctx.fillStyle = `rgba(${L.rgb},${L.al * .1})`;
        ctx.fill();
      }

      // 播放层：真实频谱升起为霓虹山脊
      if (hasData) {
        const base = H - 3;
        ctx.beginPath();
        ctx.moveTo(0, base);
        for (let i = 0; i < BINS; i++) {
          const x = (i / (BINS - 1)) * W;
          const v = Math.pow(sm[i], 1.25);
          ctx.lineTo(x, base - v * (H - 52) * mix * env(x));
        }
        ctx.lineTo(W, base); ctx.closePath();
        const gr = ctx.createLinearGradient(0, base, 0, base - (H - 52));
        gr.addColorStop(0, 'rgba(139,147,255,.45)');
        gr.addColorStop(.55, 'rgba(57,213,255,.30)');
        gr.addColorStop(1, 'rgba(255,122,217,.14)');
        ctx.fillStyle = gr;
        ctx.fill();
        ctx.strokeStyle = 'rgba(190,228,255,.8)';
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }

      ctx.globalCompositeOperation = 'source-over';
    })();
  }

  /* ---------- 面板显示时弹出 ---------- */
  function show(el) {
    el.hidden = false;
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
  }

  /* ---------- 标题区临时消息 ---------- */
  const dzTitle = $('#dzTitle');
  let baseTitle = TITLE_DEFAULT, flashTimer = null;
  function setTitle(s) { baseTitle = s; dzTitle.textContent = s; }
  function flash(msg) {
    clearTimeout(flashTimer);
    dzTitle.textContent = msg;
    flashTimer = setTimeout(() => { dzTitle.textContent = baseTitle; }, 2600);
  }

  /* ================================================================
     批量解密队列：全部文件进队列，逐首串行处理
     （KGMA 解密整段载入内存 + 约70MB公钥表，串行可控制内存峰值）
     ================================================================ */
  const queue = [];       // 任务对象：{ file, ekey, status, el, job, dispName, dispMeta, dlName, 子节点引用 }
  let pumping = false;    // 是否正在串行消费队列

  function enqueue(fileList) {
    const ok = []; let skipped = 0;
    for (const f of fileList) {
      if (!f) continue;
      if (RE_NCM.test(f.name) || RE_QMC.test(f.name) || RE_KG.test(f.name) || RE_KWM.test(f.name)) ok.push(f);
      else skipped++;
    }
    if (skipped) flash(`已跳过 ${skipped} 个不支持的文件（支持 .ncm / .mflac / .qmc* / .kwm / .kgg / .kgma / .kgm）`);
    if (!ok.length) return;
    setTitle(ok.length === 1 ? ok[0].name : `已导入 ${ok.length} 首歌曲，正在逐首解密`);
    for (const f of ok) {
      const t = { file: f, ekey: '', status: 'queued', job: null };
      t.el = makeCard(t);
      queue.push(t);
      queueList.appendChild(t.el);
    }
    show(queuePanel);
    refreshSummary();
    pump();
  }

  function makeCard(t) {
    const el = document.createElement('div');
    el.className = 'card st-queued';
    el.innerHTML = `
      <span class="c-disc" aria-hidden="true"></span>
      <div class="c-main">
        <p class="c-name">${esc(t.file.name)}</p>
        <p class="c-meta">排队中…</p>
        <div class="c-bar" hidden><i></i></div>
      </div>
      <div class="c-side">
        <span class="c-chip c-fmt" hidden></span>
        <span class="c-chip c-mode" hidden></span>
        <button class="btn xs primary c-play" type="button" hidden>播放</button>
        <button class="btn xs glass-strong c-dl" type="button" hidden>下载</button>
        <button class="btn xs ghost c-retry" type="button" hidden>重试</button>
      </div>
      <div class="c-ekeyrow" hidden>
        <input type="password" placeholder="自动取钥失败，粘贴这首的 ekey 后重试" autocomplete="off">
        <button class="btn xs primary" type="button">确认重试</button>
      </div>`;
    t.discEl = el.querySelector('.c-disc');
    t.nameEl = el.querySelector('.c-name');
    t.metaEl = el.querySelector('.c-meta');
    t.bar = el.querySelector('.c-bar');
    t.barFill = el.querySelector('.c-bar i');
    t.chipFmt = el.querySelector('.c-fmt');
    t.chipMode = el.querySelector('.c-mode');
    t.bPlay = el.querySelector('.c-play');
    t.bDl = el.querySelector('.c-dl');
    t.bRetry = el.querySelector('.c-retry');
    t.ekeyRow = el.querySelector('.c-ekeyrow');
    t.ekeyInput = el.querySelector('.c-ekeyrow input');

    t.bPlay.addEventListener('click', () => openResult(t));
    t.bDl.addEventListener('click', () => {
      if (!t.job) return;
      const a = document.createElement('a');
      a.href = '/api/audio?id=' + t.job.id + '&dl=1';
      a.download = t.dlName || 'audio';
      a.click();
    });
    t.bRetry.addEventListener('click', () => {
      const needKey = t.needEkey || RE_QMC.test(t.file.name);
      if (needKey && !t.ekey) {         // QQ 音乐须先补钥匙再重投
        t.ekeyRow.hidden = false;
        t.ekeyInput.focus();
        return;
      }
      requeue(t);
    });
    el.querySelector('.c-ekeyrow .btn').addEventListener('click', () => {
      const v = t.ekeyInput.value.trim();
      if (!v) { t.ekeyInput.focus(); return; }
      t.ekey = v;
      requeue(t);
    });
    t.ekeyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') el.querySelector('.c-ekeyrow .btn').click();
    });
    return el;
  }

  function esc(s) { return (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function requeue(t) {
    t.status = 'queued';
    cardState(t, 'queued');
    t.needEkey = false;
    t.metaEl.textContent = '排队中…';
    t.metaEl.title = '';
    t.bRetry.hidden = true;
    t.ekeyRow.hidden = true;
    refreshSummary();
    pump();
  }

  function cardState(t, st) {
    t.el.classList.remove('st-queued', 'st-work', 'st-done', 'st-fail');
    t.el.classList.add('st-' + st);
  }

  function decipherOne(t) {
    return new Promise((resolve) => {
      t.status = 'work';
      cardState(t, 'work');
      t.bar.hidden = false;
      t.bar.classList.remove('indet');
      t.barFill.style.width = '0%';
      t.metaEl.textContent = '上传中 0%';

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/decrypt');
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('X-Filename', encodeURIComponent(t.file.name));
      xhr.setRequestHeader('X-Ekey', encodeURIComponent(t.ekey));
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const pct = Math.round(e.loaded / e.total * 100);
        t.barFill.style.width = Math.round(e.loaded / e.total * 70) + '%';
        t.metaEl.textContent = `上传中 ${pct}%`;
      };
      xhr.upload.onload = () => {
        t.bar.classList.add('indet');
        t.barFill.style.width = '100%';
        t.metaEl.textContent = '服务器解密中…';
      };
      xhr.onload = () => {
        let json;
        try { json = JSON.parse(xhr.responseText); } catch (_) { json = null; }
        if (xhr.status === 200 && json && json.ok) {
          finishTask(t, json);
        } else {
          t.needEkey = !!(json && json.needEkey);
          failTask(t, (json && json.error) || '服务响应异常', t.needEkey);
        }
        resolve();
      };
      xhr.onerror = () => { failTask(t, '网络错误，无法连接本地服务'); resolve(); };
      xhr.send(t.file);
    });
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    queuePanel.classList.add('working');
    try {
      for (;;) {
        const next = queue.find((x) => x.status === 'queued');
        if (!next) break;
        await decipherOne(next);
        refreshSummary();
      }
    } finally {
      pumping = false;
      queuePanel.classList.remove('working');
      refreshSummary();
    }
  }

  function finishTask(t, j) {
    t.job = j;
    t.status = 'done';
    t.needEkey = false;
    cardState(t, 'done');
    t.bar.hidden = true;
    t.ekeyRow.hidden = true;

    const meta = j.meta, info = j.info;
    const fallback = t.file.name.replace(/\.[^.]+$/, '');
    const rawNm = meta ? meta.musicName : info ? (info.filename || '') : '';
    t.dispName = norm(rawNm) || fallback;
    t.nameEl.textContent = t.dispName;

    const artists = meta && meta.artist ? meta.artist.map((a) => (Array.isArray(a) ? a[0] : a)).join(' / ') : '';
    t.dispMeta = [artists, (meta && meta.album) || null].filter(Boolean).join(' · ')
      || (info && info.filename ? 'QQ音乐 MusicEx' : SRC_LABEL[j.source] || '已解密');
    t.metaEl.textContent = t.dispMeta;
    t.metaEl.title = '';

    t.chipFmt.hidden = false;
    t.chipFmt.textContent = '.' + j.format;
    const modeTxt = KEY_SOURCE_LABEL[j.keySource] || (j.mode && MODE_LABEL[j.mode]);
    if (modeTxt) { t.chipMode.hidden = false; t.chipMode.textContent = modeTxt; }
    else { t.chipMode.hidden = true; }

    // 封面缩略图：NCM 解出专辑封面时替换队列卡黑胶占位
    if (j.cover) {
      t.cover = j.cover;
      t.discEl.classList.add('has-cover');
      t.discEl.style.backgroundImage = `url("${j.cover}")`;
    }

    t.dlName = fallback + '.' + j.format;
    t.bPlay.hidden = false;
    t.bDl.hidden = false;
  }

  function failTask(t, reason, needEkey) {
    t.status = 'fail';
    cardState(t, 'fail');
    t.bar.hidden = true;
    t.metaEl.textContent = '解密失败：' + reason;
    t.metaEl.title = reason;
    t.bRetry.hidden = false;
    if (needEkey) t.ekeyRow.hidden = false;   // 服务端明确缺钥匙：直接展开补录行
  }

  function refreshSummary() {
    const total = queue.length;
    if (!total) { qCount.textContent = ''; clearBtn.hidden = true; zipBtn.hidden = true; return; }
    const done = queue.filter((x) => x.status === 'done').length;
    const fail = queue.filter((x) => x.status === 'fail').length;
    qCount.textContent = `共 ${total} 首 · 完成 ${done}` + (fail ? ` · 失败 ${fail}` : '');
    clearBtn.hidden = !(done || fail);
    zipBtn.hidden = done < 2;          // 两首以上完成才提供打包下载
  }

  zipBtn.addEventListener('click', () => {
    const ids = queue.filter((x) => x.status === 'done' && x.job).map((x) => x.job.id);
    if (!ids.length) return;
    const a = document.createElement('a');
    a.href = '/api/zip?ids=' + ids.join(',');
    a.download = '';
    a.click();
  });

  /* ---------- 在结果大面板中播放任意已完成曲目 ---------- */
  function openResult(t) {
    const j = t.job;
    if (!j) return;
    currentId = j.id;
    resName.textContent = t.dispName;
    resMeta.textContent = t.dispMeta;
    badgeFmt.textContent = '.' + j.format;
    const modeTxt = KEY_SOURCE_LABEL[j.keySource] || (j.mode && MODE_LABEL[j.mode]);
    if (modeTxt) { badgeMode.hidden = false; badgeMode.textContent = modeTxt; }
    else { badgeMode.hidden = true; }
    if (t.cover) {
      albumEl.classList.add('has-cover');
      albumEl.style.backgroundImage = `url("${t.cover}")`;
    } else {
      albumEl.classList.remove('has-cover');
      albumEl.style.backgroundImage = '';
    }
    dlBtn.dataset.name = t.dlName || 'audio';

    player.pause();
    player.src = '/api/audio?id=' + j.id;
    playerBar.hidden = false;
    pTrack.style.setProperty('--p', '0%');
    tCur.textContent = '0:00'; tDur.textContent = '--:--';
    show(resultPanel);
    ensureAudio();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    const pr = player.play();
    if (pr && pr.catch) pr.catch(() => {});
    resultPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function norm(s) { return (s||'').replace(/\.[A-Za-z0-9]{2,4}$/,'').trim(); }

  /* ---------- 交互 ---------- */
  pickBtn.onclick = (e) => { e.stopPropagation(); fileInput.click(); };
  dz.onclick = () => fileInput.click();
  fileInput.onchange = (e) => { const list = Array.from(e.target.files || []); fileInput.value = ''; enqueue(list); };

  ['dragenter','dragover'].forEach(ev => dz.addEventListener(ev, (e)=>{ e.preventDefault(); if (window.__dzResetTilt) window.__dzResetTilt(); dz.classList.add('drag'); }));
  ['dragleave','drop'].forEach(ev => dz.addEventListener(ev, (e)=>{ e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', async (e) => {
    const dt = e.dataTransfer;
    if (!dt) return;
    // 同步抓取拖拽入口（事件返回后 items 即失效），支持整个文件夹拖入并递归展开
    const entries = dt.items ? Array.from(dt.items, (it) => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean) : [];
    if (!entries.some((en) => en.isDirectory)) {
      const list = dt.files;
      if (list && list.length) enqueue(Array.from(list));
      return;
    }
    const files = [];
    const walk = (entry) => new Promise((resolve) => {
      if (entry.isFile) {
        entry.file((f) => { files.push(f); resolve(); }, () => resolve());
        return;
      }
      const reader = entry.createReader();
      const step = () => reader.readEntries(async (batch) => {
        if (!batch.length) return resolve();   // readEntries 单批最多 100 条，读到空批才算遍历完
        for (const en of batch) await walk(en);
        step();
      }, () => resolve());
      step();
    });
    for (const en of entries) await walk(en);
    if (files.length) enqueue(files);
  });

  playBtn.onclick = () => {
    ensureAudio();               // 在用户手势内建立音频管线并唤醒上下文
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    if (player.src) player.play();
  };
  dlBtn.onclick = () => {
    if (!currentId) return;
    const a = document.createElement('a');
    a.href = '/api/audio?id=' + currentId + '&dl=1';
    a.download = dlBtn.dataset.name || 'audio';
    a.click();
  };
  againBtn.onclick = () => {
    resultPanel.hidden = true; playerBar.hidden = true; player.pause(); player.src='';
    pTrack.style.setProperty('--p', '0%');
    tCur.textContent = '0:00'; tDur.textContent = '--:--';
    setTitle(TITLE_DEFAULT);
  };
  clearBtn.onclick = () => {
    for (let i = queue.length - 1; i >= 0; i--) {
      const s = queue[i].status;
      if (s === 'done' || s === 'fail') { queue[i].el.remove(); queue.splice(i, 1); }
    }
    if (!queue.length) { queuePanel.hidden = true; setTitle(TITLE_DEFAULT); }
    refreshSummary();
  };

  // 播放态联动：均衡器全幅跳动 + 专辑变黑胶旋转 + 声波切到真实频谱
  player.addEventListener('play', () => {
    document.body.classList.add('playing'); resultPanel.classList.add('playing');
    if (waveSetLive) waveSetLive(true);
  });
  ['pause', 'ended'].forEach(ev => player.addEventListener(ev, () => {
    document.body.classList.remove('playing'); resultPanel.classList.remove('playing');
    if (waveSetLive) waveSetLive(false);
  }));

  /* ---------- 自定义玻璃播放器条 ---------- */
  const fmtT = (s) => { if (!isFinite(s)) return '--:--'; s = Math.max(0, s | 0);
    return ((s / 60) | 0) + ':' + String(s % 60).padStart(2, '0'); };

  function renderProgress() {
    const d = player.duration;
    const p = isFinite(d) && d > 0 ? Math.min(100, player.currentTime / d * 100) : 0;
    pTrack.style.setProperty('--p', p.toFixed(2) + '%');
    tCur.textContent = fmtT(player.currentTime);
    pTrack.setAttribute('aria-valuenow', String(Math.round(p)));
  }
  player.addEventListener('timeupdate', renderProgress);
  player.addEventListener('loadedmetadata', () => { tDur.textContent = fmtT(player.duration); });

  ppBtn.onclick = () => {
    ensureAudio();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    if (player.paused) player.play(); else player.pause();
  };

  // 进度条：点击/拖拽定位，键盘左右各跳 5 秒
  let seeking = false;
  function seekTo(clientX) {
    const r = pTrack.getBoundingClientRect();
    if (!r.width || !isFinite(player.duration) || !player.duration) return;
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    try { player.currentTime = ratio * player.duration; } catch (_) {}
    renderProgress();
  }
  pTrack.addEventListener('pointerdown', (e) => {
    seeking = true; pTrack.classList.add('seeking');
    pTrack.setPointerCapture(e.pointerId); seekTo(e.clientX);
  });
  pTrack.addEventListener('pointermove', (e) => { if (seeking) seekTo(e.clientX); });
  ['pointerup', 'pointercancel'].forEach((ev) => pTrack.addEventListener(ev, () => {
    seeking = false; pTrack.classList.remove('seeking');
  }));
  pTrack.addEventListener('keydown', (e) => {
    if (!isFinite(player.duration)) return;
    if (e.key === 'ArrowRight') { player.currentTime = Math.min(player.duration, player.currentTime + 5); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { player.currentTime = Math.max(0, player.currentTime - 5); e.preventDefault(); }
    else if (e.key === ' ') { if (player.paused) player.play(); else player.pause(); e.preventDefault(); }
  });

  initFX();
  initTilt();
  initWave();
})();
