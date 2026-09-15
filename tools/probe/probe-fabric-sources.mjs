// 实测：Fabric 的库在镜像/官方源上到底能不能下？各源快不快？
// 用法：node tools/probe/probe-fabric-sources.mjs
const MC = process.argv[2] ?? '26.2';
const MIRROR = 'https://bmclapi2.bangbang93.com';
const FABRIC_MAVEN = 'https://maven.fabricmc.net';
const FABRIC_META = 'https://meta.fabricmc.net/v2';

async function time(url, ms = 30000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: ac.signal });
    const buf = await res.arrayBuffer();
    return {
      ok: res.ok,
      status: res.status,
      bytes: buf.byteLength,
      ms: Date.now() - t0,
    };
  } catch (e) {
    return { ok: false, status: 0, bytes: 0, ms: Date.now() - t0, err: e.name === 'AbortError' ? `超时 ${ms / 1000}s` : e.message };
  } finally {
    clearTimeout(t);
  }
}

function show(label, r) {
  if (r.ok) {
    console.log(
      `  ✓ ${label.padEnd(46)} HTTP ${r.status}  ${(r.bytes / 1024).toFixed(1)} KB  ${(r.ms / 1000).toFixed(2)}s`,
    );
  } else {
    console.log(`  ✗ ${label.padEnd(46)} ${r.err ?? 'HTTP ' + r.status}  (${(r.ms / 1000).toFixed(1)}s)`);
  }
  return r;
}

console.log(`\n========== Fabric 下载源可用性（MC ${MC}）==========\n`);

console.log('[1] Fabric 元数据 API（拿 loader 列表 / profile）');
const meta = await time(`${FABRIC_META}/versions/loader/${MC}`);
show('meta.fabricmc.net loader 列表（官方）', meta);
if (meta.ok) {
  const list = JSON.parse(Buffer.from(await (await fetch(`${FABRIC_META}/versions/loader/${MC}`)).arrayBuffer()).toString());
  const lv = list[0]?.loader?.version;
  console.log(`     最新 loader: ${lv}`);
  const prof = await time(`${FABRIC_META}/versions/loader/${MC}/${lv}/profile/json`);
  show('官方 profile JSON', prof);

  console.log('\n[2] 加载器 jar 本体');
  const rel = `net/fabricmc/fabric-loader/${lv}/fabric-loader-${lv}.jar`;
  show('镜像 maven（我们的默认路径）', await time(`${MIRROR}/maven/${rel}`));
  show('官方 maven', await time(`${FABRIC_MAVEN}/${rel}`));

  console.log('\n[3] profile 里声明的其他库（逐条试）');
  if (prof.ok) {
    const pj = JSON.parse(Buffer.from(await (await fetch(`${FABRIC_META}/versions/loader/${MC}/${lv}/profile/json`)).arrayBuffer()).toString());
    for (const lib of (pj.libraries ?? []).slice(0, 8)) {
      const parts = String(lib.name).split(':');
      const [g, a, v, cls] = parts;
      const path = `${g.replace(/\./g, '/')}/${a}/${v}/${a}-${v}${cls ? '-' + cls : ''}.jar`;
      const mirrored = `${MIRROR}/maven/${path}`;
      const official = `${(lib.url ?? FABRIC_MAVEN).replace(/\/$/, '')}/${path}`;
      console.log(`  ${lib.name}`);
      show('    镜像', await time(mirrored, 20000));
      show('    官方', await time(official, 20000));
    }
  }
}

console.log('\n结论怎么看：');
console.log('  · 镜像 ✗ 官方 ✓  → 镜像没同步这个库，应该回退官方源（引擎会换源）');
console.log('  · 两边都 ✗        → 网络/源整体不可用，不是启动器能修的');
console.log('  · 两边都慢（>10s）→ 就是"下不动"的体感，看 SpeedWatch 会不会换源');
