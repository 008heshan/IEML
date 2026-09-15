/* 检查真实版本 JSON 里 natives 的写法 */
const res = await fetch('https://bmclapi2.bangbang93.com/version/1.20.1/json', {
  headers: { 'user-agent': 'IEML/0.1' },
});
const v = await res.json();

console.log('=== 库总数:', v.libraries.length);

const withNatives = v.libraries.filter((l) => l.natives);
console.log('=== 带 natives 字段的库:', withNatives.length);
for (const l of withNatives.slice(0, 8)) {
  console.log(`\n  ${l.name}`);
  console.log(`    natives = ${JSON.stringify(l.natives)}`);
  console.log(`    extract = ${JSON.stringify(l.extract)}`);
  const cls = Object.keys(l.downloads?.classifiers ?? {});
  console.log(`    classifiers = ${JSON.stringify(cls)}`);
}

console.log('\n=== 带 rules 的库数量:', v.libraries.filter((l) => l.rules?.length).length);
console.log('=== 带 clientreq 的库:', v.libraries.filter((l) => l.clientreq !== undefined).length);

// 找出所有平台限定的规则，看我们是否漏掉了什么
console.log('\n=== 一个典型的 natives 库的完整结构 ===');
if (withNatives[0]) console.log(JSON.stringify(withNatives[0], null, 2));
