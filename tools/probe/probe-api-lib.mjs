/*
 * 临时排查：**Fabric API 的自动安装现在到底成不成**（用户报「fb 的 API 不给自动安装了」）。
 *
 * 直接调安装流程用的那条命令 `install_api_library`，看它：
 *   ① 搜不搜得到项目（Modrinth API 或 mcimirror）
 *   ② 下不下载得下来（Modrinth CDN 或 mcimirror）
 *   ③ 失败时的原话是什么
 *
 * 用法：node tools/probe/probe-api-lib.mjs ["<exe>"] [mc版本] [base]
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { invokeOn, launch, sleep } from '../live/lib/cdp.mjs';

const argv = process.argv.slice(2);
const EXE = argv[0] ?? path.join('src-tauri', 'target', 'release', 'ieml.exe');
const MC = argv[1] ?? '26.3';
const BASE = argv[2] ?? 'fabric';

const T = process.env.TEMP ?? '.';
const ROOT = path.join(T, 'ieml-apilib-root');
const OWN = path.join(T, 'ieml-apilib-own');
const SLUG = 'apilib-probe';

for (const d of [ROOT, OWN]) rmSync(d, { recursive: true, force: true });
mkdirSync(OWN, { recursive: true });
mkdirSync(path.join(ROOT, 'instances', SLUG, 'game', 'mods'), { recursive: true });
writeFileSync(
  path.join(OWN, 'instances.json'),
  JSON.stringify({ instances: [], activeId: null }, null, 2),
);

const { ev, pid, ws } = await launch({
  exe: EXE,
  tag: 'apilib',
  env: { IEML_DATA_DIR: ROOT, IEML_OWN_DIR: OWN },
  keepDataDir: true,
  settleMs: 2500,
});

const inv = async (cmd, args) => {
  const r = await invokeOn(ev, cmd, args);
  return r.ok !== undefined ? r.ok : { __err: r.err };
};

console.log(`调 install_api_library（slug=${SLUG} mc=${MC} base=${BASE}）…`);
const t0 = Date.now();
const out = await inv('install_api_library', { slug: SLUG, mcVersion: MC, base: BASE });
console.log(`${Date.now() - t0} ms →`, JSON.stringify(out));

const modsDir = path.join(ROOT, 'instances', SLUG, 'game', 'mods');
try {
  const files = readFileSync; // eslint-disable-line
  const { readdirSync } = await import('node:fs');
  console.log('mods/ 里现在有：', JSON.stringify(readdirSync(modsDir)));
} catch (e) {
  console.log('读 mods 失败：', e.message);
}

await sleep(300);
try {
  const log = readFileSync(path.join(T, 'ieml-apilib-out.log'), 'utf8');
  console.log('--- 应用日志（含 IEML/alias 与下载源的行）---');
  console.log(
    log
      .split('\n')
      .filter((l) => /alias|apilib|API|modrinth|mcimirror|源|下载/.test(l))
      .slice(-25)
      .join('\n'),
  );
} catch {}

ws.close();
const { spawnSync } = await import('node:child_process');
spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
process.exit(0);
