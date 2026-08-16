'use strict';
/*
 * test-harness-manager.js（开发自测用，不打包）
 * 用本地 HTTP 服务模拟 GitHub Release 资产，验证 harness-manager 全链路：
 *   1) detectEnv 输出正确
 *   2) 首次启动：下载对应架构资产 → 解压 → 校验关键文件
 *   3) 缓存复用：版本/架构一致时不重复下载
 *   4) 离线/坏地址：下载失败回退 null（由 main.js 走 bundled/system）
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawnSync } = require('child_process');
const { detectEnv, ensureHarness } = require('./harness-manager');

function buildFakeHarness(root) {
  const tree = {
    'node.exe': 'PLACEHOLDER NODE RUNTIME\n',
    'node_modules/@deepseek-ai/dsh/lib/bin.js': '#!/usr/bin/env node\nrequire("dsh");\n',
    'dsh-home/profiles/web/index.json': '{}\n'
  };
  for (const [rel, content] of Object.entries(tree)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return root;
}

async function main() {
  console.log('=== detectEnv ===');
  console.log(JSON.stringify(detectEnv(), null, 2));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'htest-'));
  const fakeRoot = path.join(tmp, 'fake');
  buildFakeHarness(fakeRoot);

  const zipName = 'deepseek-harness-0.1.0-win-x64.zip';
  const zipPath = path.join(tmp, zipName);
  // tar 的 -f 不接受带盘符的绝对路径（会误判为远程主机），故用相对名 + cwd；
  // 用 -C fake . 让 zip 内容落在根目录（与真实发布包一致：node.exe / node_modules / dsh-home 直接在根）
  const r = spawnSync('tar', ['-a', '-cf', zipName, '-C', 'fake', '.'], { cwd: tmp, windowsHide: true });
  if (r.status !== 0) {
    console.error('zip 失败 stderr:', (r.stderr || '').toString(), 'stdout:', (r.stdout || '').toString());
    process.exit(1);
  }
  console.log('zip 大小:', fs.statSync(zipPath).size, 'bytes');

  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    console.log('[server] GET', req.url);
    const data = fs.readFileSync(zipPath);
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': data.length });
    res.end(data);
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log('本地服务:', baseUrl);

  const userData = path.join(tmp, 'userData');
  const cfg = { enabled: true, owner: 'x', repo: 'y', version: '0.1.0', assetBaseUrl: baseUrl };

  // 1) 首次下载
  console.log('\n=== ensureHarness (首次下载) ===');
  const dir1 = await ensureHarness(cfg, userData);
  if (!dir1) {
    console.error('FAIL: 首次下载应成功');
    process.exit(1);
  }
  const ok1 =
    fs.existsSync(path.join(dir1, 'node.exe')) &&
    fs.existsSync(path.join(dir1, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')) &&
    fs.existsSync(path.join(dir1, '.harness-version'));
  console.log('首次下载目录:', dir1, '关键文件齐全:', ok1);
  if (!ok1) {
    console.error('FAIL: 关键文件缺失');
    process.exit(1);
  }

  // 2) 缓存复用（不应再产生下载请求）
  console.log('\n=== ensureHarness (缓存复用) ===');
  const beforeHits = hits;
  const dir2 = await ensureHarness(cfg, userData);
  const reused = hits === beforeHits;
  console.log('返回同一目录:', dir2 === dir1, '无新下载请求:', reused);
  if (!reused) {
    console.error('FAIL: 缓存命中却重新下载');
    process.exit(1);
  }

  // 3) 离线/坏地址回退（用独立 userData 避免命中缓存）
  console.log('\n=== ensureHarness (坏地址回退) ===');
  const userDataBad = path.join(tmp, 'userDataBad');
  const cfgBad = { enabled: true, owner: 'x', repo: 'y', version: '0.1.0', assetBaseUrl: 'http://127.0.0.1:1' };
  const dir3 = await ensureHarness(cfgBad, userDataBad);
  console.log('坏地址返回:', dir3);
  if (dir3 !== null) {
    console.error('FAIL: 坏地址应回退为 null');
    process.exit(1);
  }

  server.close();
  console.log('\n✅ ALL TESTS PASSED');
}

main().catch((e) => {
  console.error('TEST ERROR', e);
  process.exit(1);
});
