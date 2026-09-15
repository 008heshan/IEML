#!/usr/bin/env node
/**
 * 把同一个版本号写到**所有**需要它的地方。
 * ------------------------------------------------------------------
 * 为什么需要这个脚本（真实事故的形状）：
 *
 *   版本号以前散落在四个文件里，靠手改。手改一定会漂移，
 *   而漂移的后果不是"显示得不好看"，是**排查时被骗**：
 *   用户报"0.1.0-dev.2 有这个问题"，你去查那个 tag，发现那个版本号
 *   在三个文件里指的是三个不同的构建。
 *
 *   规则见 `docs/VERSIONING.md`。这里只做一件事：
 *   **把同一个字符串写进所有位置，并证明它写成了一样的**。
 *
 * 用法：
 *   node tools/set-version.mjs 0.1.0-dev.3      # 写入
 *   node tools/set-version.mjs --check          # 只校验一致性（CI / verify 用）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 允许的版本号形状：SemVer + 可选阶段后缀。见 docs/VERSIONING.md */
const SHAPE = /^\d+\.\d+\.\d+(?:-(dev|alpha|beta|rc)\.\d+)?$/;

/**
 * 所有需要版本号的地方。
 *
 * 约定：`find` 必须**捕获组 1 = 版本号本身**。
 *   ★ 这里踩过一次：原来靠"从匹配文本里找第一个引号串"来取值，
 *     于是 `"version": "0.1.0-dev.3"` 取到的是 `version` 这个**字段名**
 *     （第一个引号串就是它）。--check 于是报"四处不一致"，
 *     而实际上四处都对 —— 一个测量工具的 bug，被当成了被测对象的 bug。
 *     所以现在只认捕获组，不再猜。
 */
const TARGETS = [
  {
    file: 'package.json',
    what: '前端包元数据',
    find: /"version":\s*"([^"]*)"/,
  },
  {
    file: 'src-tauri/Cargo.toml',
    what: 'Rust 包元数据（app_info 命令读的就是它，编译期展开）',
    // 只认 [package] 段里第一个 version，别动依赖里的 version = "1"
    find: /(\[package\][\s\S]*?\nversion\s*=\s*)"([^"]*)"/,
    // ★ 这个正则有两个捕获组：组 1 是前缀，组 2 才是版本号
    valueGroup: 2,
  },
  {
    file: 'src-tauri/tauri.conf.json',
    what: 'Tauri 打包器（决定安装包文件名与 exe 属性）',
    find: /"version":\s*"([^"]*)"/,
  },
  {
    file: 'src/domain/version-info.ts',
    what: '前端「关于」里显示的版本号',
    find: /export const APP_VERSION = '([^']*)'/,
  },
  /*
   * ★★ **README 也是版本号的落点**（P0 文档修复）。
   *
   *   原来它不在表里，于是漂移了整整 8 个版本都没人发现：
   *   代码里是 `0.1.0-dev.11`，README 开头还写着「当前版本：0.1.0-dev.3」。
   *   读者（包括下一轮的我自己）会拿那个数字去对现象 —— 对不上，然后怀疑代码。
   *
   *   规则：**说"当前版本"的地方必须是当前版本**，所以它和代码一起被改写。
   */
  {
    file: 'README.md',
    what: 'README 开头的「当前版本」',
    // 反引号里就是版本号；后面那句「（内部开发版）」不在捕获范围内
    find: /\*\*当前版本：`([^`]*)`/,
  },
  {
    file: 'README.md',
    what: 'README 里的安装包文件名示例',
    find: /IEML_(\d[^_]*)_x64-setup\.exe/,
  },
];

/**
 * **只校验、不改写**的目标。
 *
 * `CHANGELOG.md` 的最新一节标题必须等于当前版本 —— 但它**不能**被
 * `set-version` 改写：那一节的正文是"这个版本改了什么"，
 * 换版本号只能由人写一节新的出来。所以它进的是这张表。
 */
const CHECK_ONLY = [
  {
    file: 'CHANGELOG.md',
    what: 'CHANGELOG 最新一节（每完成一轮加一节，见文件头部的规矩）',
    find: /^## (\S+) —/m,
  },
];

function readVersionAt(target) {
  const text = readFileSync(join(ROOT, target.file), 'utf8');
  const m = text.match(target.find);
  if (!m) return null;
  return m[target.valueGroup ?? 1] ?? null;
}

/** 收集所有落点（可改写的 + 只校验的） */
function readAll() {
  return [
    ...TARGETS.map((t) => ({ t, v: readVersionAt(t), writable: true })),
    ...CHECK_ONLY.map((t) => ({ t, v: readVersionAt(t), writable: false })),
  ];
}

/** 文档口径这一组（README + CHANGELOG）—— `--docs` 只查这些 */
function docTargets() {
  return readAll().filter((f) => /\.md$/.test(f.t.file));
}

function reportMismatch(found, headline) {
  const versions = [...new Set(found.map((f) => f.v))];
  console.error(headline);
  for (const f of found) {
    console.error(`    ${String(f.v).padEnd(16)} ${f.t.file}  —— ${f.t.what}`);
  }
  console.error(`\n  找到 ${versions.length} 个不同的版本号：${versions.join(' / ')}`);
  console.error('  修法：node tools/set-version.mjs <版本号>（CHANGELOG 那一节要人手补）');
  process.exit(1);
}

function main() {
  const arg = process.argv[2];
  const check = arg === '--check';
  const docsOnly = arg === '--docs';

  /* ---------- ① 只查文档口径（verify.mjs 里的「文档版本口径一致」） ---------- */
  if (docsOnly) {
    const found = docTargets();
    const missing = found.filter((f) => f.v === null);
    if (missing.length) {
      console.error('✗ 这些文档里找不到版本号：');
      for (const f of missing) console.error(`    ${f.t.file}（${f.t.what}）`);
      process.exit(1);
    }
    const uniq = new Set(found.map((f) => f.v));
    if (uniq.size > 1) {
      reportMismatch(found, '✗ 文档里的版本号与最新变更记录对不上：');
    }
    console.log(`✓ 文档版本口径一致：${found[0].v}（README 与 CHANGELOG 逐字相同）`);
    return;
  }

  if (check) {
    const found = readAll();
    const bad = found.filter((f) => f.v === null);
    if (bad.length) {
      console.error('✗ 这些文件里找不到版本号字段：');
      for (const b of bad) console.error(`    ${b.t.file}（${b.t.what}）`);
      process.exit(1);
    }
    const uniq = new Set(found.map((f) => f.v));
    if (uniq.size > 1) {
      reportMismatch(found, '✗ 版本号不一致 —— 这正是这个脚本要防的事：');
    }
    const v = found[0].v;
    if (!SHAPE.test(v)) {
      console.error(`✗ 版本号形状不合规：${v}`);
      console.error('  规则见 docs/VERSIONING.md（形如 0.1.0-dev.3 / 0.1.0-beta.1 / 1.0.0）');
      process.exit(1);
    }
    const files = new Set(found.map((f) => f.t.file)).size;
    console.log(`✓ ${files} 个文件、${found.length} 处版本号一致：${v}`);
    return;
  }

  if (!arg) {
    console.error('用法：node tools/set-version.mjs <版本号>');
    console.error('      node tools/set-version.mjs --check   只校验一致性（verify 里会跑）');
    console.error('      node tools/set-version.mjs --docs    只校验文档口径（README / CHANGELOG）');
    console.error('  版本号规则见 docs/VERSIONING.md');
    process.exit(1);
  }
  if (!SHAPE.test(arg)) {
    console.error(`✗ 版本号形状不合规：${arg}`);
    console.error('  允许：0.1.0-dev.3 / 0.1.0-alpha.1 / 0.1.0-beta.2 / 0.1.0-rc.1 / 1.0.0');
    process.exit(1);
  }

  const changed = [];
  for (const t of TARGETS) {
    const path = join(ROOT, t.file);
    if (!existsSync(path)) {
      console.error(`✗ 缺少文件：${t.file}`);
      process.exit(1);
    }
    const before = readFileSync(path, 'utf8');
    const m = before.match(t.find);
    if (!m) {
      console.error(`✗ 在 ${t.file} 里没找到要替换的版本号（正则不匹配）`);
      process.exit(1);
    }
    /*
     * 用捕获组的值做替换，而不是重写整个匹配文本 ——
     * 这样 JSON 的引号、TOML 的 `version = ` 前缀都由原文件自己保留，
     * 我们只动版本号那一段。
     */
    const g = t.valueGroup ?? 1;
    const after = before.replace(
      t.find,
      (full) => full.replace(m[g], arg),
    );
    if (before !== after) {
      writeFileSync(path, after, 'utf8');
      changed.push(t.file);
    }
  }

  console.log(`✓ 版本号已设为 ${arg}`);
  for (const t of TARGETS) {
    console.log(`    ${changed.includes(t.file) ? '改写' : '已是'}  ${t.file}  — ${t.what}`);
  }
  console.log('');
  console.log('★ 记得重新构建：Rust 的版本号是编译期展开的（env!("CARGO_PKG_VERSION")），');
  console.log('  只改 Cargo.toml 不重新编译，界面上的版本号不会变。');
  console.log('  pnpm desktop:build');
  console.log('');
  console.log('★ CHANGELOG 不会被自动改写：请**人手**加一节 `## <版本号> — <日期>`，');
  console.log('  然后 `node tools/set-version.mjs --docs` 会证明文档口径一致。');
}

main();
