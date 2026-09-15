// 检查 release exe 里是否含有指定的字符串（按 UTF-8 解码搜索）
// 用法：node tools/gates/exe-strings.mjs <exe路径> <关键字...>
import fs from 'node:fs';

const [, , exe, ...keys] = process.argv;
if (!exe || keys.length === 0) {
  console.error('用法: node tools/gates/exe-strings.mjs <exe> <关键字...>');
  process.exit(2);
}
const buf = fs.readFileSync(exe);
const text = buf.toString('utf8');
for (const k of keys) {
  console.log(`${k}\t${text.includes(k) ? 'FOUND' : 'MISSING'}`);
}
