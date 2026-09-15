// 直接读 jar 的中央目录，检查某个类在不在里面（不解压整个 jar）
// 用法：node tools/diag/jar-has-class.mjs <jar路径> <类路径片段...>
import fs from 'node:fs';

const [jar, ...needles] = process.argv.slice(2);
if (!jar || needles.length === 0) {
  console.error('用法: node tools/diag/jar-has-class.mjs <jar> <片段...>');
  process.exit(2);
}
const buf = fs.readFileSync(jar);

// 找 EOCD
let eocd = -1;
for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) {
    eocd = i;
    break;
  }
}
if (eocd < 0) {
  console.error('不是 zip（找不到 EOCD）');
  process.exit(1);
}
const count = buf.readUInt16LE(eocd + 10);
let off = buf.readUInt32LE(eocd + 16);
const names = [];
for (let i = 0; i < count; i++) {
  if (buf.readUInt32LE(off) !== 0x02014b50) break;
  const nameLen = buf.readUInt16LE(off + 28);
  const extraLen = buf.readUInt16LE(off + 30);
  const commentLen = buf.readUInt16LE(off + 32);
  names.push(buf.slice(off + 46, off + 46 + nameLen).toString('utf8'));
  off += 46 + nameLen + extraLen + commentLen;
}
console.log(`${jar}\n  条目数 ${names.length}`);
for (const n of needles) {
  const hits = names.filter((x) => x.includes(n));
  console.log(`  含 "${n}" 的条目：${hits.length}`);
  for (const h of hits.slice(0, 5)) console.log(`      ${h}`);
}
