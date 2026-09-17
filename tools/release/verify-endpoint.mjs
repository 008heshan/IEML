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
const CACHE = 'tmp/_verify-artifact.exe';
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
const mres = await fetch(ENDPOINT, { redirect: 'follow' });
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
if (!existsSync(CACHE) || statSync(CACHE).size === 0) {
  const ares = await fetch(plat.url, { redirect: 'follow' });
  if (!ares.ok) {
    console.error(`✗ 下载失败 HTTP ${ares.status}`);
    process.exit(1);
  }
  writeFileSync(CACHE, Buffer.from(await ares.arrayBuffer()));
  console.log(`   ✓ 已下载`);
} else {
  console.log('   （使用 tmp/_verify-artifact.exe 缓存；删掉可强制重下）');
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
