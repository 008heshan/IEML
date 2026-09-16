/*
 * Adoptium 国内镜像摸底（不依赖 api.adoptium.net —— 它当前不可达）
 *
 * 目标：
 *   ① 镜像到底有没有？目录结构是什么样？
 *   ② 有没有随包发布的 .sha256.txt / .json 元数据（决定能否离线校验）
 *   ③ 下载速度
 */
const BASES = [
  ['清华 TUNA', 'https://mirrors.tuna.tsinghua.edu.cn/Adoptium'],
  ['南大 NJU', 'https://mirror.nju.edu.cn/Adoptium'],
  ['北外 BFSU', 'https://mirrors.bfsu.edu.cn/Adoptium'],
  ['上交 SJTU', 'https://mirror.sjtu.edu.cn/Adoptium'],
];

async function get(url, ms = 12000) {
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'IEML-Launcher/0.1' } });
    const text = await res.text();
    clearTimeout(timer);
    return { status: res.status, text, ms: Date.now() - t0, bytes: Buffer.byteLength(text) };
  } catch (e) {
    clearTimeout(timer);
    return { status: 0, text: '', ms: Date.now() - t0, err: e.name };
  }
}

/** 从 nginx/autoindex 的 HTML 里抽出链接 */
function links(html) {
  const out = [];
  const re = /href="([^"?#]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const h = decodeURIComponent(m[1]);
    if (h.startsWith('..') || h.startsWith('/') || h.startsWith('http')) continue;
    out.push(h);
  }
  return [...new Set(out)];
}

console.log('Adoptium 国内镜像摸底\n');

for (const [name, base] of BASES) {
  console.log(`── ${name}  ${base} ──`);
  const root = await get(base + '/');
  if (root.status !== 200) {
    console.log(`   根目录: ${root.status ? `HTTP ${root.status}` : `失败(${root.err})`}  ${root.ms}ms\n`);
    continue;
  }
  const top = links(root.text);
  console.log(`   根目录 HTTP 200  ${root.ms}ms  条目: ${top.slice(0, 14).join(' ')}${top.length > 14 ? ' …' : ''}`);

  // 往下钻：/<major>/jre/<arch>/<os>/
  for (const major of ['21', '17']) {
    const dir = `${base}/${major}/jre/x64/windows/`;
    const r = await get(dir);
    if (r.status !== 200) {
      console.log(`   ${major}/jre/x64/windows : ${r.status ? `HTTP ${r.status}` : `失败(${r.err})`}`);
      continue;
    }
    const files = links(r.text).filter((f) => !f.endsWith('/'));
    const zips = files.filter((f) => f.endsWith('.zip'));
    const meta = files.filter((f) => /\.(txt|json|sha256)$/i.test(f));
    console.log(`   ${major}/jre/x64/windows : HTTP 200  ${zips.length} 个 zip, ${meta.length} 个元数据文件`);
    if (zips[0]) console.log(`      zip  : ${zips[0]}`);
    if (meta[0]) console.log(`      元数据: ${meta.slice(0, 4).join(' , ')}`);

    // 有 sha256 文件就抓来看看
    const sha = files.find((f) => /sha256/i.test(f));
    if (sha) {
      const s = await get(dir + sha);
      if (s.status === 200) console.log(`      sha256 内容: ${s.text.trim().slice(0, 100)}`);
    }
  }
  console.log('');
}
