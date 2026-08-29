'use strict';
// QQ音乐 ekey 自动获取：内存实时抓凭证 + 磁盘缓存兜底 + 歌曲页脚参数 + GetEVkey 接口
const { execFile } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '..', 'ekeycache.json');
const CRED_SCRIPT = path.join(__dirname, '..', 'ekeycred.ps1');
const NATIVE_EXE = path.join(__dirname, '..', 'native', 'qkeycred.exe');

// 凭证一律运行时获取（本机客户端内存）或读磁盘缓存，源码内不存任何真实凭证。
// 三条路径都取不到时返回 null，由上层转成"请手动粘贴 ekey"。

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (_) { return null; }
}
function saveCache(obj) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2)); } catch (_) {}
}

function runCredScript() {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CRED_SCRIPT],
      { timeout: 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        let authst = '', uin = '';
        for (const line of String(stdout).split(/\r?\n/)) {
          if (line.startsWith('AUTHST=')) authst = line.slice(7).trim();
          else if (line.startsWith('UIN=')) uin = line.slice(4).trim();
        }
        resolve(authst ? { authst, uin } : null);
      });
  });
}

// 原生提取器（内嵌 exe，无需 PowerShell）
function runNative() {
  return new Promise((resolve) => {
    execFile(NATIVE_EXE, [], { timeout: 15000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        let authst = '', uin = '';
        for (const line of String(stdout).split(/\r?\n/)) {
          if (line.startsWith('AUTHST=')) authst = line.slice(7).trim();
          else if (line.startsWith('UIN=')) uin = line.slice(4).trim();
        }
        resolve(authst ? { authst, uin } : null);
      });
  });
}

// 返回 { authst, uin }: 实时内存有则用并回写缓存，否则用缓存，都没有返回 null
async function getCredentials() {
  let live = null;
  if (fs.existsSync(NATIVE_EXE)) live = await runNative();
  if (!live) live = await runCredScript();
  if (live && live.authst) {
    saveCache({ authst: live.authst, uin: live.uin, ts: Date.now() });
    return live;
  }
  const c = loadCache();
  if (c && c.authst) return { authst: c.authst, uin: c.uin || '', source: 'cache' };
  return null;
}

function getEkey(info, authst, uin) {
  const payload = {
    comm: { authst, ct: '19', cv: '1859', uin, tmeLoginType: '3' },
    req_1: {
      module: 'music.vkey.GetEVkey', method: 'CgiGetEVkey',
      param: {
        filename: [info.filename], guid: '10000', songmid: [info.mediaMid],
        songtype: [1], uin, loginflag: 1, platform: '27', ctx: 1,
      },
    },
  };
  const data = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: 'u.y.qq.com', path: '/cgi-bin/musicu.fcg', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        Referer: 'https://y.qq.com/',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => {
        try {
          const j = JSON.parse(d);
          const mi = j.req_1 && j.req_1.data && j.req_1.data.midurlinfo && j.req_1.data.midurlinfo[0];
          if (mi && mi.ekey) return resolve(mi.ekey);
          resolve(null);
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

// 综合取钥：凭证内存/缓存 + ekey 接口，找不到返回 null。
// 无客户端的环境可用 QQ_MUSIC_AUTHST / QQ_MUSIC_UIN 环境变量注入，避免把凭证写进源码。
// 取钥是可选增强，任何环节出问题都应静默降级为 null，由上层转"请手动粘贴 ekey"。
// 若把异常抛回 server.js，一次网络抖动会让整次解密请求变成 500。
async function fetchEkey(info) {
  let cred = null;
  try {
    if (process.env.QQ_MUSIC_AUTHST) {
      cred = { authst: process.env.QQ_MUSIC_AUTHST, uin: process.env.QQ_MUSIC_UIN || '', source: 'env' };
    } else {
      cred = await getCredentials();
    }
  } catch (_) {
    cred = null;
  }
  if (!cred || !cred.authst) return null;
  try {
    const ekey = await getEkey(info, cred.authst, cred.uin);
    return ekey || null;
  } catch (_) {
    return null;
  }
}

module.exports = { fetchEkey, getCredentials, getEkey, runCredScript };