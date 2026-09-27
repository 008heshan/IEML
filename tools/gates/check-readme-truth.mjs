/*
 * 门禁：**README 说的东西必须真的存在**。
 *
 * ## 为什么是这条（而不是"关键词黑名单"）
 *
 * 2026-09-25 通读文档时，README 里抓到两条**用户可见的假话**：
 *   · 「换数据根目录……**要重启启动器才生效**（界面上会挂"重启后生效"的角标）」
 *     —— rc.6 起是**即时生效**、角标整块删了；
 *   · 「裸 exe 8.9 MB / 437 项 Rust 测试 / 前端产物约 760 kB」—— 三个数字都过期了。
 * 它们的共同形状是：**机制变了，文档没跟着变**，而且没有任何判据会发现。
 *
 * 关键词黑名单只能挡住"我已经知道的那几个词"，挡不住下一轮的漂移。
 * 所以这里用两条**会随代码自动更新**的判据：
 *
 *   ① README 里提到的**仓库内文件路径**必须真的存在（最常漂的一类）；
 *   ② README 里写的**本仓库命令**（`node tools/…` / `pnpm …`）必须在 package.json
 *      的 scripts 里能找到（或者那个脚本文件真的在）；
 *   ③ 再加几条**定点禁用短语**：已经删掉的机制的名字不许再出现在 README
 *      （它们各自都对应一次"文档说做不到、其实做得到"的旧账）。
 *
 * 用法：node tools/gates/check-readme-truth.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const README = 'README.md';
if (!existsSync(README)) {
  console.log('  （没有 README.md，跳过）');
  process.exit(0);
}

const text = readFileSync(README, 'utf8');
const problems = [];

/* ---------- ① 仓库内文件路径必须存在 ---------- */
const missing = new Set();
// 反引号里的路径 + markdown 链接目标，两种写法都看
for (const m of text.matchAll(/`([^`\n]+)`/g)) {
  const raw = m[1].trim();
  if (!/^[\w./-]+\.(md|json|mjs|ps1|cjs|toml|ts|tsx|exe)$/i.test(raw)) continue;
  if (/^(https?:|\/|[A-Za-z]:)/.test(raw)) continue;
  const p = raw.replace(/^\.\//, '');
  if (!existsSync(join(root, p))) missing.add(raw);
}
for (const m of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
  const raw = m[1].trim();
  if (/^(https?:|mailto:)/.test(raw)) continue;
  const p = raw.replace(/^\.\//, '');
  if (!existsSync(join(root, p))) missing.add(raw);
}
for (const p of missing) problems.push(`README 里提到的路径不存在：${p}`);

/* ---------- ② 命令必须真的有 ---------- */
const pkg = existsSync('package.json') ? JSON.parse(readFileSync('package.json', 'utf8')) : { scripts: {} };
const scripts = new Set(Object.keys(pkg.scripts ?? {}));
for (const m of text.matchAll(/`(pnpm|node)\s+([^\s`]+)/g)) {
  const [, bin, target] = m;
  if (bin === 'pnpm') {
    // pnpm <script> / pnpm exec <bin> / pnpm install 都算合法
    if (['install', 'exec', 'dev', 'preview'].includes(target)) continue;
    if (!scripts.has(target)) problems.push(`README 里的 \`pnpm ${target}\` 在 package.json 的 scripts 里没有`);
  } else {
    // node <file>
    const p = target.replace(/^\.\//, '');
    if (!existsSync(join(root, p)) && !scripts.has(target)) {
      problems.push(`README 里的 \`node ${target}\` 找不到这个文件`);
    }
  }
}

/* ---------- ③ 定点禁用短语：已删掉的机制不许再被承诺 ---------- */
const BANNED = [
  {
    re: /重启(启动器)?才?生效/,
    why: '「换数据根目录要重启才生效」是 rc.6 之前的旧机制；现在即时生效（commands_real.rs 返回 restart_required: false）',
  },
  {
    re: /重启后生效.*角标|角标.*重启后生效/,
    why: '那个角标（.droot-pending）已经删掉了（pages.css 里留着说明）',
  },
  {
    re: /程序内置一把|内置一把\s*(可用的)?\s*(API\s*)?Key/i,
    why: '内置的 CurseForge key 已为公开化清空（2026-09-25）；现在是"走国内镜像、不需要 key"',
  },
  {
    /*
     * ★★ 2026-09-27（清理）：这条原来禁的是「拖(拽|进窗口).*(安装|导入)」，
     *   理由是"拖放从未实现（C-3 已删掉那句承诺）"。
     *
     *   但它**过期了，而且方向反了**：`0.2.0` 真的实现了拖放
     *   （`AppShell.tsx` 的 `onDragDropEvent` + `pack_install_local`，
     *   真机探针 `live-cf-modpack-check.mjs` ③ 与 `live-backup-check.mjs` 都验过）。
     *   留着它的后果不是"少一条检查"，而是**将来 README 里写一句真话会被它判红** ——
     *   一条会挡住事实的门禁，比没有门禁更坏（下一个人会学会绕开它）。
     *
     *   ⇒ 改成禁"把拖放说成支持**所有**东西"：今天拖放只认**整合包**
     *     （`.mrpack` / CurseForge 的 `.zip`），拖 Mod / 资源包 / 光影包都不行
     *     （见 ADR-015 与 `AppShell.tsx` 里那句"目前只支持整合包"）。
     */
    re: /拖(拽|进窗口)[^\n]{0,20}(都能|均可|任意|所有|任何).{0,10}(安装|导入)/,
    why: '拖放目前只认整合包（.mrpack / CF 的 .zip）：拖 Mod、资源包、光影包都还不行，别把范围说宽',
  },
];
for (const b of BANNED) {
  if (b.re.test(text)) problems.push(`README 承诺了一个已不存在的机制：${b.why}`);
}

/*
 * ---------- ④ 会漂的数字：**只许写下限，不许写精确值** ----------
 *
 * ★★ 2026-09-26（这一轮实测撞到的）：README 第 7 行写着「465 项 Rust 测试」，
 *   而当天实测是 **467** —— 这是它**第三次**过期（最早 437，改 465 那次也没判据）。
 *   原因不是马虎，是**这类数字天然只增不减**，写死就一定会漂。
 *
 *   ⇒ 判据：测试项数必须写成下限（`460+ 项`）。下限只会"变得更真"，
 *     而且读者一眼就知道那不是精确值。
 *
 *   ★ 为什么不去跑 `cargo test --lib -- --list` 拿精确数对：
 *     那会让一条**静态**门禁依赖编译（几十秒 + 要 MSVC 环境），
 *     而这台机器上"门禁要能随手跑"是更前面的一条纪律（见 verify.mjs 头部）。
 *     下限写法用一条正则就守住了同一类病，成本差两个数量级。
 */
const exactCount = /(\d{2,4})\s*项\s*(Rust|rust|前端|单元)?\s*测试/.exec(text);
if (exactCount && !/\+/.test(exactCount[0])) {
  problems.push(
    `README 写了精确的测试项数（「${exactCount[0]}」）—— 这类数字只会涨，写死必然过期；` +
      `改成下限写法（例如「${exactCount[1]}+ 项 Rust 测试」）`,
  );
}

console.log(`  检查 README：${[...text.matchAll(/`[^`\n]+`/g)].length} 个行内代码 / ${scripts.size} 个 pnpm 脚本`);
for (const p of problems) console.log(`  ✗ ${p}`);

if (problems.length === 0) {
  console.log('  ✓ README 提到的路径、命令与机制都对得上');
  process.exit(0);
}
console.error('');
console.error(`✗ ${problems.length} 处 README 与事实不符 —— 用户看的第一份文档就是它。`);
console.error('  修：改 README（或把禁用的机制加进本脚本的 BANNED，并写清依据）。');
console.error('');
process.exit(1);
