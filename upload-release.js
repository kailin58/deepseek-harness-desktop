'use strict';
// 用 GitHub API 创建 Release v0.1.1 并上传安装包资产（token 仅在本进程内使用，不落盘）
const fs = require('fs');
const https = require('https');
const path = require('path');

const TOKEN = process.env.GH_TOKEN;
const REPO = 'kailin58/deepseek-harness-desktop';
const TAG = 'v0.1.1';
const FILE = 'E:\\deepseek-harness-desktop\\dist\\DeepSeek Harness Setup 0.1.1.exe';
const ASSET_NAME = 'DeepSeek.Harness.Setup.0.1.1.exe';
const BODY = [
  '## 0.1.1',
  '',
  '- 启动优化：启动页立即显示，harness 解析与服务启动后台并行，状态实时更新',
  '- 下载加 12s 超时，Release 无对应资产时快速回退，不卡启动',
  '- 安装后启动不要求填 Key，缺 Key 弹一次非阻塞引导；菜单「设置 → 填写/修改 API Key」随时可改',
  '- 修复：禁用 GPU 硬件加速，解决 Windows 部分显卡驱动下弹层/下拉面板被错误遮挡的问题',
  '- 桌面一键启动图标（隐藏黑框）',
  '',
  '> 安装包内置对应版本的 DeepSeek Harness。如要启用「环境感知下载」需另行上传按架构的 harness zip 资产。'
].join('\n');

function req(method, url, data, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request({
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: Object.assign({
        'Authorization': 'token ' + TOKEN,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'deepseek-harness-desktop'
      }, headers || {})
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (e) {}
        resolve({ status: res.statusCode, body: buf, json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  // 1) 若 Release 已存在（幂等），复用；否则创建
  let releaseId = null, uploadUrl = null;
  const existing = await req('GET', `https://api.github.com/repos/${REPO}/releases/tags/${TAG}`);
  if (existing.status === 200 && existing.json && existing.json.id) {
    releaseId = existing.json.id;
    uploadUrl = existing.json.upload_url.replace('{?name,label}', '');
    console.log('复用已存在 Release id=', releaseId);
  } else {
    const rel = await req('POST', `https://api.github.com/repos/${REPO}/releases`, JSON.stringify({
      tag_name: TAG, name: TAG, body: BODY, draft: false, prerelease: false
    }), { 'Content-Type': 'application/json' });
    if (rel.status !== 201 || !rel.json || !rel.json.id) {
      console.error('创建 Release 失败 HTTP', rel.status, rel.body);
      process.exit(1);
    }
    releaseId = rel.json.id;
    uploadUrl = rel.json.upload_url.replace('{?name,label}', '');
    console.log('Release 已创建 id=', releaseId);
  }

  // 2) 上传资产（流式，177MB）
  await new Promise((resolve, reject) => {
    const stat = fs.statSync(FILE);
    const u = new URL(`${uploadUrl}?name=${encodeURIComponent(ASSET_NAME)}`);
    const r = https.request({
      method: 'POST',
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'Authorization': 'token ' + TOKEN,
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        'User-Agent': 'deepseek-harness-desktop'
      }
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log('资产上传成功 HTTP', res.statusCode, 'size=', stat.size);
          resolve();
        } else {
          console.error('资产上传失败 HTTP', res.statusCode, buf);
          reject(new Error('upload failed ' + res.statusCode));
        }
      });
    });
    r.on('error', reject);
    fs.createReadStream(FILE).pipe(r);
  });

  console.log('DONE release_id=' + releaseId);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
