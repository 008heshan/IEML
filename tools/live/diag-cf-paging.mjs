// CF 整合包分页：后端到底给了多少、总数是多少
import { launch, invokeOn, ps } from './lib/cdp.mjs';
import { spawnSync } from 'node:child_process';

const EXE = process.argv[2] ?? 'src-tauri/target/debug/ieml.exe';
const running = (await ps('(Get-Process ieml -ErrorAction SilentlyContinue | Measure-Object).Count')).trim();
console.log(`（机器上有 ${running} 个 ieml 在跑；本探针用另一个 identifier 的构建）`);

const { ev, close, pid } = await launch({ exe: EXE, tag: 'cfpage' });
try {
  for (const [label, args] of [
    ['cf modpack offset=0', { kind: 'modpack', source: 'curseforge', limit: 20, offset: 0 }],
    ['cf modpack offset=20', { kind: 'modpack', source: 'curseforge', limit: 20, offset: 20 }],
    ['cf modpack offset=100', { kind: 'modpack', source: 'curseforge', limit: 20, offset: 100 }],
    ['modrinth modpack offset=20', { kind: 'modpack', source: 'modrinth', limit: 20, offset: 20 }],
  ]) {
    const r = await invokeOn(ev, 'resource_search', { query: '', ...args });
    if (r?.err) {
      console.log(`\n【${label}】✗ ${r.err}`);
      continue;
    }
    const hits = r.ok?.hits ?? [];
    console.log(
      `\n【${label}】total_hits=${r.ok?.total_hits} 返回=${hits.length} source=${r.ok?.source}` +
        `\n   首条=${hits[0]?.title ?? '(空)'}  末条=${hits[hits.length - 1]?.title ?? '(空)'}`,
    );
  }
} finally {
  try { close(); } catch {}
  if (pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
}
