// 就地修复一个"合并出来缺库"的加载器版本 JSON。
//
// 背景：旧版去重键是 `group:artifact`（丢了 classifier），Fabric profile 里
// `org.lwjgl:lwjgl:3.4.1:natives-linux` 会把原版的 `org.lwjgl:lwjgl:3.4.1`
// 顶掉 —— 于是磁盘上的合并 JSON 缺基础库，游戏起不来。
// 新代码已经修好，但**旧文件还是坏的**；这个脚本按新规则重算一遍。
//
// 用法：node tools/diag/fix-merged-version-json.mjs [--apply]
import fs from 'node:fs';
import path from 'node:path';

const apply = process.argv.includes('--apply');
const vs = path.join(process.env.APPDATA ?? '', 'IEML', 'shared', 'versions');
if (!fs.existsSync(vs)) {
  console.error(`找不到 ${vs}`);
  process.exit(1);
}

const read = (dir) => {
  const p = path.join(vs, dir, `${dir}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
};

/** 与 Rust `installer::lib_key` 保持一致：group:artifact[:classifier] */
function libKey(name) {
  const p = String(name).split(':');
  if (p.length <= 2) return p.slice(0, 2).join(':');
  if (p.length === 3) return p.slice(0, 2).join(':');
  return `${p[0]}:${p[1]}:${p[3]}`;
}

/** 与 Rust `installer::merge_versions` 保持一致 */
function merge(child, parent) {
  const out = { ...child };
  if (!out.mainClass) out.mainClass = parent.mainClass;
  if (!out.assets) out.assets = parent.assets;
  if (!out.assetIndex) out.assetIndex = parent.assetIndex;
  if (!out.downloads) out.downloads = parent.downloads;
  if (!out.javaVersion) out.javaVersion = parent.javaVersion;

  const seen = new Set();
  const libs = [];
  for (const l of [...(child.libraries ?? []), ...(parent.libraries ?? [])]) {
    const k = libKey(l.name);
    if (seen.has(k)) continue;
    seen.add(k);
    libs.push(l);
  }
  out.libraries = libs;

  const ca = child.arguments ?? {};
  const pa = parent.arguments ?? {};
  out.arguments = {
    game: [...(ca.game ?? []), ...(pa.game ?? [])],
    jvm: [...(ca.jvm ?? []), ...(pa.jvm ?? [])],
  };
  return out;
}

let fixed = 0;
for (const dir of fs.readdirSync(vs)) {
  const j = read(dir);
  if (!j?.inheritsFrom) continue;
  const parent = read(j.inheritsFrom);
  if (!parent) continue;

  const has = (j.libraries ?? []).some((l) => l.name === 'org.lwjgl:lwjgl:3.4.1');
  const parentHas = (parent.libraries ?? []).some((l) => l.name === 'org.lwjgl:lwjgl:3.4.1');
  if (has || !parentHas) continue;

  const merged = merge(j, parent);
  console.log(
    `${dir}: 库 ${(j.libraries ?? []).length} → ${merged.libraries.length}` +
      `（补回 ${merged.libraries.length - (j.libraries ?? []).length} 个，含基础 lwjgl）`,
  );
  if (apply) {
    fs.writeFileSync(
      path.join(vs, dir, `${dir}.json`),
      JSON.stringify(merged, null, 2),
      'utf8',
    );
    // 启动侧还会按 mc 版本号找，两个名字都写
    const mcPath = path.join(vs, dir, `${j.inheritsFrom}.json`);
    fs.writeFileSync(mcPath, JSON.stringify(merged, null, 2), 'utf8');
    fixed++;
  }
}
console.log(apply ? `\n✓ 已修复 ${fixed} 个版本 JSON` : '\n（只报告。加 --apply 才会写入）');
