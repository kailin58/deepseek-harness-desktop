'use strict';
/*
 * verify-bundle.js  —  无 GUI 验证「内置 bundle 能独立启动 dsh」
 * 逻辑：把 build-resources/harness 当作 <resources>/harness，
 *       复制 dsh-home 到临时 userData，设置 DSH_HOME，拉起内置 node.exe，
 *       轮询端口确认 Web UI 可用。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const HARNESS = path.join(__dirname, 'build-resources', 'harness');
const NODE_EXE = path.join(HARNESS, 'node.exe');
const DSH_BIN = path.join(HARNESS, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const BUNDLED_HOME = path.join(HARNESS, 'dsh-home');
const PORT = 3099;
const HOST = '127.0.0.1';

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

async function waitForServer(timeoutMs = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await checkPort(PORT, HOST)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function main() {
  for (const p of [HARNESS, NODE_EXE, DSH_BIN, BUNDLED_HOME]) {
    if (!fs.existsSync(p)) {
      console.error('[verify] 缺少：', p, '\n请先运行 `npm run bundle` 生成 build-resources/harness');
      process.exit(1);
    }
  }

  // 模拟「首次运行」：把内置 dsh-home 复制到临时 userData
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-verify-'));
  fs.cpSync(BUNDLED_HOME, tmpHome, { recursive: true, dereference: true });
  console.log('[verify] DSH_HOME(临时) =', tmpHome);

  // 注入 Key（不打印值）
  const keySrc = 'C:/Users/kaili/deepseek-harness/.env';
  const env = { ...process.env, DSH_HOME: tmpHome };
  if (fs.existsSync(keySrc)) {
    for (const line of fs.readFileSync(keySrc, 'utf8').split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i > 0 && !line.trim().startsWith('#')) env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
    console.log('[verify] 已注入 API Key 环境变量（不打印）');
  } else {
    console.warn('[verify] 未找到本机 .env，dsh 可能无法连 API（但服务应仍启动）');
  }

  const proc = spawn(NODE_EXE, [DSH_BIN, '--profile', 'web', '--host', HOST, '--port', String(PORT)], {
    cwd: HARNESS, env, windowsHide: true, shell: false
  });
  proc.stdout && proc.stdout.on('data', (d) => console.log('[dsh]', d.toString().replace(/\n+$/, ' ')));
  proc.stderr && proc.stderr.on('data', (d) => console.log('[dsh!]', d.toString().replace(/\n+$/, ' ')));

  const up = await waitForServer();
  if (up) {
    // 探一次 HTTP
    const http = require('http');
    await new Promise((res) => {
      const req = http.get(`http://${HOST}:${PORT}`, (r) => {
        console.log('[verify] HTTP', r.statusCode, r.headers['content-type'] || '');
        r.resume(); res();
      });
      req.on('error', (e) => { console.log('[verify] HTTP error', e.message); res(); });
    });
    console.log('\n[verify] ✅ 内置 bundle 启动成功，证明打包方案可行。');
  } else {
    console.log('\n[verify] ❌ 内置 bundle 未能在端口启动。查看上方 [dsh!] 日志。');
  }
  try { proc.kill('SIGTERM'); } catch (e) {}
  process.exit(up ? 0 : 2);
}

main();
