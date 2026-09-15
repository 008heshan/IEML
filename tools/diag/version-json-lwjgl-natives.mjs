/* 找出 LWJGL natives 在 1.20.1 里的真实表示方式 */
const res = await fetch('https://bmclapi2.bangbang93.com/version/1.20.1/json', {
  headers: { 'user-agent': 'IEML/0.1' },
});
const v = await res.json();

console.log('=== 所有含 natives 字样的库（名字或 classifier）===');
for (const l of v.libraries) {
  const name = l.name;
  const cls = Object.keys(l.downloads?.classifiers ?? {});
  const hasNativeWord = name.includes('natives') || cls.some((c) => c.includes('natives'));
  if (!hasNativeWord) continue;

  const arts = l.downloads?.artifact;
  console.log(`\n  ${name}`);
  console.log(`    rules    = ${JSON.stringify(l.rules)}`);
  console.log(`    artifact = ${arts ? arts.path || arts.url : '(无)'}`);
  console.log(`    classifiers = ${JSON.stringify(cls)}`);
  if (cls.length) {
    for (const c of cls) {
      console.log(`      ${c} -> ${l.downloads.classifiers[c].path || l.downloads.classifiers[c].url}`);
    }
  }
}

console.log('\n=== 按 artifact 是否为空统计 ===');
const noArt = v.libraries.filter((l) => !l.downloads?.artifact);
console.log('  没有 artifact 的库:', noArt.length);
for (const l of noArt.slice(0, 10)) {
  console.log(`    ${l.name}`);
  console.log(`      classifiers: ${JSON.stringify(Object.keys(l.downloads?.classifiers ?? {}))}`);
  console.log(`      rules: ${JSON.stringify(l.rules)}`);
}

console.log('\n=== 某个 lwjgl 库的完整结构 ===');
const lwjgl = v.libraries.find((l) => l.name.includes('lwjgl') && l.name.includes('natives'));
if (lwjgl) console.log(JSON.stringify(lwjgl, null, 2));
