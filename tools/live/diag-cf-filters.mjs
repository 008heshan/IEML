// 后端直问：mcVersion / loader 筛选到底有没有生效（先看返回的首条与总数）
import { launch, invokeOn, ps } from './lib/cdp.mjs';
import { spawnSync } from 'node:child_process';

const EXE = process.argv[2] ?? 'src-tauri/target/debug/ieml.exe';
const running = (await ps('(Get-Process ieml -ErrorAction SilentlyContinue | Measure-Object).Count')).trim();
console.log(`（机器上有 ${running} 个 ieml 在跑；本探针用另一个 identifier 的构建）`);

const { ev, close, pid } = await launch({ exe: EXE, tag: 'cfprobe' });

async function ask(args) {
  const r = await invokeOn(ev, 'resource_search', { kind: 'modpack', query: '', limit: 20, offset: 0, ...args });
  if (r?.err) return { err: r.err };
  const hits = r.ok?.hits ?? [];
  return {
    total: r.ok?.total_hits,
    n: hits.length,
    first: hits[0]?.title,
    firstId: hits[0]?.project_id,
    firstVersions: hits[0]?.versions?.slice(-3),
  };
}

try {
  const cases = [
    ['cf 不限', { source: 'curseforge' }],
    ['cf mc=26.2', { source: 'curseforge', mcVersion: '26.2' }],
    ['cf mc=1.20.1', { source: 'curseforge', mcVersion: '1.20.1' }],
    ['cf loader=fabric', { source: 'curseforge', loader: 'fabric' }],
    ['cf loader=forge', { source: 'curseforge', loader: 'forge' }],
    ['modrinth 不限', { source: 'modrinth' }],
    ['modrinth mc=1.20.1', { source: 'modrinth', mcVersion: '1.20.1' }],
  ];
  for (const [label, args] of cases) {
    const r = await ask(args);
    console.log(
      `\n【${label}】` +
        (r.err
          ? ` ✗ ${r.err}`
          : ` 总数=${r.total} 返回=${r.n}\n   首条：${r.first} (id=${r.firstId})  版本=${JSON.stringify(r.firstVersions)}`),
    );
  }
} finally {
  try { close(); } catch {}
  if (pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
}
