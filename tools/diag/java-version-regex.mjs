/* 验证 Java 版本解析正则（旧 vs 新） */
const samples = [
  'openjdk version "17.0.20" 2024-01-16',
  'java version "1.8.0_402"',
  'openjdk version "21" 2023-09-19',
  'openjdk version "25.0.3" 2025-10-21',
  'openjdk version "11.0.24" 2024-07-16',
  'java version "1.7.0_80"',
];

const bad = /version "1?(\d+)"/;        // 旧写法：在 "17.0.20" 上贪婪吃掉 1，剩 7
const good = /version "(?:1\.)?(\d+)/;  // 新写法：显式匹配 "1." 前缀

console.log('样本'.padEnd(40) + '  旧  新');
let badCount = 0;
let goodFail = 0;
for (const s of samples) {
  const b = s.match(bad)?.[1] ?? '?';
  const g = s.match(good)?.[1] ?? '?';
  const expected = s.includes('"1.') ? s.match(/"1\.(\d+)/)?.[1] : s.match(/"(\d+)/)?.[1];
  if (b !== expected) badCount++;
  if (g !== expected) goodFail++;
  console.log(`${s.padEnd(40)}  ${String(b).padStart(2)}  ${String(g).padStart(2)}   期望 ${expected}`);
}
console.log(`\n旧正则错误 ${badCount} 处 / 新正则错误 ${goodFail} 处`);
