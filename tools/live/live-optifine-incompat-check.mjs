/**
 * 真机验证：**选了 Fabric 之后，高清修复这件事必须如实说清**。
 * ------------------------------------------------------------------
 * 用户原话：「当我们选择 Fabic 时如果有版本的 Fabic 与高清修复不兼容，
 * 应提示玩家不兼容」。
 *
 * ## 这条规则有**两半**，两半都要验
 *
 *   ① 1.14 ~ 1.20.4 —— 桥接包 **OptiFabric 是有的**，但**要玩家自己下**。
 *      界面必须说清「缺的是 OptiFabric」+「下载地址」，
 *      并且**不许**再说「会自动装」（没有任何代码会去下它）。
 *   ② 1.20.5 及以上 —— 上游**真的没有**桥接包 → 判不兼容、
 *      安装按钮被拦住、理由可行动（换 Forge / Iris+Sodium）。
 *
 * ## dev.10 在这里判错过一次，所以两个版本段都要逐个跑
 *
 *   上一轮我只验了 ①（而且是反的：把这一段判成了"不兼容"），
 *   依据是 Modrinth 上 `optifabric` 返回 404。**查错了平台** ——
 *   OptiFabric 一直在 CurseForge 项目 322385 发布
 *   （75 个文件 / 1005 万次下载），MC百科 class/1703 的支持表列到 1.20.4。
 *
 * ## 版本选择
 *
 *   * `1.20.1` —— OptiFine 有正式版，且 OptiFabric 覆盖 → 验"有桥接包"；
 *   * `1.20.6` —— 超出 1.20.4 → 验"真的不兼容"。
 *   （不用 1.20.5：OptiFine 自己在这一版是 0 条发布，会被"上游没有 OptiFine"
 *     先拦住，测的就不是桥接这件事了。）
 *
 * 用法：node tools/live/live-optifine-incompat-check.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const PORT = 9339;
const EXE = path.join(process.env.USERPROFILE ?? '', 'Desktop', 'IEML.exe');
if (!existsSync(EXE)) {
  console.error(`找不到桌面版：${EXE}`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const proc = spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: 'ignore',
});

let page = null;
for (let i = 0; i < 50; i += 1) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    const list = await r.json();
    page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) break;
  } catch {
    /* 还没起来 */
  }
  await sleep(500);
}
if (!page) {
  console.error('CDP 没起来');
  proc.kill();
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const evaluate = (expression) => {
  const myId = ++id;
  return new Promise((resolve) => {
    pending.set(myId, (msg) => {
      if (msg.error) return resolve({ __err: JSON.stringify(msg.error) });
      if (msg.result?.exceptionDetails) {
        return resolve({
          __err:
            msg.result.exceptionDetails.text +
            ' :: ' +
            (msg.result.exceptionDetails.exception?.description ?? ''),
        });
      }
      resolve(msg.result?.result?.value);
    });
    ws.send(
      JSON.stringify({
        id: myId,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      }),
    );
  });
};

for (let i = 0; i < 60; i += 1) {
  const ok = await evaluate(
    `(() => { const t = document.body.innerText || ''; return t.length > 50 && !t.includes('正在准备'); })()`,
  );
  if (ok === true) break;
  await sleep(500);
}

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? `  —— ${extra}` : ''}`);
  if (!ok) failed += 1;
};

/* ---------- 进「下载」页 ---------- */
const gotoDownload = `(async () => {
  const byText = (re) => [...document.querySelectorAll('button')]
    .find(b => re.test((b.textContent||'').trim()));
  const dl = byText(/^下载$/);
  if (!dl) return { ok: false, why: '找不到「下载」入口' };
  dl.click();
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (document.querySelectorAll('.wz-item').length > 0) break;
  }
  await new Promise(r => setTimeout(r, 1000));
  return { ok: true };
})()`;
const nav = await evaluate(gotoDownload);
if (nav?.ok !== true) {
  console.error(`进不了下载页：${nav?.why ?? JSON.stringify(nav)}`);
  ws.close();
  proc.kill();
  process.exit(1);
}

/**
 * 在下载页里选一个 MC 版本 + Fabric，再勾高清修复，把界面上的结论读回来。
 * ★ 这段每次都要从**版本清单**重新点一遍 —— 不能复用上一次的状态，
 *   否则读到的会是上一个版本的残留文案（那个坑在 InstallComposer 里修过）。
 */
const probe = (mcVersion) => `(async () => {
  const text = () => document.body.innerText || '';

  const row = [...document.querySelectorAll('.wz-item')]
    .find(el => (el.querySelector('.wz-item-name')?.textContent||'').trim() === '${mcVersion}');
  if (!row) return { ok: false, why: '版本清单里没有 ${mcVersion}' };
  row.click();
  // 等加载器清单查回来（要联网）
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    const f = document.querySelector('.base-opt');
    if (f && !f.disabled) break;
  }
  await new Promise(r => setTimeout(r, 1500));

  const fabric = [...document.querySelectorAll('.base-opt')]
    .find(b => (b.querySelector('.b-name')?.textContent||'').includes('Fabric'));
  if (!fabric) return { ok: false, why: '找不到 Fabric 选项' };
  if (fabric.disabled) return { ok: false, why: 'Fabric 是灰的（在线清单没查到？）' };
  fabric.click();
  await new Promise(r => setTimeout(r, 2000));

  const beforeOptifine = text();

  const of = [...document.querySelectorAll('.addon-opt')]
    .find(b => (b.textContent||'').includes('OptiFine'));
  if (!of) return { ok: false, why: '找不到 OptiFine 开关' };
  const ofDisabled = of.disabled === true;
  if (!ofDisabled) of.click();
  await new Promise(r => setTimeout(r, 2500));

  const after = text();
  const ofBtn = [...document.querySelectorAll('.addon-opt')]
    .find(b => (b.textContent||'').includes('OptiFine'));

  const installBtn = [...document.querySelectorAll('button')]
    .find(b => /^安装\\s/.test((b.textContent||'').trim()));

  return {
    ok: true,
    ofDisabled,
    ofText: ofBtn ? (ofBtn.textContent||'').trim() : '',
    hasIncompatibleWord: /不兼容/.test(after),
    mentionsOptiFabric: /OptiFabric/.test(after),
    mentionsForge: /换 Forge|Forge 作基座/.test(after),
    mentionsIris: /Iris/.test(after),
    // 手动下载：地址 + 明确说"要你自己下"
    mentionsManual: /要你自己下载|自行下载|手动/.test(after),
    mentionsCfUrl: /curseforge\\.com/.test(after),
    installDisabled: installBtn ? installBtn.disabled === true : null,
    installLabel: installBtn ? (installBtn.textContent||'').trim() : null,
    /*
     * ★ 这两句文案必须**彻底消失**：
     *   · 「OptiFine 会在装完原版后自动安装」—— 桥接包要用户自己下，
     *     光装 OptiFine 游戏会崩（MC百科原话「二者必须同时加载，否则游戏将崩溃」）；
     *   · 「会自动装 OptiFabric」—— 没有任何生产路径会去下载它。
     *   （注意不能直接匹配"自动安装"四个字：CurseForge 那个地址的标题里
     *     就带"自动安装"，会被误伤 —— 所以匹配带主语的完整句式。）
     */
    saysOfAutoInstall: /OptiFine 会在装完原版后自动安装/.test(after),
    saysBridgeAutoInstall: /会自动装\\s*OptiFabric|自动安装 OptiFabric|将自动安装 OptiFabric/.test(after),
    // 反过来：必须给出"还差桥接包"的说明
    saysNeedsBridgeToo: /还差一个桥接包|必须和桥接包/.test(after),
    hadIncompatibleBefore: /不兼容/.test(beforeOptifine),
    textTail: after.slice(-600),
  };
})()`;

/* ====================== ① 1.20.1：有桥接包，但必须手动 ====================== */
console.log('\n=== ① 1.20.1 + Fabric + 高清修复（桥接包存在，需手动下载）===');
const r1 = await evaluate(probe('1.20.1'));
console.log(JSON.stringify(r1, null, 2));
if (!r1?.ok) {
  check('1.20.1 能走到「Fabric + 高清修复」这一步', false, r1?.why);
} else {
  check('★ 提示里点名 OptiFabric（缺的是哪个包）', r1.mentionsOptiFabric === true);
  check('★ 说清要玩家自己下载', r1.mentionsManual === true, r1.textTail.slice(-160));
  check('★ 给出可点的下载地址（CurseForge）', r1.mentionsCfUrl === true);
  check(
    '★ **不再**说「OptiFine 会在装完原版后自动安装」（会让用户以为装完就能玩，实际会崩）',
    r1.saysOfAutoInstall === false,
    r1.saysOfAutoInstall ? '桥接包要自己下，却还写着 OptiFine 自动装好就能用' : '',
  );
  check(
    '★ **不再**说「会自动装 OptiFabric」（没有代码会去下它）',
    r1.saysBridgeAutoInstall === false,
    r1.saysBridgeAutoInstall ? '又写了"会自动装桥接包"这句假承诺' : '',
  );
  check(
    '★ 反过来要说明"还差一个桥接包，缺了会崩"',
    r1.saysNeedsBridgeToo === true,
    r1.saysNeedsBridgeToo ? '' : '没告诉用户光装 OptiFine 还起不来',
  );
  check(
    '★ 组合本身合法 → 安装按钮不该被拦',
    r1.installDisabled === false,
    `按钮文字：${r1.installLabel ?? '无'}`,
  );
  check('1.20.1 这一段不该说「不兼容」（上游是有桥接包的）', r1.hasIncompatibleWord === false);
  check('不勾 OptiFine 时不该有这些提示', r1.hadIncompatibleBefore === false);
}

/* ====================== ② 1.20.6：真的不兼容 ====================== */
console.log('\n=== ② 1.20.6 + Fabric + 高清修复（上游没有桥接包，应判不兼容）===');
const r2 = await evaluate(probe('1.20.6'));
console.log(JSON.stringify(r2, null, 2));
if (!r2?.ok) {
  check('1.20.6 能走到「Fabric + 高清修复」这一步', false, r2?.why);
} else {
  check('★ 勾上 OptiFine 之后界面上出现「不兼容」', r2.hasIncompatibleWord === true);
  check('★ 提示里点名 OptiFabric（缺的是哪个包）', r2.mentionsOptiFabric === true);
  check('★ 给出可行动的替代：换 Forge', r2.mentionsForge === true);
  check(
    '★ 给出可行动的替代：Iris + Sodium（留在 Fabric 也能有光影）',
    r2.mentionsIris === true,
  );
  check(
    '★ 安装按钮被拦住（不能静默去掉 OptiFine 然后照装）',
    r2.installDisabled === true,
    r2.installDisabled === null
      ? `没找到安装按钮（实际按钮：${r2.installLabel ?? '无'}）`
      : '',
  );
  check(
    '★ 不再同时说「会自动安装」（两条文案必须互斥）',
    r2.saysOfAutoInstall === false && r2.saysBridgeAutoInstall === false,
    r2.saysOfAutoInstall || r2.saysBridgeAutoInstall
      ? '既写了"不兼容"又写了"会自动安装"'
      : '',
  );
  check('不勾 OptiFine 时不该出现「不兼容」', r2.hadIncompatibleBefore === false);
}

console.log('');
ws.close();
proc.kill();
await sleep(500);

if (failed === 0) {
  console.log('✓ 高清修复这块的结论与上游事实一致（1.14~1.20.4 有桥接包 / 1.20.5+ 真没有）');
  process.exit(0);
}
console.log(`✗ ${failed} 条不通过`);
process.exit(1);
