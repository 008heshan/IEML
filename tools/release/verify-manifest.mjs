// 发布前自检：确保 tmp/latest.json 里的签名、公钥、下载地址三者自洽。
// 这类错误在客户端表现为"更新失败"，在服务端完全看不出来，所以必须在传之前拦住。
import { readFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';

const problems = [];
const ok = [];
function check(cond, good, bad) {
  (cond ? ok : problems).push(cond ? good : bad);
}

// ---- 1. 清单本身 ----
const MANIFEST = 'tmp/latest.json';
if (!existsSync(MANIFEST)) {
  console.error('✗ 没有 tmp/latest.json，先跑 node tools/release/publish-cnb.mjs');
  process.exit(1);
}
const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

check(m.version === pkg.version, `版本号一致：${m.version}`, `版本号不一致：清单 ${m.version}，package.json ${pkg.version}`);

// CHANGELOG 的 notes 必须是能读的中文，不能是乱码
check(!m.notes.includes('\uFFFD'), 'notes 无乱码', 'notes 含替换字符 U+FFFD —— 编码坏了');
check(/^## /.test(m.notes.trim()), 'notes 是 CHANGELOG 里的一节', 'notes 为空或不是 CHANGELOG 小节');
check(m.notes.includes(m.version), `notes 提到了 ${m.version}`, `notes 里没有 ${m.version}，可能抓错了小节`);

// ---- 2. 平台条目 ----
const plat = m.platforms?.['windows-x86_64'];
check(!!plat, '存在 windows-x86_64 条目', '缺少 windows-x86_64 条目');
if (plat) {
  check(!!plat.signature, '有 signature', 'signature 为空');
  check(/^https:\/\//.test(plat.url), 'url 是 https', `url 不是 https：${plat.url}`);
  check(plat.url.includes(m.version), `url 指向 ${m.version} 的包`, `url 里的版本号和清单不一致：${plat.url}`);
  // 端点是写死在 tauri.conf.json 里的静态地址，必须指向同一个清单
  const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  const endpoints = conf.plugins?.updater?.endpoints ?? [];
  check(endpoints.length === 1, 'tauri.conf.json 只配了 1 个端点（多端点会掩盖故障）', `tauri.conf.json 配了 ${endpoints.length} 个端点`);
  // ★ 这里只查"有没有"；"是不是一把真公钥"由下面的载荷长度检查负责。
  //   （别再用 `includes('RW')` 之类的土办法猜 —— 那种判据会随密钥内容偶发误报，
  //     我第一版就是那么写的，ieml2 恰好蒙对、ieml3 直接误报。）
  const confPub = conf.plugins?.updater?.pubkey;
  check(
    typeof confPub === 'string' && confPub.trim().length > 0,
    'tauri.conf.json 内置了 pubkey',
    'tauri.conf.json 没有 pubkey —— 客户端无法验签'
  );

  // ---- 3. 最关键：签名与公钥必须同源 ----
  // 两者的封装都是「一层 base64 包着 minisign 文本」，文本里再有一条 base64 载荷行。
  // minisign 载荷 = 算法(2) + key id(8) + 内容（签名 64 / 公钥 32）。
  // 早期版本这里漏了外层解码，把 "untrusted" 的第 3 个字节当成了 key id，误报不同源。
  function minisignPayload(wrapped) {
    let text = Buffer.from(wrapped.trim(), 'base64').toString('utf8');
    if (!text.startsWith('untrusted comment')) text = wrapped; // 传进来的已经是文本
    const line = text
      .trim()
      .split(/\r?\n/)
      .find((l) => l && !l.startsWith('untrusted comment') && !l.startsWith('trusted comment'));
    const buf = Buffer.from(line ?? '', 'base64');
    return { id: buf.subarray(2, 10).toString('hex').toUpperCase(), len: buf.length, text };
  }

  const pub = minisignPayload(conf.plugins.updater.pubkey.trim());
  const sig = minisignPayload(plat.signature);
  check(pub.id === sig.id, `签名与公钥同源（key id ${pub.id}）`, `签名与公钥不同源！公钥 ${pub.id}，签名 ${sig.id} —— 客户端会拒绝更新`);
  check(sig.len === 74, `签名载荷长度正常（${sig.len} 字节）`, `签名载荷长度异常：${sig.len} 字节，应为 74`);
  check(pub.len === 42, `公钥载荷长度正常（${pub.len} 字节）`, `公钥载荷长度异常：${pub.len} 字节，应为 42`);
  check(
    sig.text.includes(m.version),
    `签名内嵌了文件名（可信注释里记着 ${m.version}）`,
    `签名里的可信注释不是 ${m.version} 的产物 —— 可能是旧签名`
  );

  // 签名文件必须真的是本地那个产物的签名
  const localSig = join('src-tauri/target/release/bundle/nsis', basename(plat.url) + '.sig');
  if (existsSync(localSig)) {
    check(readFileSync(localSig, 'utf8').trim() === plat.signature.trim(), '清单里的签名来自本地产物', '清单里的签名和本地 .sig 不一致');
  } else {
    problems.push(`找不到本地签名文件 ${localSig}，无法确认清单里的签名出自本地构建`);
  }
  const localExe = join('src-tauri/target/release/bundle/nsis', basename(plat.url));
  check(existsSync(localExe), `本地存在 ${basename(plat.url)}`, `本地没有 ${basename(plat.url)}，上传会失败`);
}

for (const line of ok) console.log('  ✓ ' + line);
for (const line of problems) console.log('  ✗ ' + line);
console.log('');
if (problems.length) {
  console.error(`自检未通过：${problems.length} 项问题，别急着上传。`);
  process.exit(1);
}
console.log(`自检通过：${ok.length} 项全绿，可以 node tools/release/publish-cnb.mjs --upload`);
