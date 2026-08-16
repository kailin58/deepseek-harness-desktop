'use strict';
/*
 * bundle-harness.js
 * 把「可独立运行的 DeepSeek Harness」打包进 build-resources/harness，
 * 供 electron-builder 的 extraResources 随安装包分发。
 *
 * 产物结构（安装后位于 <resources>/harness）：
 *   harness/
 *     node.exe                       # 内置 Node 运行时（来自本机 managed runtime）
 *     node_modules/                  # dsh launcher（@deepseek-ai/dsh）及其依赖
 *     dsh-home/                      # = 本机 ~/.dsh（profiles/web、profiles/node_modules 等）
 *
 * 设计要点：
 *   - 不复制任何 .env / API Key，Key 由首次运行录入页写入用户目录。
 *   - profiles/node_modules 是 dsh 的「扁平回退目录」：本机全部为指向
 *     deepseek-harness/node_modules 的 junction，由 dsh 在每次启动时按
 *     运行期路径（即内置 harness/node_modules）重新生成，因此【绝不】打进 bundle。
 *   - profiles/web/node_modules 才是真正需要复制的 profile 依赖（pnpm 管理的真目录）。
 *   - DEEPSEEK_API_KEY 等运行时注入，从不在 bundle 中落盘。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
// 源路径可用环境变量覆盖，默认取「当前用户主目录」下的标准位置，
// 让任意装了 dsh 的机器都能 `npm run bundle`（开源友好）。
const SRC_DSH = process.env.DSH_SRC || path.join(os.homedir(), 'deepseek-harness');
const SRC_HOME = process.env.DSH_HOME_SRC || path.join(os.homedir(), '.dsh');
const OUT = path.join(ROOT, 'build-resources', 'harness');

// dsh-home 的「扁平回退目录」——全是本机 junction，不能打进分发包
const HOME_FALLBACK = path.join(SRC_HOME, 'profiles', 'node_modules');

// 解析要内置的 node.exe
function resolveNodeExe() {
  const candidates = [
    process.env.NODE_SRC,
    'C:/Users/kaili/.workbuddy/binaries/node/versions/22.22.2/node.exe',
    'D:/node.exe'
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// 复制时跳过的目录/文件，减小体积
function copyFilter(src) {
  const base = path.basename(src);
  if (base === '.cache' || base === '.npmcache' || base === 'node_modules/.cache') return false;
  if (base.endsWith('.log')) return false;
  // 排除 dsh-home 的「扁平回退目录」profiles/node_modules：
  // 它全部是指向本机 deepseek-harness/node_modules 的 junction，
  // dsh 会在运行期按内置 harness/node_modules 重新生成，绝不能原样打包。
  if (src === HOME_FALLBACK || src.startsWith(HOME_FALLBACK + path.sep)) return false;
  return true;
}

function copyTree(src, dest) {
  if (!fs.existsSync(src)) {
    console.warn('[bundle] 跳过不存在的源：', src);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, dereference: true, filter: copyFilter });
  console.log('[bundle] 已复制：', src, '\n        -> ', dest);
}

function main() {
  const nodeExe = resolveNodeExe();
  if (!nodeExe) {
    console.error('[bundle] 找不到可用的 node.exe，请设置 NODE_SRC 环境变量。');
    process.exit(1);
  }
  for (const p of [SRC_DSH, SRC_HOME]) {
    if (!fs.existsSync(p)) {
      console.error('[bundle] 源目录不存在：', p);
      process.exit(1);
    }
  }

  // 清理旧产物（失败则忽略，改为覆盖复制）
  try {
    fs.rmSync(OUT, { recursive: true, force: true });
    console.log('[bundle] 已清理旧 build-resources/harness');
  } catch (e) {
    console.warn('[bundle] 清理跳过：', e.message);
  }

  console.log('[bundle] 复制 node.exe ...');
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(nodeExe, path.join(OUT, 'node.exe'));

  console.log('[bundle] 复制 dsh launcher node_modules ...');
  copyTree(path.join(SRC_DSH, 'node_modules'), path.join(OUT, 'node_modules'));

  console.log('[bundle] 复制 dsh home (.dsh) ...');
  copyTree(SRC_HOME, path.join(OUT, 'dsh-home'));
  // 安全网：确保扁平回退目录不进 bundle（dsh 运行期会重建为正确的 junction）
  const fallbackOut = path.join(OUT, 'dsh-home', 'profiles', 'node_modules');
  try { fs.rmSync(fallbackOut, { recursive: true, force: true }); } catch (e) {}
  console.log('[bundle] 已排除扁平回退目录 profiles/node_modules（运行期由 dsh 重建）');

  console.log('[bundle] 完成。产物位于：', OUT);
  console.log('[bundle] 提示：运行 `npm run dist` 即可打包为可分发安装程序。');
}

main();
