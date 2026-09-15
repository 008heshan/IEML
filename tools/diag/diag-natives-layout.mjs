// 诊断：1.20.1 与 26.2 的 jvm 参数里，natives 相关的路径是什么？
// 目的：确认"natives 该解压到哪一层"随版本变了。
// 用法：node tools/diag-natives-layout.mjs
import fs from 'node:fs';
import path from 'node:path';

const shared = path.join(process.env.APPDATA, 'IEML', 'shared', 'versions');

for (const id of fs.readdirSync(shared)) {
  const p = path.join(shared, id, `${id}.json`);
  if (!fs.existsSync(p)) continue;
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const jvm = (j.arguments && j.arguments.jvm) || [];
  const flat = jvm.map((a) => (typeof a === 'string' ? a : JSON.stringify(a)));
  const relevant = flat.filter((s) => /natives|lwjgl|jna|netty/i.test(s));
  console.log(`\n===== ${id} =====`);
  if (relevant.length === 0) console.log('  （模板里没有任何 natives 相关参数 → 由启动器补 -Djava.library.path）');
  for (const s of relevant) console.log('  ', s);
}
