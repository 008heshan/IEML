/*
 * 门禁：**仓库根只放该放的东西**（判据来自 ADR-053 / dev.14）。
 *
 * ## 为什么要有这条
 *
 * 2026-09-25 公开化清理时，仓库根里躺着这些**都不该在**的东西：
 *   `debug.log`（416 B，还是 NVIDIA 的 CEF 日志）、`instances.json` / `prefs.json`
 *   （实例账本与偏好快照，**里面有账号 UUID 与离线用户名**）、
 *   `.minecraft/` 与 `instances/`（探针跑出来的空目录）、`tmp/`（**26.3 MB** 构建垃圾）。
 *   它们都**没有被 git 跟踪**（所以没泄露），但项目自己的规矩写着
 *   「**日志不许落进仓库根**：跑测试/构建的输出写进 `%TEMP%` 或临时文件后即删」
 *   —— 规矩在，判据不在，于是又长回来了。
 *
 * ## 判据（白名单，而不是黑名单）
 *
 *   根目录**允许**的条目是有限的几类：配置文件、README/CHANGELOG/LICENSE、
 *   源码与文档目录、以及构建产物目录（它们由 .gitignore 挡着）。
 *   出现白名单以外的东西 ⇒ 红，并说清"它属于哪儿"。
 *
 * ★ 为什么不顺手把"混合行尾"也做成硬门禁：那会逼着一次上千行的**全文件重写**
 *   （正是这类判据想防的"无关改动"）。行尾改在 README 门禁里**提示**，见
 *   `check-readme-truth.mjs` 与 `docs/CLEANUP-PLAN-2026-09-25.md`。
 *
 * 用法：node tools/gates/check-repo-root.mjs
 */
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

/** 允许出现在仓库根的**文件**（精确名） */
const ALLOWED_FILES = new Set([
  '.gitignore',
  '.npmrc',
  '.editorconfig',
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'vite.config.ts',
  'index.html',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
]);

/** 允许出现在仓库根的**目录**（精确名） */
const ALLOWED_DIRS = new Set([
  '.git',
  '.github',
  '.workbuddy', // ★ 已 gitignore：本地开发记忆（含本机路径），不入库
  'design',
  'dist', // 构建产物（gitignore）
  'docs',
  'node_modules', // 依赖（gitignore）
  'src',
  'src-tauri',
  'tests',
  'tmp', // ★ 仍允许存在，但**内容必须 gitignore 且用完就清**
  'tools',
]);

/** 常见误放位置的提示（红的时候给一句"它该去哪儿"） */
const HINTS = [
  [/\.log$/i, '日志 → 写进 %TEMP%，别落仓库根'],
  [/^instances\.json$|^prefs\.json$|^ms_client_id\.txt$|^cf_api_key\.txt$/i, '运行期数据 → 数据根 / 启动器自己的家，不是仓库'],
  [/^\.minecraft$|^instances$/, '游戏数据目录 → 数据根下，不是仓库'],
  [/\.exe$|\.msi$|\.bundle$/i, '构建产物 / 备份 → 放仓库外'],
];

const entries = readdirSync(root, { withFileTypes: true });
const bad = [];

for (const e of entries) {
  const isDir = e.isDirectory();
  const ok = isDir ? ALLOWED_DIRS.has(e.name) : ALLOWED_FILES.has(e.name);
  if (ok) continue;
  const hint = HINTS.find(([re]) => re.test(e.name))?.[1] ?? '不认识的东西 —— 要么删掉，要么加进本脚本的白名单（并说明它为什么该在根目录）';
  let size = '';
  try {
    size = isDir ? '(目录)' : `${statSync(join(root, e.name)).size} B`;
  } catch {}
  bad.push({ name: e.name, size, hint });
}

/*
 * tmp/ 允许存在，但**内容必须能说清来历**。
 *
 * ★ 2026-09-26 校准过一次：一开始写的是"tmp 必须是空的"，结果**发布完就红**——
 *   因为 `node tools/release/publish-cnb.mjs` 会写 `tmp/latest.json`，
 *   而 `verify-manifest.mjs` 又要读它（这是发布流程的必需中间物，不是垃圾）。
 *   判据太松会把垃圾放过去，太紧则会逼人绕过门禁 —— 所以取"白名单内容"：
 *   只放行发布流程明确会写的那个文件，其余一律报出来（跑完就该清掉）。
 */
const TMP_ALLOWED = new Set(['latest.json']);
if (existsSync('tmp')) {
  const junk = readdirSync('tmp', { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.') && !TMP_ALLOWED.has(e.name));
  if (junk.length > 0) {
    bad.push({
      name: 'tmp/',
      size: `(${junk.length} 个条目)`,
      hint:
        '临时目录里有不该留的东西（只放行发布流程写的 latest.json）—— ' +
        '跑完就该清掉：' +
        junk
          .slice(0, 6)
          .map((e) => e.name)
          .join('、'),
    });
  }
}

console.log(`  仓库根 ${entries.length} 个条目，白名单 文件 ${ALLOWED_FILES.size} / 目录 ${ALLOWED_DIRS.size}`);
for (const b of bad) console.log(`  ✗ ${b.name}  ${b.size}\n      ${b.hint}`);

if (bad.length === 0) {
  console.log('  ✓ 仓库根只有该有的东西');
  process.exit(0);
}
console.error('');
console.error(`✗ 仓库根有 ${bad.length} 处不该在的东西 —— 公开仓库的门面就是根目录。`);
console.error('');
process.exit(1);
