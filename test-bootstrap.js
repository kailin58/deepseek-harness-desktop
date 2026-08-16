'use strict';
/*
 * test-bootstrap.js —— 在沙箱（无显示器）里用 mock 顶替 electron，
 * 实跑 main.js 的启动编排（bootstrap）：验证
 *   1) 启动页立即加载（splash.html）
 *   2) 状态文本通过 IPC 推送（harness:status-text）
 *   3) 缺 Key 时跳到 key.html（首次使用引导）
 *   4) 整个流程不抛错
 * 不依赖网络/真实窗口。
 */
const Module = require('module');
const os = require('os');
const fs = require('fs');
const path = require('path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dhb-'));
// 不创建 .env → 模拟「首次使用、还没有 Key」

const events = [];
let splashLoaded = false;
let keyLoaded = false;
let threw = null;

const fakeElectron = {
  app: {
    isPackaged: false,
    getVersion: () => '0.1.0',
    getPath: () => userData,
    whenReady: () => Promise.resolve(),
    on: () => {},
    quit: () => {}
  },
  BrowserWindow: class {
    constructor() {
      this.webContents = {
        send: (ch, ...a) => events.push(['send:' + ch, ...a]),
        on: () => {}
      };
      this._destroyed = false;
    }
    loadFile(p) {
      if (p.includes('splash.html')) splashLoaded = true;
      if (p.includes('key.html')) keyLoaded = true;
      events.push(['loadFile', p]);
    }
    loadURL(u) { events.push(['loadURL', u]); }
    show() {}
    on() {}
    once(ev, cb) { if (typeof cb === 'function') cb(); }
    isDestroyed() { return this._destroyed; }
  },
  dialog: {
    showErrorBox: (t, m) => events.push(['errorBox', t, m]),
    showMessageBox: () => Promise.resolve({ response: 1 })
  },
  ipcMain: { handle: () => {}, on: () => {} },
  Menu: { buildFromTemplate: (t) => t, setApplicationMenu: () => {} }
};

const emptyHarnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dhk-'));
const origReadFileSync = fs.readFileSync;
fs.readFileSync = function (p, ...rest) {
  if (typeof p === 'string' && p.endsWith('config.json')) {
    return JSON.stringify({
      harnessMode: 'auto',
      harnessDir: emptyHarnessDir,
      port: 3080,
      host: '127.0.0.1',
      autoStart: true,
      harness: {
        harnessDir: emptyHarnessDir,
        download: { enabled: true, owner: 'kailin58', repo: 'deepseek-harness-desktop', version: '0.1.0', tag: 'harness-v0.1.0' }
      }
    });
  }
  return origReadFileSync.apply(this, arguments);
};

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'electron') return fakeElectron;
  if (id === 'electron-updater') return { autoUpdater: { on() {}, checkForUpdates: () => Promise.resolve() } };
  if (id === './harness-manager') {
    // 模拟「下载被禁用/失败」→ 直接回退，避免联网
    return { ensureHarness: async () => null, detectEnv: () => ({ platform: 'win', arch: 'x64' }) };
  }
  return origRequire.apply(this, arguments);
};

process.on('uncaughtException', (e) => { threw = e; });

try {
  require('./main.js');
} catch (e) {
  threw = e;
}

setTimeout(() => {
  const statusTexts = events.filter((e) => e[0] === 'send:harness:status-text').map((e) => e[1]);
  console.log('--- 启动流程事件 ---');
  console.log('splash.html 已加载 :', splashLoaded);
  console.log('key.html 已加载    :', keyLoaded);
  console.log('状态推送序列       :', JSON.stringify(statusTexts));
  console.log('是否抛错           :', threw ? threw.stack || threw.message : '无');
  console.log('errorBox 触发      :', events.some((e) => e[0] === 'errorBox'));

  const ok = splashLoaded && keyLoaded && statusTexts.length >= 2 && !threw && !events.some((e) => e[0] === 'errorBox');
  console.log(ok ? '\n✅ BOOTSTRAP TEST PASSED' : '\n❌ BOOTSTRAP TEST FAILED');
  process.exit(ok ? 0 : 1);
}, 300);
