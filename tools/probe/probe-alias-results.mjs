/*
 * 一次性排查：中文别名对应的项目在各平台上到底搜不搜得到（走**我们自己的**命令）。
 *
 * 为什么不用页面里的 fetch：Tauri 的 CSP 会拦掉页面发往第三方 API 的请求
 * （启动器是**在 Rust 里**发这些请求的）—— 于是页面里的 fetch 一律
 * "Failed to fetch"，那是测量方式的问题，不是平台的回答。
 *
 * 用法：node tools/probe/probe-alias-results.mjs ["<exe>"]
 */
import path from 'node:path';
import { invokeOn, launch } from '../live/lib/cdp.mjs';

const argv = process.argv.slice(2);
const EXE =
  argv.find((a) => !a.startsWith('--')) ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');

const CASES = [
  { q: '物品管理器', source: 'modrinth' },
  { q: '等价交换', source: 'modrinth' },
  { q: '等价交换', source: 'curseforge' },
  // ★ 找正主的**名字**（不是 slug）：平台的搜索按名字打分
  { q: 'The Twilight Forest', source: 'modrinth' },
  { q: 'The Twilight Forest', source: 'curseforge' },
  { q: 'twilight forest', source: 'modrinth' },
  { q: 'Industrial Craft 2', source: 'modrinth' },
  { q: 'Industrial Craft 2', source: 'curseforge' },
  { q: 'Extra Utilities', source: 'curseforge' },
  { q: 'ToroHUD', source: 'modrinth' },
  { q: '一键背包整理', source: 'modrinth' },
  { q: '旅行地图', source: 'modrinth' },
];

const { ev, pid, ws } = await launch({
  exe: EXE,
  tag: 'aliasresults',
  env: { IEML_DATA_DIR: path.join(process.env.TEMP ?? '.', 'ieml-aliasr-root') },
  keepDataDir: true,
  settleMs: 2000,
});

try {
  for (const c of CASES) {
    const r = await invokeOn(ev, 'resource_search', {
      kind: 'mod',
      query: c.q,
      mcVersion: null,
      loader: null,
      limit: 30,
      offset: 0,
      source: c.source,
    });
    const ok = r.ok ?? {};
    const slugs = (ok.hits ?? []).map((h) => h.slug);
    console.log(`\n【${c.q} · ${c.source}】${r.err ? 'ERR ' + r.err : `共 ${ok.total_hits} 条`}`);
    console.log('  别名：' + (ok.query_alias ?? '(无)'));
    console.log('  实际用词：' + (ok.term_used ?? '(无)'));
    console.log('  前 8 个：' + JSON.stringify(slugs.slice(0, 8)));
  }
} finally {
  try {
    ws.close();
  } catch {}
  const { spawnSync } = await import('node:child_process');
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  process.exit(0);
}
