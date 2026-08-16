'use strict';
/*
 * test-bootstrap.js —— 在沙箱（无显示器）里用 mock 顶替 electron/net，
 * 实跑 main.js 的启动编排（bootstrap）：验证
 *   1) 启动页立即加载（splash.html）
 *   2) 缺 Key 时「不阻塞」：直接进 dsh Web UI（loadURL）
 *   3) 进 dsh 后弹一次非阻塞引导（showMessageBox）
 *   4) 用户点「现在填写」→ 打开 key.html 引导页
 *   5) 保存 Key 后重启 dsh 并切回 Web UI（loadURL 再次触发）
 *   6) 整个流程不抛错、不弹 errorBox
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
let messageBoxCalls = [];
const ipcHandlers = {};

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
    // 模拟用户点了「现在填写」(response=0) → 打开引导页
    showMessageBox: (parent, opts) => {
      messageBoxCalls.push(opts);
      return Promise.resolve({ response: 0 });
    }
  },
  ipcMain: {
    handle: (ch, fn) => { ipcHandlers[ch] = fn; },
    on: () => {}
  },
  Menu: { buildFromTemplate: (t) => t, setApplicationMenu: () => {} }
};

// 拦截 net：让 checkPort 永远成功（模拟 dsh 已在运行），从而启动直接进 Web UI
const fakeNet = {
  Socket: class {
    setTimeout() {}
    on() { return this; }
    once(ev, cb) { if (ev === 'connect') setImmediate(() => cb()); return this; }
    connect() { return this; }
    destroy() {}
  }
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
  if (id === 'net') return fakeNet;
  if (id === 'electron-updater') return { autoUpdater: { on() {}, checkForUpdates: () => Promise.resolve() } };
  if (id === './harness-manager') {
    return { ensureHarness: async () => null, detectEnv: () => ({ platform: 'win', arch: 'x64' }) };
  }
  return origRequire.apply(this, arguments);
};

process.on('uncaughtException', (e) => { threw = e; });

try {
  require('./main.js'); // 触发 app.whenReady().then(bootstrap)
} catch (e) {
  threw = e;
}

function dshLoaded() {
  return events.some((e) => e[0] === 'loadURL' && String(e[1]).includes('127.0.0.1:3080'));
}

setTimeout(() => {
  console.log('--- 启动流程事件（首次启动、缺 Key） ---');
  console.log('splash.html 已加载 :', splashLoaded);
  console.log('已进入 dsh Web UI  :', dshLoaded());
  console.log('非阻塞引导已弹出   :', messageBoxCalls.length > 0);
  console.log('key.html 已加载    :', keyLoaded);
  console.log('状态推送序列       :', JSON.stringify(events.filter((e) => e[0] === 'send:harness:status-text').map((e) => e[1])));
  console.log('是否抛错           :', threw ? (threw.stack || threw.message) : '无');
  console.log('errorBox 触发      :', events.some((e) => e[0] === 'errorBox'));

  const phase1 = splashLoaded && dshLoaded() && messageBoxCalls.length > 0 && keyLoaded && !threw && !events.some((e) => e[0] === 'errorBox');
  console.log(phase1 ? '\n✅ 阶段1(启动不阻塞+引导) PASSED' : '\n❌ 阶段1 FAILED');

  // 阶段2：保存 Key → 应重启 dsh 并再次切回 Web UI
  const loadUrlBefore = events.filter((e) => e[0] === 'loadURL').length;
  const saveHandler = ipcHandlers['harness:saveKey'];
  if (!saveHandler) {
    console.log('\n❌ 阶段2 FAILED: 未注册 harness:saveKey');
    process.exit(phase1 ? 0 : 1);
  }
  saveHandler(null, 'sk-' + 'x'.repeat(40)).then((res) => {
    setTimeout(() => {
      const loadUrlAfter = events.filter((e) => e[0] === 'loadURL').length;
      console.log('\n--- 保存 Key 后 ---');
      console.log('saveKey 返回       :', JSON.stringify(res));
      console.log('再次切回 dsh(loadURL 增加):', loadUrlAfter > loadUrlBefore, `(${loadUrlBefore} -> ${loadUrlAfter})`);
      console.log('是否抛错           :', threw ? (threw.stack || threw.message) : '无');
      const phase2 = res && res.ok && loadUrlAfter > loadUrlBefore && !threw;
      console.log(phase2 ? '\n✅ 阶段2(保存Key重启) PASSED' : '\n❌ 阶段2 FAILED');
      const ok = phase1 && phase2;
      console.log(ok ? '\n✅ BOOTSTRAP TEST PASSED' : '\n❌ BOOTSTRAP TEST FAILED');
      process.exit(ok ? 0 : 1);
    }, 700);
  });
}, 400);
