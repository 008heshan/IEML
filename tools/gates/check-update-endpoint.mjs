/*
 * 门禁：**发布的仓 == 客户端读的仓**。
 *
 * ## 为什么值得一条判据（这是"静默失效"的典型）
 *
 * 更新链路上有**四处**各自独立的地址，它们必须指向**同一个仓库**：
 *
 *   ① 客户端读哪：`src-tauri/tauri.conf.json` 的 `plugins.updater.endpoints[0]`
 *      —— 这个地址被**编进 exe**，改它必须重新构建；
 *   ② 发布发到哪：`tools/release/publish-cnb.mjs` 的 `REPO` 常量
 *      （以及 `verify-endpoint.mjs` 里那个用于自检的地址）；
 *   ③ 自检验哪：`tools/release/verify-endpoint.mjs` 的 `ENDPOINT`；
 *   ④ 「更新日志」页实时读哪：`src-tauri/src/commands_real.rs` 的
 *      `UPDATER_MANIFEST_URL`（2026-09-26 新增，见本文件末尾那段）。
 *
 * 它们不一致时的表现是**最难查的一种**：发布脚本高高兴兴报"上传成功"、
 * 端点自检也绿（它验的是**旧仓**那个地址），而**用户端永远收不到更新** ——
 * 没有任何一处会报错。这个仓库已经吃过一次同族的亏（beta.49「发布失败而我没发现」）。
 *
 * ★ 2026-09-26 两仓合并（代码仓兼分发仓）正是改动这两处的一轮 ——
 *   所以顺带把它变成机器守着的判据。
 *
 * 用法：node tools/gates/check-update-endpoint.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const problems = [];
const notes = [];

/* ---------- ① 客户端读的端点 ---------- */
const confPath = join(root, 'src-tauri', 'tauri.conf.json');
if (!existsSync(confPath)) {
  console.log('  （没有 tauri.conf.json，跳过）');
  process.exit(0);
}
const conf = JSON.parse(readFileSync(confPath, 'utf8'));
const endpoints = conf?.plugins?.updater?.endpoints ?? [];
if (endpoints.length === 0) problems.push('tauri.conf.json 里没有配置更新端点');
const clientUrl = endpoints[0] ?? '';

/** 从 `https://cnb.cool/<owner>/<repo>/-/releases/download/...` 里取出 `<owner>/<repo>` */
function repoOf(url) {
  const m = /^https?:\/\/cnb\.cool\/([^/]+\/[^/]+)\/-\/releases\//.exec(url);
  return m ? m[1] : null;
}
const clientRepo = repoOf(clientUrl);
if (!clientRepo) problems.push(`更新端点不是 CNB 的 releases 地址，认不出仓库：${clientUrl}`);

/* ---------- ② 发布脚本发到哪 ---------- */
const pubPath = join(root, 'tools', 'release', 'publish-cnb.mjs');
if (!existsSync(pubPath)) {
  problems.push('找不到 tools/release/publish-cnb.mjs');
} else {
  const src = readFileSync(pubPath, 'utf8');
  const m = /^const REPO = '([^']+)'/m.exec(src);
  const publishRepo = m?.[1] ?? null;
  if (!publishRepo) {
    problems.push('publish-cnb.mjs 里读不到 `const REPO`');
  } else if (clientRepo && publishRepo !== clientRepo) {
    problems.push(
      `**发布的仓与客户端读的仓不一致**：\n` +
        `      客户端读（tauri.conf.json）：${clientRepo}\n` +
        `      发布发到（publish-cnb.mjs）：${publishRepo}\n` +
        `      ⇒ 这会让"发布成功但用户永远收不到更新"，而且没有任何地方会报错`,
    );
  } else {
    notes.push(`客户端与发布脚本都指向 ${publishRepo}`);
  }
}

/* ---------- ③ 自检脚本验的是不是同一个地址 ---------- */
const verifyPath = join(root, 'tools', 'release', 'verify-endpoint.mjs');
if (existsSync(verifyPath)) {
  const src = readFileSync(verifyPath, 'utf8');
  const m = /const ENDPOINT =\s*'([^']+)'/.exec(src) ?? /const ENDPOINT =\s*\n\s*'([^']+)'/.exec(src);
  const verifyRepo = repoOf(m?.[1] ?? '');
  if (!verifyRepo) {
    notes.push('verify-endpoint.mjs 的 ENDPOINT 不是 CNB releases 地址（跳过对比）');
  } else if (clientRepo && verifyRepo !== clientRepo) {
    problems.push(
      `**端点自检验的是另一个仓**：verify-endpoint.mjs → ${verifyRepo}，客户端读 → ${clientRepo}\n` +
        `      ⇒ 自检会绿，而它验的根本不是用户会去读的那个地址`,
    );
  } else {
    notes.push('端点自检与客户端读的是同一个地址');
  }
}

/* ---------- ④ 后端"实时读更新说明"用的是不是同一个地址 ---------- */
/*
 * ★★ 2026-09-26 新增这一处：用户要求「版本更新列表实时获取，点进去就刷新」，
 *   于是 Rust 侧多了一个直接读清单的命令（`fetch_update_notes`）。
 *   它当然也得指向**同一个仓** —— 否则表现是"更新检查说有新版，更新日志却还是旧的"。
 *   ★ 这条判据的价值就在这里：**多一处地址就多一处能悄悄漂移的地方**。
 */
const cmdPath = join(root, 'src-tauri', 'src', 'commands_real.rs');
if (existsSync(cmdPath)) {
  const src = readFileSync(cmdPath, 'utf8');
  const m = /const UPDATER_MANIFEST_URL: &str =\s*\n?\s*"([^"]+)"/.exec(src);
  const rustUrl = m?.[1] ?? '';
  const rustRepo = repoOf(rustUrl);
  if (!rustRepo) {
    problems.push(
      `commands_real.rs 里的 UPDATER_MANIFEST_URL 不是 CNB releases 地址（读不到或为空）：${rustUrl || '(没有)'}`,
    );
  } else if (clientRepo && rustRepo !== clientRepo) {
    problems.push(
      `**"实时读更新说明"读的是另一个仓**：commands_real.rs → ${rustRepo}，客户端更新检查 → ${clientRepo}\n` +
        `      ⇒ 表现是"说有新版本、更新日志却还是旧的"，两处都不报错`,
    );
  } else {
    notes.push('实时更新说明与客户端更新检查读的是同一个地址');
  }
}

for (const n of notes) console.log(`  · ${n}`);
for (const p of problems) console.log(`  ✗ ${p}`);

if (problems.length === 0) {
  console.log('  ✓ 更新链路四处（客户端 / 发布 / 自检 / 实时说明）指向同一个仓');
  process.exit(0);
}
console.error('');
console.error(`✗ 更新链路有 ${problems.length} 处不一致 —— 这类问题的表现是"静默失效"。`);
console.error('');
process.exit(1);
