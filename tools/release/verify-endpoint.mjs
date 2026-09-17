/*
 * 端到端验证更新通道：完全按客户端的做法走一遍。
 *
 *   1. 匿名拉更新端点上的 latest.json
 *   2. 匿名下载它指向的那个安装包
 *   3. 用 tauri.conf.json 里内置的 pubkey 校验安装包的 minisign 签名
 *
 * 任何一步失败，玩家那边的"检查更新"就会失败，而这个失败在服务端是看不见的
 * （CNB 只会告诉你上传成功），所以必须在这里验。
 *
 * 用法：node tools/release/verify-endpoint.mjs
 */
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';

const ENDPOINT =
  'https://cnb.cool/IEML_Official/IEML-releases/-/releases/download/latest/latest.json';
const problems = [];
const ok = [];

// ---------- minisign ----------
/** 解一层外层 base64，取出 minisign 文本里的载荷行 */
function minisignPayload(wrapped) {
  let text = Buffer.from(wrapped.trim(), 'base64').toString('utf8');
  if (!text.startsWith('untrusted comment')) text = wrapped;
  const lines = text.trim().split(/\r?\n/);
  const line = lines.find((l) => l && !l.startsWith('untrusted comment') && !l.startsWith('trusted comment'));
  const buf = Buffer.from(line ?? '', 'base64');
  return {
    alg: buf.subarray(0, 2).toString('latin1'),
    keyId: buf.subarray(2, 10).toString('hex').toUpperCase(),
    body: buf.subarray(10),
    text,
  };
}

/** Ed25519 公钥（32 字节裸钥）→ node 的 KeyObject */
function ed25519Key(raw32) {
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw32]);
  return createPublicKey({ key: spki, format: 'der', type: 'spki' });
}

// ---------- 1. 拉清单 ----------
console.log('1) 匿名拉取更新端点…');
/*
 * ★ 网络错误要给人话，不要抛 Node 堆栈（2026-09-17 踩到）。
 *
 *   这台机器的 DNS 会间歇性解析不了 `asset.cnb.cool`（清单是 302 跳到那儿的），
 *   于是 `fetch` 抛 `EAI_AGAIN` + 一屏 undici 堆栈。
 *   看的人只会以为"发布炸了"，其实只是这次没解析出来 —— 重跑一次就好。
 *   ★ 但**不能因此把它当成通过**：所以这里退出码仍然是 1，
 *     只是把话说清楚，并给出"重跑"这个可行动作。
 */
let mres;
try {
  mres = await fetch(ENDPOINT, { redirect: 'follow' });
} catch (e) {
  const raw = e?.cause?.code ?? e?.message ?? String(e);
  console.error(`✗ 拉取端点失败：${raw}`);
  if (/EAI_AGAIN|ENOTFOUND|ECONN|ETIMEDOUT|fetch failed/i.test(String(raw))) {
    console.error('  这是**网络/DNS 问题**，不代表发布有问题 —— 重跑一次再判断。');
    console.error(`  （清单地址是 302 跳到 asset.cnb.cool，本机 DNS 偶尔解析不了它）`);
  }
  process.exit(1);
}
if (!mres.ok) {
  console.error(`✗ 端点返回 HTTP ${mres.status}`);
  process.exit(1);
}
const manifest = await mres.json();
const plat = manifest.platforms?.['windows-x86_64'];
if (!plat) {
  console.error('✗ 清单里没有 windows-x86_64');
  process.exit(1);
}
console.log(`   ✓ HTTP ${mres.status}  version=${manifest.version}`);
console.log(`   url = ${plat.url}`);

// 线上版本要和本地代码版本一致，否则是发错包了
const pkgVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
if (manifest.version === pkgVersion) ok.push(`线上版本 ${manifest.version} 与本地 package.json 一致`);
else problems.push(`线上版本 ${manifest.version} ≠ 本地 ${pkgVersion}`);

// ---------- 2. 下载产物 ----------
console.log('2) 匿名下载更新包…');
/*
 * ★★ 缓存名必须**带版本号**（2026-09-17 踩到）。
 *
 *   原来固定叫 `tmp/_verify-artifact.exe`。发完 beta.45 之后再跑，
 *   它复用了上一次下载的 **beta.44** 包，却拿 beta.45 的签名去验 ——
 *   于是报「Ed25519 签名验证失败，客户端会拒绝这个更新」，
 *   看起来像发布炸了，其实验的是上一版的文件。
 *
 *   ★ 这个 bug 的方向是**双向**的：错配会误报失败，但只要版本刚好对上，
 *     也可能拿旧包"验通过"——**一个会验错对象的检查工具比没有更危险**，
 *     因为它给出的是绿色。
 *
 *   所以：缓存按版本号分文件。换版本 = 自动换文件，不存在复用错的可能。
 */
const CACHE = `tmp/_verify-artifact-${manifest.version}.exe`;
if (!existsSync(CACHE) || statSync(CACHE).size === 0) {
  const ares = await fetch(plat.url, { redirect: 'follow' });
  if (!ares.ok) {
    console.error(`✗ 下载失败 HTTP ${ares.status}`);
    process.exit(1);
  }
  writeFileSync(CACHE, Buffer.from(await ares.arrayBuffer()));
  console.log('   ✓ 已下载');
} else {
  console.log(`   （复用缓存 ${CACHE}；删掉可强制重下）`);
}
const artifact = readFileSync(CACHE);
console.log(`   大小 ${(artifact.length / 1048576).toFixed(2)} MB`);

// 下载到的必须是真正的 PE 可执行文件，而不是错误页
if (artifact.subarray(0, 2).toString('latin1') === 'MZ') ok.push('下载到的是 PE 可执行文件（MZ 头）');
else problems.push(`下载到的不是 exe！前 64 字节：${artifact.subarray(0, 64).toString('utf8')}`);

// ---------- 3. 验签 ----------
console.log('3) 用内置 pubkey 校验签名…');
const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const pub = minisignPayload(conf.plugins.updater.pubkey.trim());
const sig = minisignPayload(plat.signature);

console.log(`   pubkey alg=${pub.alg}  keyId=${pub.keyId}  len=${pub.body.length}`);
console.log(`   sig    alg=${sig.alg}  keyId=${sig.keyId}  len=${sig.body.length}`);

if (pub.keyId === sig.keyId) ok.push(`key id 匹配（${pub.keyId}）`);
else problems.push(`key id 不匹配：公钥 ${pub.keyId} vs 签名 ${sig.keyId}`);

// 'ED' = 对 BLAKE2b-512 摘要签名（预哈希）；'Ed' = 对原文签名
const prehashed = sig.alg === 'ED';
const message = prehashed ? createHash('blake2b512').update(artifact).digest() : artifact;
console.log(`   签名算法 ${sig.alg}（${prehashed ? 'BLAKE2b-512 预哈希' : '原文直签'}）`);

let valid = false;
try {
  valid = edVerify(null, message, ed25519Key(pub.body), sig.body);
} catch (e) {
  problems.push(`验签抛异常：${e.message}`);
}
if (valid) ok.push('Ed25519 签名验证通过 —— 客户端能装上这个更新');
else if (!problems.some((p) => p.startsWith('验签抛异常')))
  problems.push('Ed25519 签名验证失败 —— 客户端会拒绝这个更新');

for (const l of ok) console.log('  ✓ ' + l);
for (const l of problems) console.log('  ✗ ' + l);
console.log('');
if (problems.length) {
  console.error(`更新通道自检未通过：${problems.length} 项问题。`);
  process.exit(1);
}
console.log('更新通道自检通过：玩家点"检查更新"能拿到并装上新版本。');
