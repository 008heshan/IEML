/* 开发服务器自检：确认 HTML 与各模块都能编译返回 */
const base = process.argv[2] ?? 'http://localhost:5199';

async function probe(path) {
  const url = base + path;
  try {
    const res = await fetch(url, { redirect: 'follow' });
    const text = await res.text();
    const bad = res.status >= 400 || text.includes('Internal Server Error') || text.includes('Failed to resolve');
    return { path, status: res.status, len: text.length, bad, sample: bad ? text.slice(0, 300) : '' };
  } catch (e) {
    return { path, status: 0, len: 0, bad: true, sample: String(e.message) };
  }
}

const paths = [
  '/',
  '/src/main.tsx',
  '/src/app/App.tsx',
  '/src/state/AppContext.tsx',
  '/src/domain/index.ts',
  '/src/domain/combination.ts',
  '/src/domain/crash.ts',
  '/src/bridge/index.ts',
  '/src/bridge/web.ts',
  '/src/ui/index.tsx',
  '/src/ui/Icons.tsx',
  '/src/components/InstanceSwitcher.tsx',
  '/src/components/TaskCenter.tsx',
  '/src/pages/HomePage.tsx',
  '/src/pages/VersionsPage.tsx',
  '/src/pages/InstancePage.tsx',
  '/src/pages/ModsPage.tsx',
  '/src/pages/DiscoverPage.tsx',
  '/src/pages/ModpacksPage.tsx',
  '/src/pages/SettingsPage.tsx',
  '/src/pages/CreateInstanceModal.tsx',
  '/src/pages/CrashModal.tsx',
  '/src/styles/tokens.css',
  '/src/styles/app.css',
  '/src/styles/pages.css',
];

const results = [];
for (const p of paths) results.push(await probe(p));

let failed = 0;
for (const r of results) {
  const mark = r.bad ? '✗' : '✓';
  if (r.bad) failed++;
  console.log(`${mark} ${String(r.status).padStart(3)} ${String(r.len).padStart(7)}B  ${r.path}`);
  if (r.bad && r.sample) console.log('     ' + r.sample.replace(/\n/g, '\n     '));
}
console.log('');
console.log(failed === 0 ? `全部 ${results.length} 个模块编译通过` : `${failed} / ${results.length} 个模块有问题`);
process.exit(failed === 0 ? 0 : 1);
