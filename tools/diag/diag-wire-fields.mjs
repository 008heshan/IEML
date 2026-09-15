// 诊断：找出「Rust 序列化出的下划线字段」与「前端实际读取的字段名」不一致的地方。
//
// 为什么会需要它：跨 IPC 边界的字段名不匹配，编译器完全抓不到。
// 实测踩过：前端发 camelCase（memoryMb），Rust 收 snake_case（memory_mb）
// → `missing field memory_mb`，实例一个都存不下。
//
// 用法：node tools/diag-wire-fields.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = 'E:/IEML';

/** 1. 收集 Rust 侧所有 #[derive(Serialize/Deserialize)] struct 的字段 */
function rustStructs() {
  const out = new Map(); // structName -> { file, fields: [{rust, camel}], camelCase: bool }
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.rs')) files.push(p);
    }
  };
  walk(path.join(root, 'src-tauri', 'src'));

  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const re = /#\[derive\(([^)]*)\)\]\s*(?:#\[[^\]]*\]\s*)*pub struct (\w+)\s*\{([\s\S]*?)\n\}/g;
    let m;
    while ((m = re.exec(src))) {
      const derives = m[1];
      if (!/Serialize|Deserialize/.test(derives)) continue;
      const name = m[2];
      const body = m[3];
      const camelAttr = /rename_all\s*=\s*"camelCase"/.test(src.slice(Math.max(0, m.index - 400), m.index + 200));
      const fields = [];
      for (const line of body.split('\n')) {
        const fm = /^\s*pub (\w+):/.exec(line);
        if (fm) fields.push(fm[1]);
      }
      out.set(name, {
        file: path.relative(root, f).replace(/\\/g, '/'),
        fields,
        camelCase: camelAttr,
      });
    }
  }
  return out;
}

const toCamel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

const structs = rustStructs();
const underscored = [...structs.entries()].filter(([, v]) =>
  v.fields.some((f) => f.includes('_')),
);

console.log(`Rust 侧带下划线字段的 struct：${underscored.length} 个\n`);

/** 2. 前端所有 TS 文件文本（用于搜索字段名是否被真实读取） */
const tsFiles = [];
const walkTs = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walkTs(p);
    else if (/\.(ts|tsx)$/.test(e.name)) tsFiles.push(p);
  }
};
walkTs(path.join(root, 'src'));
const tsText = tsFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

const suspects = [];
for (const [name, info] of underscored) {
  for (const f of info.fields) {
    if (!f.includes('_')) continue;
    const camel = toCamel(f);
    const snakeUsed = new RegExp(`\\b${f}\\b`).test(tsText);
    const camelUsed = new RegExp(`\\b${camel}\\b`).test(tsText);
    if (camelUsed && !info.camelCase) {
      suspects.push({ struct: name, file: info.file, rust: f, frontend: camel });
    } else if (snakeUsed && !info.camelCase) {
      // 前端按 snake_case 读 —— 与 Rust 一致，没问题，但记下来
    }
  }
}

if (suspects.length === 0) {
  console.log('✓ 没有发现"前端按 camelCase 读、Rust 按 snake_case 发"的字段');
} else {
  console.log('★ 可疑字段（前端读 camelCase，但 Rust struct 没有 rename_all=camelCase）：');
  for (const s of suspects) {
    console.log(`   ${s.struct}.${s.rust}  →  前端用 ${s.frontend}   [${s.file}]`);
  }
}
