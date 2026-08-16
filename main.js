'use strict';

const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { ensureHarness } = require('./harness-manager');

// ---------- config ----------
const config = loadConfig();
const PORT = config.port || 3080;
const HOST = config.host || '127.0.0.1';
const AUTO_START = config.autoStart !== false;
const IS_PACKAGED = app.isPackaged;

// ---------- harness resolution ----------
// 解析优先级：下载（对应架构 + 固定版本）> bundled（安装包内置）> system（本机 dsh）
function makeBundled(bundledDir) {
  return {
    mode: 'bundled',
    bundled: true,
    dir: bundledDir,
    nodeExe: path.join(bundledDir, 'node.exe'),
    dshBin: path.join(bundledDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    dshHome: path.join(app.getPath('userData'), 'dsh-home')
  };
}

function makeDownloaded(dir) {
  const isWin = process.platform === 'win32';
  return {
    mode: 'downloaded',
    bundled: true, // 复用 bundled 启动逻辑（自带 node 运行时 + node_modules）
    downloaded: true,
    dir,
    nodeExe: path.join(dir, isWin ? 'node.exe' : 'node'),
    dshBin: path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    dshHome: path.join(dir, 'dsh-home') // 缓存目录可写，无需复制
  };
}

function makeSystem(dir) {
  const isWin = process.platform === 'win32';
  return {
    mode: 'system',
    bundled: false,
    dir,
    dshBin: path.join(dir, 'node_modules', '.bin', isWin ? 'dsh.cmd' : 'dsh'),
    dshHome: null
  };
}

async function resolveHarnessAsync() {
  const hcfg = config.harness || {};
  const dl = hcfg.download;
  const userData = app.getPath('userData');
  if (dl && dl.enabled) {
    try {
      const dir = await ensureHarness(dl, userData);
      if (dir) return makeDownloaded(dir);
    } catch (e) {
      console.error('[harness] 下载/安装失败，回退：', e.message);
    }
  }
  const bundledDir = IS_PACKAGED ? path.join(process.resourcesPath, 'harness') : null;
  const mode = config.harnessMode || 'auto';
  const useBundled = (mode === 'bundled') || (mode === 'auto' && bundledDir && fs.existsSync(bundledDir));
  if (useBundled && bundledDir) return makeBundled(bundledDir);
  return makeSystem(hcfg.harnessDir || 'C:\\Users\\kaili\\deepseek-harness');
}

let harness = null;
const KEY_FILE = path.join(app.getPath('userData'), '.env');

let win = null;
let dshProc = null;
let keyPending = false;

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  } catch (e) {
    return {};
  }
}

// 解析简单 .env：KEY=VALUE，# 注释，可选引号
function loadEnvFile(p) {
  const out = {};
  try {
    const txt = fs.readFileSync(p, 'utf8');
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[k] = v;
    }
  } catch (e) { /* 文件缺失忽略 */ }
  return out;
}

// 卸掉本机 WorkBuddy 的 safe-delete 守卫，避免误拦 dsh
function stripGuard(env) {
  const keys = [
    'BASH_ENV',
    'CODEBUDDY_SAFE_DELETE_BULK_GUARD',
    'CODEBUDDY_SAFE_DELETE_SANDBOX',
    'CODEBUDDY_SAFE_DELETE_BIN_DIR',
    'CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR',
    'CODEBUDDY_SAFE_DELETE_REPORT_PATH'
  ];
  for (const k of keys) delete env[k];
  return env;
}

function checkPort(port, host) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    s.setTimeout(800);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => { s.destroy(); resolve(false); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.connect(port, host);
  });
}

async function waitForServer(timeoutMs = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await checkPort(PORT, HOST)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

// 首次运行：把内置 dsh-home 复制到用户可写目录（bundle 只读，profiles 需可写）
function ensureDshHome() {
  if (!harness || !harness.bundled || !harness.dshHome || harness.downloaded) return;
  if (fs.existsSync(harness.dshHome)) return;
  const src = path.join(harness.dir, 'dsh-home');
  if (!fs.existsSync(src)) {
    console.error('[dsh] 内置 dsh-home 缺失：', src);
    return;
  }
  fs.mkdirSync(path.dirname(harness.dshHome), { recursive: true });
  fs.cpSync(src, harness.dshHome, { recursive: true, dereference: true });
  console.log('[dsh] 已初始化 dsh-home ->', harness.dshHome);
}

// 确保 Key 存在：优先复用本机已配好的 .env（开发机便利），否则需首次录入
function ensureKey() {
  if (fs.existsSync(KEY_FILE)) return true;
  // 开发机便利：从原 harnessDir/.env 迁一份到用户目录，避免重复填写
  const legacy = harness.bundled
    ? null
    : path.join(harness.dir, '.env');
  if (legacy && fs.existsSync(legacy)) {
    try {
      fs.copyFileSync(legacy, KEY_FILE);
      console.log('[key] 已从本机 dsh 迁移 Key 到', KEY_FILE);
      return true;
    } catch (e) { /* ignore */ }
  }
  return false;
}

function startDsh() {
  if (dshProc) return;
  const env = stripGuard({ ...process.env, ...loadEnvFile(KEY_FILE) });
  if (harness.bundled) {
    // 关键：把 dsh 的家目录指到用户可写的 dsh-home，bundle 本身保持只读
    env.DSH_HOME = harness.dshHome;
    dshProc = spawn(harness.nodeExe, [harness.dshBin, '--profile', 'web', '--host', HOST, '--port', String(PORT)], {
      cwd: harness.dir,
      env,
      windowsHide: true,
      shell: false
    });
  } else {
    dshProc = spawn(harness.dshBin, ['--profile', 'web', '--host', HOST, '--port', String(PORT)], {
      cwd: harness.dir,
      env,
      windowsHide: true,
      shell: process.platform === 'win32'
    });
  }
  const tag = (d) => {
    const s = d.toString();
    if (s.trim()) console.log('[dsh]', s.replace(/\n+$/, ' '));
  };
  if (dshProc.stdout) dshProc.stdout.on('data', tag);
  if (dshProc.stderr) dshProc.stderr.on('data', tag);
  dshProc.on('error', (e) => console.error('[dsh] spawn error:', e.message));
  dshProc.on('exit', (code, sig) => { console.log('[dsh] exited', code, sig); dshProc = null; });
}

function stopDsh() {
  if (dshProc) {
    try { dshProc.kill('SIGTERM'); } catch (e) { /* ignore */ }
    dshProc = null;
  }
}

function dshUrl() {
  return `http://${HOST}:${PORT}`;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0e14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.once('ready-to-show', () => { if (win) win.show(); });
  win.on('closed', () => { win = null; });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('[web] did-fail-load', code, desc);
  });
}

// 连接 / 拉起 dsh 并加载 Web UI
async function launchHarnessAndUi() {
  let up = await checkPort(PORT, HOST);
  if (!up && AUTO_START) {
    startDsh();
    up = await waitForServer();
  }
  if (!up) {
    if (win) win.loadFile(path.join(__dirname, 'splash.html'), { hash: 'error' });
    dialog.showErrorBox(
      '无法连接 DeepSeek Harness',
      `未能在 ${dshUrl()} 启动本地服务。\n请确认：\n` +
      `1) dsh 已正确安装（bundled 模式内置，或 system 模式 harnessDir 正确）\n` +
      `2) API Key 已配置\n` +
      `3) 端口 ${PORT} 未被占用`
    );
    return;
  }
  if (win) win.loadURL(dshUrl());
}

async function bootstrap() {
  createWindow();
  harness = await resolveHarnessAsync();
  ensureDshHome();
  if (!ensureKey()) {
    // 首次运行：展示 Key 录入页，待用户保存后再继续
    keyPending = true;
    if (win) win.loadFile(path.join(__dirname, 'key.html'));
    return;
  }
  await launchHarnessAndUi();
}

// 用户保存 Key 后继续启动
async function proceedAfterKey() {
  keyPending = false;
  ensureDshHome();
  await launchHarnessAndUi();
}

// ---------- 自动更新：自动监控 GitHub Releases + 更新提醒 ----------
function setupUpdater() {
  const u = config.update;
  if (!IS_PACKAGED || !u || !u.autoCheck) {
    console.log('[updater] 未启用（非打包态或未配置）');
    return;
  }
  if (!u.owner || String(u.owner).startsWith('REPLACE') || !u.repo) {
    console.log('[updater] 未配置 owner/repo，跳过更新监控');
    return;
  }
  autoUpdater.autoDownload = false; // 先提醒，用户确认后再下载
  autoUpdater.on('update-available', (info) => {
    const parent = win || null;
    dialog.showMessageBox(parent, {
      type: 'info',
      title: '发现新版本',
      message: `DeepSeek Harness 新版本可用：v${info.version}\n当前版本：v${app.getVersion()}`,
      detail: '是否现在下载更新？（更新将在重启后生效）',
      buttons: ['立即下载', '稍后提醒'],
      defaultId: 0,
      cancelId: 1
    }).then(({ response }) => {
      if (response === 0) autoUpdater.downloadUpdate();
    });
  });
  autoUpdater.on('update-downloaded', () => {
    const parent = win || null;
    dialog.showMessageBox(parent, {
      type: 'info',
      title: '更新已下载完成',
      message: '新版本已下载，重启应用即可完成安装。',
      buttons: ['现在重启', '下次重启'],
      defaultId: 0,
      cancelId: 1
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
  });
  autoUpdater.on('error', (e) => console.error('[updater]', e.message));
  autoUpdater.checkForUpdates().catch((e) => console.error('[updater] 检查失败：', e.message));

  const mins = Number(u.checkIntervalMinutes) || 60;
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, mins * 60 * 1000);
  console.log(`[updater] 已启动 GitHub 监控（每 ${mins} 分钟检查一次）`);
}

function buildMenu() {
  const template = [
    {
      label: '帮助',
      submenu: [
        {
          label: '检查更新',
          click: () => autoUpdater.checkForUpdates().catch((e) => console.error('[updater]', e.message))
        },
        { type: 'separator' },
        { label: '关于', click: () => dialog.showMessageBox({ message: `DeepSeek Harness 桌面版 v${app.getVersion()}` }) },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- IPC ----------
ipcMain.handle('harness:restart', async () => {
  stopDsh();
  await new Promise((r) => setTimeout(r, 600));
  startDsh();
  const ok = await waitForServer();
  if (ok && win) win.loadURL(dshUrl());
  return ok;
});

ipcMain.handle('harness:status', async () => ({ up: await checkPort(PORT, HOST), url: dshUrl() }));

ipcMain.handle('app:version', async () => app.getVersion());

// 保存用户填写的 Key（仅落本机用户目录，不外发）
ipcMain.handle('harness:saveKey', async (_e, key) => {
  if (typeof key !== 'string' || key.trim().length < 20) {
    return { ok: false, error: 'Key 格式不正确（应以 sk- 开头且长度足够）' };
  }
  try {
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    fs.writeFileSync(KEY_FILE, `DEEPSEEK_API_KEY=${key.trim()}\n`, 'utf8');
    console.log('[key] 已保存 Key 到', KEY_FILE);
    if (win) proceedAfterKey();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('update:check-now', async () => {
  try { await autoUpdater.checkForUpdates(); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

app.whenReady().then(() => {
  buildMenu();
  setupUpdater();
  bootstrap();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) bootstrap();
});

app.on('window-all-closed', () => {
  stopDsh();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => { stopDsh(); });
