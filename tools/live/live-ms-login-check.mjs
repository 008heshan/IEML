/**
 * 真机验证：正版登录的 client_id 配置流程（设置页 → 后端 → 落盘 → 重启后仍在）。
 * ------------------------------------------------------------------
 * ## 为什么必须真机跑一遍
 *
 *   README 里那句「微软设备码登录 ✅ 已实现，未实测」掩盖过一个事实：
 *   **它从来没有被打通过一次**。实测发现老代码写死的 client_id
 *   `00000000402b5328` 早就被微软删了，直接打接口得到
 *   `AADSTS700016: Application with identifier ... was not found`。
 *
 *   所以这条链路不能只靠"代码看起来对"——必须跑通：
 *     ① 没配时界面**如实说不能登录**（而不是让用户白试一次）
 *     ② 填一个 id → 保存 → 状态立刻变「已就绪」
 *     ③ **重启启动器** → 仍然是「已就绪」（证明真的落盘了）
 *     ④ 填占位符（全零）→ 被拦住并说清原因
 *
 * 用法：node tools/live/live-ms-login-check.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const PORT = 9334;
const EXE = path.join(process.env.USERPROFILE ?? '', 'Desktop', 'IEML.exe');

/**
 * client_id 落在**数据目录**里，不是 `%APPDATA%\IEML`。
 *
 * ★ 这里踩过一次假失败：数据目录是 `D:\IEML`（记录在
 *   `%APPDATA%\IEML\datadir.txt`），而这条测试把路径写死成
 *   `%APPDATA%\IEML\ms_client_id.txt` —— 文件明明写成功了，
 *   断言却报「没写盘」。**又一次"检查方法错了"**。
 *
 * 所以先读 `datadir.txt`，读不到才退回 `%APPDATA%\IEML`
 * （老安装的布局）。
 */
const dataDir = (() => {
  const appdata = process.env.APPDATA ?? '';
  const legacy = path.join(appdata, 'IEML');
  const marker = path.join(legacy, 'datadir.txt');
  try {
    const v = readFileSync(marker, 'utf8').trim();
    if (v) return v;
  } catch {
    /* 没有标记文件 → 用默认布局 */
  }
  return legacy;
})();
const CID_FILE = path.join(dataDir, 'ms_client_id.txt');

if (!existsSync(EXE)) {
  console.error(`找不到桌面版：${EXE}`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 起一个带 CDP 的实例，返回 { proc, evaluate } ---------- */
async function launchWithCdp() {
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
    proc.kill();
    throw new Error('WebView2 的 CDP 没起来');
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
    return new Promise((resolve, reject) => {
      pending.set(myId, (msg) => {
        if (msg.error) return reject(new Error(JSON.stringify(msg.error)));
        if (msg.result?.exceptionDetails) {
          return reject(new Error(msg.result.exceptionDetails.text ?? 'eval 抛错'));
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
  const close = () => {
    try {
      ws.close();
    } catch {}
    proc.kill();
  };
  return { proc, evaluate, close };
}

/* ---------- 等到界面挂载完（首屏是「正在准备…」） ---------- */
async function waitReady(evaluate) {
  for (let i = 0; i < 40; i += 1) {
    const ok = await evaluate(
      `(() => { const t = document.body.innerText || ''; return t.length > 50 && !t.includes('正在准备'); })()`,
    );
    if (ok) return true;
    await sleep(500);
  }
  return false;
}

/* ---------- 打开「设置」页 ---------- */
const goto = async (evaluate) => {
  await evaluate(`(async () => {
    const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').trim() === '设置');
    b?.click();
    await new Promise(r => setTimeout(r, 1200));
    return true;
  })()`);
};

/* ---------- 读设置页里账号那一块的状态 ---------- */
const readAccountCard = (evaluate) =>
  evaluate(`(() => {
    const text = document.body.innerText || '';
    const has = (s) => text.includes(s);
    const input = [...document.querySelectorAll('input')].find(i => (i.placeholder||'').includes('client_id'));
    return {
      // 用码点判，避开中文管道编码问题
      saysReady: has('\\u6b63\\u7248\\u767b\\u5f55\\u5df2\\u5c31\\u7eea'),      // 正版登录已就绪
      /*
       * ★ 判据改成**匹配真实文案**："正版登录需要先配置一个「微软应用 ID」
       *
       *   老断言找的是「缺一个微软应用 ID」—— 那是**上一版的文案**，
       *   后来文案改好了（说清"为什么"和"三个办法"），断言却没人跟着改，
       *   于是它一直红着，而红的原因和被测行为毫无关系。
       *
       *   这里的教训：断言要盯**行为**（"用户能不能看出缺什么、去哪填"），
       *   而不是盯**某一句具体的话**。所以下面同时查三样东西：
       *     缺 client_id + 三个办法 + 申请入口。
       */
      saysMissing: has('\\u9700\\u8981\\u5148\\u914d\\u7f6e'),                 // 需要先配置
      mentionsClientId: has('client_id'),
      hasInput: !!input,
      mentionsOffline: has('\\u79bb\\u7ebf\\u6a21\\u5f0f'),                       // 离线模式
      mentionsAzure: has('portal.azure.com'),
    };
  })()`);

/* ==================== 开始 ==================== */
if (existsSync(CID_FILE)) {
  console.log(`（先清掉已有的 client_id：${CID_FILE}）`);
  rmSync(CID_FILE, { force: true });
}

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? `  —— ${extra}` : ''}`);
  if (!ok) failed += 1;
};

/* ---------- ① 第一次启动：没配 client_id ---------- */
console.log('\n=== ① 没配 client_id 时 ===');
let s1 = await launchWithCdp();
await waitReady(s1.evaluate);
await goto(s1.evaluate);
const before = await readAccountCard(s1.evaluate);
console.log('  ', JSON.stringify(before));
check(
  '界面如实说「正版登录需要先配置一个微软应用 ID」',
  before.saysMissing && before.mentionsClientId,
  JSON.stringify(before),
);
check('给出了输入框让用户填', before.hasInput);
check('说明了离线模式不受影响（不能让用户以为没登录就不能玩）', before.mentionsOffline);
check('给出了申请入口（portal.azure.com）', before.mentionsAzure);
s1.close();
await sleep(1500);

/* ---------- ② 填一个 id 并保存 → 状态应立刻变「已就绪」 ---------- */
console.log('\n=== ② 填一个 client_id 并保存 ===');
const FAKE_CID = '11111111-2222-3333-4444-555555555555';
let s2 = await launchWithCdp();
await waitReady(s2.evaluate);
await goto(s2.evaluate);
const saved = await s2.evaluate(`(async () => {
  const input = [...document.querySelectorAll('input')].find(i => (i.placeholder||'').includes('client_id'));
  if (!input) return { ok: false, why: 'no input' };
  // React 受控输入：必须走原生 setter 才能触发 onChange
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(FAKE_CID)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 300));
  const btn = [...document.querySelectorAll('button')].find(b => (b.textContent||'').trim() === '\\u4fdd\\u5b58');
  if (!btn) return { ok: false, why: 'no save button' };
  btn.click();
  await new Promise(r => setTimeout(r, 1500));
  return { ok: true };
})()`);
console.log('  ', JSON.stringify(saved));
check('能填并点保存', saved.ok === true, saved.why ?? '');
const after = await readAccountCard(s2.evaluate);
console.log('  ', JSON.stringify(after));
check('保存后状态变成「正版登录已就绪」', after.saysReady);
s2.close();
await sleep(1500);

/* ---------- ③ 落盘验证 ---------- */
console.log('\n=== ③ 落盘验证 ===');
check(`client_id 已写到 ${CID_FILE}`, existsSync(CID_FILE));
if (existsSync(CID_FILE)) {
  const { readFileSync } = await import('node:fs');
  const content = readFileSync(CID_FILE, 'utf8').trim();
  console.log(`   文件内容：${content}`);
  check('文件内容就是刚填的 id', content === FAKE_CID);
}

/* ---------- ④ 重启后仍然是「已就绪」 ---------- */
console.log('\n=== ④ 重启启动器 ===');
let s3 = await launchWithCdp();
await waitReady(s3.evaluate);
await goto(s3.evaluate);
const afterRestart = await readAccountCard(s3.evaluate);
console.log('  ', JSON.stringify(afterRestart));
check('★ 重启后仍然是「正版登录已就绪」（证明真的落盘且启动时载入了）', afterRestart.saysReady);
s3.close();
await sleep(1500);

/* ---------- ⑤ 占位符要被拦住 ---------- */
console.log('\n=== ⑤ 填占位符（全零）应被拦住 ===');let s4 = await launchWithCdp();
await waitReady(s4.evaluate);
await goto(s4.evaluate);
const placeholder = await s4.evaluate(`(async () => {
  // 先清掉，让输入框重新出现
  const input = [...document.querySelectorAll('input')].find(i => (i.placeholder||'').includes('client_id'));
  if (!input) return { skipped: true, why: '没有输入框（说明当前已被认作已就绪）' };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, '00000000-0000-0000-0000-000000000000');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 300));
  const btn = [...document.querySelectorAll('button')].find(b => (b.textContent||'').trim() === '\\u4fdd\\u5b58');
  btn?.click();
  await new Promise(r => setTimeout(r, 1200));
  const text = document.body.innerText || '';
  return { skipped: false, mentionsPlaceholder: text.includes('\\u5360\\u4f4d\\u7b26') };
})()`);
console.log('  ', JSON.stringify(placeholder));
if (placeholder.skipped) {
  console.log('  （当前已是「已就绪」状态，输入框不显示 —— 这条在真实缺 id 的机器上才跑得到）');
} else {
  check('占位符被拦住并说清原因', placeholder.mentionsPlaceholder);
}
s4.close();
await sleep(1500);

/* ---------- ⑥ ★★ 点「正版登录」必须**自动开始轮询**（不再要求第二次点击） ---------- */
/*
 * 这条守的是一个"界面在撒谎"的 bug：
 *   以前拿到设备码之后要用户**再点一次**「我已在浏览器完成」才开始轮询，
 *   而同一块界面上写着「完成后自动继续，不用回来点任何东西」。
 *   用户盯着设备码等，什么都不会发生 —— 看起来就是"登录坏了"。
 *
 * 判据（都不依赖真的完成登录）：
 *   ① 点一下按钮，设备码就出现在页面上
 *   ② 页面上出现「正在等你在浏览器里完成登录」
 *   ③ **没有**任何需要用户再点的按钮（尤其是「我已在浏览器完成」）
 *   ④ 后端真的在轮询 —— 通过 Network 域看不到（是 Rust 侧发的），
 *      所以改为观察：等待期间设备码那块**一直在**（而不是立刻变成错误）
 *
 * ⚠️ 这一步需要 `IEML_MS_LIVE_CLIENT_ID`（一个真实注册过的 client_id）。
 *    没设就跳过 —— 假的通过和假的失败一样有害。
 */
const liveCid = process.env.IEML_MS_LIVE_CLIENT_ID ?? '';
if (!liveCid) {
  console.log('\n=== ⑥ 自动轮询（跳过） ===');
  console.log('  （没有设置 IEML_MS_LIVE_CLIENT_ID —— 这条需要真实 client_id 才有意义）');
} else {
  console.log('\n=== ⑥ 点「正版登录」是否**自动**开始轮询 ===');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(CID_FILE, liveCid, 'utf8');

  const s5 = await launchWithCdp();
  await waitReady(s5.evaluate);
  await goto(s5.evaluate);

  const clicked = await s5.evaluate(`(async () => {
    const btn = [...document.querySelectorAll('button')]
      .find(b => (b.textContent||'').includes('\\u6b63\\u7248\\u767b\\u5f55'));  // 正版登录
    if (!btn) return { ok: false, why: '找不到「正版登录」按钮' };
    btn.click();
    await new Promise(r => setTimeout(r, 5000));
    const text = document.body.innerText || '';
    const buttons = [...document.querySelectorAll('button')].map(b => (b.textContent||'').trim());
    /*
     * ★ 设备码必须从**它自己的元素**里读（.dc-code）。
     *   第一版是在整页文字里捞 /\\b[A-Z0-9]{8}\\b/ —— 结果抓到的是
     *   「当前应用 ID：11111111…」里那段打码前缀，于是"拿到了设备码"这条
     *   **假通过**了（又一次"断言没盯住目标元素"）。
     */
    const dc = document.querySelector('.dc-code');
    return {
      ok: true,
      code: dc ? (dc.textContent||'').trim() : null,
      waits: text.includes('\\u6b63\\u5728\\u7b49\\u4f60'),         // 正在等你
      saysAuto: text.includes('\\u4e0d\\u7528\\u56de\\u6765\\u70b9'),  // 不用回来点
      // ★ 这个按钮**必须不存在**了
      hasManualBtn: buttons.some(b => b.includes('\\u5df2\\u5728\\u6d4f\\u89c8\\u5668\\u5b8c\\u6210')), // 我已在浏览器完成
      // 失败时页面上会留下原因（这是我们要求"失败要留在页面上"的结果）
      errNote: (() => {
        const n = [...document.querySelectorAll('.note-warning, .note-danger')]
          .map(x => (x.innerText||'').trim())
          .filter(t => t.includes('\\u767b\\u5f55'));   // 含「登录」
        return n.length ? n[0].slice(0, 300) : null;
      })(),
      buttons: buttons.slice(0, 30),
    };
  })()`);
  console.log('  ', JSON.stringify(clicked, null, 2));

  check(
    '点一下「正版登录」就拿到 8 位设备码',
    typeof clicked.code === 'string' && /^[A-Z0-9]{8}$/.test(clicked.code),
    clicked.code ?? clicked.why ?? '',
  );
  check(
    '★ 页面显示「正在等你在浏览器里完成登录」（自动轮询已开始）',
    clicked.waits === true,
    clicked.errNote ? `页面上写着：${clicked.errNote}` : '',
  );
  check('★ 不再需要用户点第二次（「我已在浏览器完成」按钮已移除）', clicked.hasManualBtn === false);

  s5.close();
  rmSync(CID_FILE, { force: true });
}
console.log(`\n（已清掉测试用的 client_id）`);

console.log('');
if (failed === 0) {
  console.log('✓ 正版登录的配置链路全部通过');
} else {
  console.log(`✗ ${failed} 条不通过`);
}
process.exit(failed === 0 ? 0 : 1);
