// 直接检查磁盘上的版本 JSON 是否缺基础库（诊断修复脚本为什么没动手）
import fs from 'node:fs';
import path from 'node:path';

const vs = path.join(process.env.APPDATA ?? '', 'IEML', 'shared', 'versions');
console.log(`扫描 ${vs}\n`);

for (const dir of fs.readdirSync(vs)) {
  const p = path.join(vs, dir, `${dir}.json`);
  if (!fs.existsSync(p)) {
    console.log(`${dir}: （没有 ${dir}.json）`);
    continue;
  }
  const raw = fs.readFileSync(p, 'utf8');
  const j = JSON.parse(raw);
  const names = (j.libraries ?? []).map((l) => l.name);
  console.log(`${dir}:`);
  console.log(`  id=${j.id}  inheritsFrom=${j.inheritsFrom ?? '(无)'}  库=${names.length}`);
  console.log(`  含基础 lwjgl(org.lwjgl:lwjgl:3.4.1)=${names.includes('org.lwjgl:lwjgl:3.4.1')}`);
  const lwjgl = names.filter((n) => /^org\.lwjgl:lwjgl:/.test(n));
  console.log(`  lwjgl 条目: ${JSON.stringify(lwjgl)}`);
  if (j.arguments) {
    console.log(`  arguments: jvm=${(j.arguments.jvm ?? []).length} game=${(j.arguments.game ?? []).length}`);
  } else {
    console.log('  arguments: (无)');
  }
  // 磁盘上的 jar
  const jar = path.join(vs, dir, `${dir}.jar`);
  console.log(`  jar: ${fs.existsSync(jar) ? fs.statSync(jar).size + ' B' : '(无)'}`);
  console.log('');
}
