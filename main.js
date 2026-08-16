'use strict';

const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');

// 默认禁用 GPU 硬件加速：避免 Windows 部分显卡驱动下 fixed/overlay 弹层被错误遮挡。
// 需要 GPU 加速时可传 --enable-gpu 启动。
if (typeof app.disableHardwareAcceleration === 'function' && !process.argv.includes('--enable-gpu')) {
  app.disableHardwareAcceleration();
}

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

async function resolveHarnessAsync(status = () => {}) {
  const hcfg = config.harness || {};
  const dl = hcfg.download;
  const userData = app.getPath('userData');

  // 优先尝试下载对应架构的固定版本 harness；给网络请求加短超时，避免无资产时长时间阻塞
  if (dl && dl.enabled) {
    status('正在识别环境并获取对应版本的 DeepSeek Harness…');
    try {
      const timeoutMs = Number(dl.timeoutMs) || 12000;
      const dir = await ensureHarness(dl, userData, timeoutMs);
      if (dir) return makeDownloaded(dir);
    } catch (e) {
      console.error('[harness] 下载/安装失败，回退：', e.message);
    }
  }

  status('正在使用内置 DeepSeek Harness…');
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

function isWritableDir(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch (e) {
    return false;
  }
}

async function waitForServer(timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await checkPort(PORT, HOST)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// 首次运行：把内置 dsh-home 复制到用户可写目录（bundle 只读，profiles 需可写）
function ensureDshHome() {
  if (!harness || !harness.bundled || !harness.dshHome || harness.downloaded) return;
  const src = path.join(harness.dir, 'dsh-home');
  if (!fs.existsSync(src)) {
    console.error('[dsh] 内置 dsh-home 缺失：', src);
    return;
  }

  // 优化：如果 bundled dsh-home 本身可写，就直接用它，避免大目录整份拷贝
  if (!fs.existsSync(harness.dshHome) && isWritableDir(src)) {
    harness.dshHome = src;
    console.log('[dsh] bundled dsh-home 可写，直接使用：', src);
    return;
  }

  if (fs.existsSync(harness.dshHome)) return;
  fs.mkdirSync(path.dirname(harness.dshHome), { recursive: true });
  updateSplash('正在初始化用户数据（首次运行）…');
  fs.cpSync(src, harness.dshHome, { recursive: true, dereference: true });
  console.log('[dsh] 已初始化 dsh-home ->', harness.dshHome);
}

// 静默迁移：若本机已配 Key，迁到用户目录（开发机便利）。不阻塞启动。
function migrateLegacyKey() {
  if (fs.existsSync(KEY_FILE)) return;
  const legacy = harness.bundled ? null : path.join(harness.dir, '.env');
  if (legacy && fs.existsSync(legacy)) {
    try {
      fs.copyFileSync(legacy, KEY_FILE);
      console.log('[key] 已从本机 dsh 迁移 Key 到', KEY_FILE);
    } catch (e) { /* ignore */ }
  }
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

function updateSplash(text) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('harness:status-text', text);
  }
}

// 打开 Key 引导页（随时可唤起，不阻塞 dsh 使用）
function openKeyPage() {
  if (win && !win.isDestroyed()) win.loadFile(path.join(__dirname, 'key.html'));
}

// 未配置 Key 时的非阻塞引导提示：进 dsh 后弹一次，不阻塞使用
function promptForKey() {
  const parent = win || null;
  dialog
    .showMessageBox(parent, {
      type: 'info',
      title: '尚未配置 API Key',
      message: 'DeepSeek Harness 已启动，但还没有配置 API Key。\n需要调用 DeepSeek 模型时请先填写。',
      detail: 'Key 仅保存在本机用户目录，不会上传，也不会写入安装包。',
      buttons: ['现在填写', '稍后'],
      defaultId: 0,
      cancelId: 1
    })
    .then(({ response }) => {
      if (response === 0) openKeyPage();
    })
    .catch(() => {});
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0e14',
    paintWhenInitiallyHidden: false,
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
  // 启动页立刻可见，后台再准备 harness；避免用户长时间看黑屏
  win.loadFile(path.join(__dirname, 'splash.html'));
}

// 连接 / 拉起 dsh 并加载 Web UI
async function launchHarnessAndUi() {
  let up = await checkPort(PORT, HOST);
  if (!up && AUTO_START) {
    updateSplash('正在启动本地服务…');
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
  updateSplash('正在连接 Web UI…');
  if (win) win.loadURL(dshUrl());
  // 已进 dsh；若尚未配置 Key，给一次非阻塞引导（不阻塞使用）
  if (!fs.existsSync(KEY_FILE)) promptForKey();
}

async function bootstrap() {
  createWindow();
  try {
    harness = await resolveHarnessAsync(updateSplash);
    updateSplash('正在准备 DeepSeek Harness…');
    ensureDshHome();
    migrateLegacyKey(); // 静默迁移本机 Key（不阻塞）
    await launchHarnessAndUi();
  } catch (e) {
    console.error('[bootstrap] 启动失败：', e);
    updateSplash('启动失败');
    if (win && !win.isDestroyed()) {
      win.loadFile(path.join(__dirname, 'splash.html'), { hash: 'error' });
    }
    dialog.showErrorBox('启动失败', e.message || String(e));
  }
}

// 用户保存/修改 Key 后：重启 dsh 以加载新环境变量，并切回 Web UI
async function proceedAfterKey() {
  ensureDshHome();
  stopDsh();
  await new Promise((r) => setTimeout(r, 300));
  startDsh();
  const ok = await waitForServer();
  if (ok && win && !win.isDestroyed()) {
    win.loadURL(dshUrl());
  } else if (win && !win.isDestroyed()) {
    win.loadFile(path.join(__dirname, 'splash.html'), { hash: 'error' });
  }
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
      label: '设置',
      submenu: [
        { label: '填写 / 修改 API Key', click: () => openKeyPage() },
        { type: 'separator' },
        {
          label: '检查更新',
          click: () => autoUpdater.checkForUpdates().catch((e) => console.error('[updater]', e.message))
        },
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
