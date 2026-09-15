/* 验证 BMCLAPI 是否覆盖全部所需的 Maven 路径 */
const base = 'https://bmclapi2.bangbang93.com';
const paths = [
  // 原版
  ['/mc/game/version_manifest_v2.json', '版本清单'],
  ['/version/1.20.1/json', '版本详情'],
  ['/version/1.20.1/client', '客户端 jar'],
  ['/version/1.20.1/server', '服务端 jar'],
  // Fabric
  ['/maven/net/fabricmc/fabric-loader/maven-metadata.xml', 'Fabric Loader 元数据'],
  ['/maven/net/fabricmc/fabric-loader/0.16.9/fabric-loader-0.16.9.jar', 'Fabric Loader jar'],
  ['/maven/net/fabricmc/intermediary/1.20.1/intermediary-1.20.1-v2.jar', 'Fabric intermediary'],
  ['/maven/net/fabricmc/tiny-mappings/maven-metadata.xml', 'Fabric mappings 元数据'],
  // Quilt
  ['/maven/org/quiltmc/quilt-loader/maven-metadata.xml', 'Quilt Loader 元数据'],
  ['/maven/org/quiltmc/quilt-loader/0.23.1/quilt-loader-0.23.1.jar', 'Quilt Loader jar'],
  // Forge
  ['/maven/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar', 'Forge 安装器'],
  ['/maven/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-universal.jar', 'Forge universal'],
  // NeoForge
  ['/maven/net/neoforged/neoforge/maven-metadata.xml', 'NeoForge 元数据'],
  ['/maven/net/neoforged/neoforge/21.1.72/neoforge-21.1.72-installer.jar', 'NeoForge 安装器'],
  // 库与资源
  ['/maven/org/ow2/asm/asm/9.5/asm-9.5.jar', '普通库文件'],
  ['/assets/00/00000000000000000000000000000000000000', '资源文件（assets）'],
  // 其它
  ['/forge/download/1.20.1-47.2.0', 'Forge 下载入口'],
];

async function probe(name, url, head = true) {
  const t0 = Date.now();
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    const res = await fetch(url, {
      method: head ? 'HEAD' : 'GET',
      signal: ctl.signal,
      headers: { 'user-agent': 'IEML-Launcher/0.1' },
    });
    clearTimeout(timer);
    const len = res.headers.get('content-length');
    return { ok: res.ok, status: res.status, ms: Date.now() - t0, len };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, len: `ERR ${e.name}` };
  }
}

console.log('BMCLAPI 覆盖验证\n');
let ok = 0;
let fail = 0;
for (const [p, name] of paths) {
  const r = await probe(name, base + p);
  if (r.ok) ok++;
  else fail++;
  const size = r.len ? `${(Number(r.len) / 1024).toFixed(0)} kB` : '';
  console.log(
    `${r.ok ? '✓' : '✗'} ${String(r.status).padStart(3)} ${size.padStart(9)}  ${name.padEnd(24)} ${p}`,
  );
}
console.log(`\n通过 ${ok} / 失败 ${fail}`);
