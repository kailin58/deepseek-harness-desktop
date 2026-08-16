'use strict';
/*
 * harness-manager.js
 * 环境感知的 DeepSeek Harness 获取模块（「对应安装」核心）。
 *
 *   detectEnv()     识别本机 OS / CPU 架构 / 是否装了 Node / 是否装了 dsh / 系统运行时依赖
 *   ensureHarness() 按「固定版本 + 对应架构」从配置的 GitHub Release 下载 zip，
 *                   解压到用户目录缓存（harness-cache/<version>-<arch>）；
 *                   已缓存且版本/架构匹配则直接复用；离线或下载失败返回 null，
 *                   由调用方回退到 bundled（安装包内置）或 system（本机 dsh）。
 *
 * 设计要点：
 *   - 依赖零额外 npm 包：下载用内置 https，解压用系统原生工具（win: tar/Expand-Archive，
 *     mac/linux: unzip/tar）。
 *   - 版本与架构双锁：缓存目录以 version-arch 命名，避免跨机/跨架构串味。
 *   - 仅下载固定版本（config 锁定），确定性、可复现、易回滚。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawnSync } = require('child_process');

// ---------- 小工具 ----------
function runCmd(cmd, args, opts) {
  try {
    const r = spawnSync(cmd, args, Object.assign({ windowsHide: true, encoding: 'utf8' }, opts || {}));
    if (r.error) return null;
    return (r.stdout || '').trim();
  } catch (e) {
    return null;
  }
}

function normalizePlatform() {
  const p = process.platform;
  if (p === 'win32') return 'win';
  if (p === 'darwin') return 'mac';
  if (p === 'linux') return 'linux';
  return String(p);
}

function normalizeArch() {
  const a = process.arch;
  if (a === 'x64') return 'x64';
  if (a === 'arm64') return 'arm64';
  return String(a);
}

// ---------- 环境检测（「识别电脑安装环境」） ----------
function detectNode() {
  const v = runCmd('node', ['-v']);
  if (v && /^v?\d+\.\d+/.test(v)) {
    const semver = v.replace(/^v/, '');
    const major = parseInt(semver.split('.')[0], 10);
    return { hasNode: true, nodeVersion: semver, nodeMajor: major, nodeOk: major >= 18 };
  }
  return { hasNode: false, nodeVersion: null, nodeMajor: null, nodeOk: false };
}

function detectDsh() {
  return !!runCmd('dsh', ['--version']);
}

function detectRuntimes() {
  const missing = [];
  if (process.platform === 'win32') {
    // 轻量检查：Visual C++ 运行库（多数原生 Node 扩展依赖）
    const dll = 'C:\\Windows\\System32\\vcruntime140.dll';
    if (!fs.existsSync(dll)) missing.push('Visual C++ Redistributable (vcruntime140.dll)');
  }
  return missing;
}

function detectEnv() {
  const node = detectNode();
  return {
    platform: normalizePlatform(),
    arch: normalizeArch(),
    ...node,
    hasDsh: detectDsh(),
    dshVersion: null, // 可选，预留
    missingRuntimes: detectRuntimes()
  };
}

// ---------- 资产解析 ----------
function assetName(version, env) {
  return `deepseek-harness-${version}-${env.platform}-${env.arch}.zip`;
}

function resolveAssetUrl(cfg, version, env) {
  const name = assetName(version, env);
  if (cfg.assetBaseUrl) {
    return `${String(cfg.assetBaseUrl).replace(/\/$/, '')}/${name}`;
  }
  const owner = cfg.owner || 'kailin58';
  const repo = cfg.repo || 'deepseek-harness-desktop';
  const tag = cfg.tag || `v${version}`;
  return `https://github.com/${owner}/${repo}/releases/download/${tag}/${name}`;
}

// ---------- 下载（支持重定向） ----------
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const doGet = (u, hops) => {
      if (hops > 6) return reject(new Error('重定向次数过多'));
      const mod = u.startsWith('https:') ? https : http;
      mod
        .get(u, { headers: { 'User-Agent': 'deepseek-harness-desktop' } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return doGet(new URL(res.headers.location, u).href, hops + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`下载失败：HTTP ${res.statusCode}`));
          }
          const f = fs.createWriteStream(dest);
          res.pipe(f);
          f.on('finish', () => f.close(() => resolve(dest)));
          f.on('error', (e) => reject(e));
        })
        .on('error', (e) => reject(e));
    };
    doGet(url, 0);
  });
}

// ---------- 解压（系统原生） ----------
function nodeBinName() {
  return process.platform === 'win32' ? 'node.exe' : 'node';
}

function commonBase(a, b) {
  const ap = path.resolve(a).split(path.sep);
  const bp = path.resolve(b).split(path.sep);
  let i = 0;
  while (i < ap.length && i < bp.length && ap[i].toLowerCase() === bp[i].toLowerCase()) i++;
  return ap.slice(0, i).join(path.sep) || path.sep;
}

function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  let r;
  let cmd = '';
  if (process.platform === 'win32') {
    // bsdtar 的 -f / -C 不接受带盘符的绝对路径（会误判为远程主机），
    // 故统一改用「相对路径 + 公共基目录 cwd」，且 tar 比 PowerShell 更可移植。
    const base = commonBase(zipPath, destDir);
    const relZip = path.relative(base, zipPath);
    const relDest = path.relative(base, destDir);
    cmd = `tar -xf ${relZip} -C ${relDest}`;
    r = spawnSync('tar', ['-xf', relZip, '-C', relDest], { cwd: base, windowsHide: true });
  } else {
    r = spawnSync('unzip', ['-o', zipPath, '-d', destDir], { windowsHide: true });
    if (r.status !== 0) {
      cmd = `tar -xf ${zipPath} -C ${destDir}`;
      r = spawnSync('tar', ['-xf', zipPath, '-C', destDir], { windowsHide: true });
    }
  }
  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || '').toString();
    console.error('[extractZip] status=', r.status, '\ncmd=', cmd, '\nstderr=', (r.stderr || '').toString(), '\nstdout=', (r.stdout || '').toString());
    throw new Error(`解压失败：${msg}`);
  }
}

// ---------- 主入口 ----------
async function ensureHarness(cfg, userDataDir) {
  if (!cfg || !cfg.enabled) return null;
  const env = detectEnv();
  const version = cfg.version;
  if (!version) {
    console.error('[harness] 未配置版本，跳过下载');
    return null;
  }
  const cacheKey = `${version}-${env.arch}`;
  const harnessDir = path.join(userDataDir, 'harness-cache', cacheKey);
  const marker = path.join(harnessDir, '.harness-version');

  // 1) 命中本地缓存：版本 + 架构一致且关键文件存在 → 直接复用（无网络）
  if (fs.existsSync(marker)) {
    try {
      const rec = JSON.parse(fs.readFileSync(marker, 'utf8'));
      const nodeBin = path.join(harnessDir, nodeBinName());
      if (rec.version === version && rec.arch === env.arch && fs.existsSync(nodeBin)) {
        console.log('[harness] 命中本地缓存：', harnessDir);
        return harnessDir;
      }
    } catch (e) {
      /* 标记损坏 → 重新下载 */
    }
  }

  // 2) 下载对应架构 + 固定版本的 harness
  const url = resolveAssetUrl(cfg, version, env);
  const tmpZip = path.join(userDataDir, 'harness-cache', `.dl-${cacheKey}.zip`);
  fs.mkdirSync(path.dirname(tmpZip), { recursive: true });
  console.log('[harness] 检测环境：', JSON.stringify(env));
  console.log('[harness] 下载对应 harness：', url);
  try {
    await downloadFile(url, tmpZip);
  } catch (e) {
    console.error('[harness] 下载失败，回退 bundled/system：', e.message);
    return null;
  }

  // 3) 解压到缓存目录
  try {
    fs.rmSync(harnessDir, { recursive: true, force: true });
  } catch (e) {
    /* ignore */
  }
  extractZip(tmpZip, harnessDir);
  try {
    fs.unlinkSync(tmpZip);
  } catch (e) {
    /* ignore */
  }

  // 4) 校验关键文件
  const nodeBin = path.join(harnessDir, nodeBinName());
  const dshBin = path.join(harnessDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!fs.existsSync(nodeBin)) throw new Error('harness 包缺少 node 运行时');
  if (!fs.existsSync(dshBin)) throw new Error('harness 包缺少 dsh launcher');

  fs.writeFileSync(
    marker,
    JSON.stringify(
      { version, arch: env.arch, platform: env.platform, downloadedAt: new Date().toISOString() },
      null,
      2
    )
  );
  console.log('[harness] 已安装对应 harness ->', harnessDir);
  return harnessDir;
}

module.exports = { detectEnv, ensureHarness, assetName, resolveAssetUrl, detectNode, detectDsh, detectRuntimes };
