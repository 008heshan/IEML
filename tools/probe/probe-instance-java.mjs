/*
 * 一次性排查：**实例文件夹里的 Java 为什么没被扫到**。
 *
 * 用法：node tools/probe/probe-instance-java.mjs ["<exe>"]
 */
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { invokeOn, launch } from '../live/lib/cdp.mjs';

const argv = process.argv.slice(2);
const EXE =
  argv.find((a) => !a.startsWith('--')) ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-ij-root');
const OWN = path.join(T, 'ieml-ij-own');

rmSync(ROOT, { recursive: true, force: true });
rmSync(OWN, { recursive: true, force: true });
mkdirSync(OWN, { recursive: true });
mkdirSync(path.join(ROOT, 'instances', 'ij', 'game'), { recursive: true });
writeFileSync(
  path.join(OWN, 'instances.json'),
  JSON.stringify({
    instances: [
      {
        id: 'i-ij',
        mcVersion: '1.12.2',
        loader: null,
        addons: [],
        config: { name: '实例Java', slug: 'ij', isolation: 'on', memoryMb: 2048, memorySource: 'global', javaMode: 'auto' },
        createdAt: null,
        lastPlayedAt: null,
        totalPlaySeconds: 0,
      },
    ],
    activeId: 'i-ij',
  }),
);

const { ev, pid, ws } = await launch({
  exe: EXE,
  tag: 'instjava',
  env: { IEML_DATA_DIR: ROOT, IEML_OWN_DIR: OWN },
  keepDataDir: true,
  settleMs: 2500,
});

const inv = async (cmd, args) => {
  const r = await invokeOn(ev, cmd, args);
  return r.ok !== undefined ? r.ok : { __err: r.err };
};

try {
  const info = await inv('machine_info');
  console.log('machine_info:', JSON.stringify(info).slice(0, 300));

  const before = await inv('scan_java', { manual: [] });
  console.log('\n扫到的（无 manual）：');
  for (const r of before ?? []) console.log(`  ${r.source.padEnd(10)} ${r.major} ${r.path}`);

  // 真实 java（挑一个本机扫到的）
  const real = (before ?? []).find((r) => r.major >= 8);
  if (!real) {
    console.log('（本机没扫到 java，没法继续）');
  } else {
    const jreRoot = path.dirname(path.dirname(real.path));
    const dir = path.join(ROOT, 'instances', 'ij', 'java');
    try {
      symlinkSync(jreRoot, dir, 'junction');
      console.log('\n建了目录联接：' + dir + ' → ' + jreRoot);
    } catch (e) {
      console.log('建联接失败：' + e.message);
    }
    console.log('联接里看得见 java.exe 吗：' + (await import('node:fs')).existsSync(path.join(dir, 'bin', 'java.exe')));

    const withManual = await inv('scan_java', { manual: [dir] });
    console.log('\n把那个目录当 manual 传进去：');
    for (const r of withManual ?? []) console.log(`  ${r.source.padEnd(10)} ${r.major} ${r.path}`);

    const again = await inv('scan_java', { manual: [] });
    console.log('\n再扫一次（看 source=instance 有没有出现）：');
    for (const r of again ?? []) console.log(`  ${r.source.padEnd(10)} ${r.major} ${r.path}`);
  }
} finally {
  try {
    ws.close();
  } catch {}
  const { spawnSync } = await import('node:child_process');
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  process.exit(0);
}
