/**
 * 「低性能损耗模式」不该**改掉**用户的档位（用户报"我的档位被悄悄改了"的根因回归测）。
 * ------------------------------------------------------------------
 * 老行为（修之前）：打开这个开关会 `vfx.choose('weak')` + `setMotion('lite')` ——
 *   两个都**写盘**，把用户选的「灵韵」永久改成降档值；而"原值"只存在一个内存 ref 里，
 *   于是**重启之后再也回不来**（关掉开关时 ref 是 null，档位停在降档）。
 *
 * 判据（五条，④ 是修之前必红的那条）：
 *   ① 把视效/动效都设成「灵动 / 灵韵」→ 盘上确实是这两个
 *   ② 打开低性能损耗模式：**生效**档位降到 weak / lite，但**盘上仍是** aura / aura
 *   ③ 关掉它：生效回到 aura / aura
 *   ④ ★ 重启（开关仍开着）→ 生效仍是降档、盘上仍是 aura / aura；再关掉 → 回到 aura / aura
 *   ⑤ 收尾：把两个档位还原成用户原来的值
 *
 * ★ ④ 需要 WebView 的 localStorage 跨进程活下来 ⇒ 用 `keepProfile: true`
 *   （`ieml.motion` / `ieml.lowPerf` 都存在那里）。
 *
 * 用法：node tools/live/probe-lowperf-keeps-user-level.mjs "<exe>"
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { clickNav, killIeml, launch, sleep } from './lib/cdp.mjs';

const EXE = process.argv[2] ?? 'src-tauri/target/release/ieml.exe';
const PREFS = 'D:\\IEML-launcher\\prefs.json';
const TAG = 'lowperf';

const vfxOnDisk = () => {
  try {
    return JSON.parse(readFileSync(PREFS, 'utf8')).vfx ?? '(没有)';
  } catch (e) {
    return '(读不到) ' + e.message;
  }
};

/** 页面上"实际生效"的两个档位 + localStorage 里"用户选的"两个档位 */
const stateOf = (ev) =>
  ev(`({
    vfxEff: document.documentElement.dataset.vfx ?? '(未设)',
    motionEff: document.documentElement.dataset.motion ?? '(未设)',
    vfxWant: localStorage.getItem('ieml.vfx') ?? '(未设)',
    motionWant: localStorage.getItem('ieml.motion') ?? '(未设)',
    lowPerf: localStorage.getItem('ieml.lowPerf'),
    onSwitch: document.querySelector('[role="switch"][aria-label="低性能损耗模式"]')?.getAttribute('aria-checked'),
  })`);

const clickByText = (ev, text) =>
  ev(
    `(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === ${JSON.stringify(text)}); if (!b) return '没有这个按钮'; b.click(); return 'clicked'; })()`,
  );

const toggleLowPerf = async (ev) => {
  const r = await ev(
    `(() => { const s = document.querySelector('[role="switch"][aria-label="低性能损耗模式"]'); if (!s) return '没有这个开关'; s.click(); return 'clicked'; })()`,
  );
  await sleep(1200);
  return r;
};

const originalVfx = vfxOnDisk();
console.log('用户盘上原来的 vfx：' + originalVfx);

await killIeml();
/* ---------- ① 打开设置页，把两个档位设成最高档 ---------- */
let app = await launch({ exe: EXE, tag: TAG, keepProfile: true, settleMs: 3000 });
await clickNav(app.ev, '设置');
await sleep(1500);
console.log('设视效=灵动：' + (await clickByText(app.ev, '灵动视效')));
await sleep(1200);
console.log('设动效=灵韵：' + (await clickByText(app.ev, '灵韵动效')));
await sleep(1500);
const s1 = await stateOf(app.ev);
console.log('① 设完之后：' + JSON.stringify(s1) + '  盘上 vfx=' + vfxOnDisk());

/* ---------- ② 打开低性能损耗模式 ---------- */
console.log('\n开低性能损耗模式：' + (await toggleLowPerf(app.ev)));
const s2 = await stateOf(app.ev);
console.log('② 生效=' + s2.vfxEff + '/' + s2.motionEff + '  用户选的（localStorage）=' + s2.vfxWant + '/' + s2.motionWant + '  盘上 vfx=' + vfxOnDisk());

/* ---------- ③ 关掉它 ---------- */
console.log('\n关低性能损耗模式：' + (await toggleLowPerf(app.ev)));
const s3 = await stateOf(app.ev);
console.log('③ 生效=' + s3.vfxEff + '/' + s3.motionEff + '  盘上 vfx=' + vfxOnDisk());

/* 再打开，为了验"重启之后还开着" */
console.log('\n再打开（为了验重启）：' + (await toggleLowPerf(app.ev)));
const beforeRestart = await stateOf(app.ev);
await app.close();

/* ---------- ④ 重启（localStorage 与 prefs 都留着） ---------- */
console.log('\n=== 重启 ===');
app = await launch({ exe: EXE, tag: TAG, keepProfile: true, settleMs: 3500 });
await clickNav(app.ev, '设置');
await sleep(1500);
const s4 = await stateOf(app.ev);
console.log('④a 重启后：开关=' + s4.onSwitch + ' 生效=' + s4.vfxEff + '/' + s4.motionEff + ' 用户选的=' + s4.vfxWant + '/' + s4.motionWant + ' 盘上 vfx=' + vfxOnDisk());
console.log('关掉它：' + (await toggleLowPerf(app.ev)));
const s5 = await stateOf(app.ev);
console.log('④b 关掉后：生效=' + s5.vfxEff + '/' + s5.motionEff + ' 盘上 vfx=' + vfxOnDisk());

/* ---------- ⑤ 收尾：还原用户的档位 ---------- */
if (originalVfx !== vfxOnDisk()) {
  const p = JSON.parse(readFileSync(PREFS, 'utf8'));
  p.vfx = originalVfx;
  writeFileSync(PREFS, JSON.stringify(p, null, 2) + '\n');
}
await app.close();

/* ---------- 判据 ---------- */
const c1 = s1.vfxWant === 'aura' && s1.motionWant === 'aura' && vfxOnDisk() !== '(读不到)';
const c2 = s2.vfxEff === 'weak' && s2.motionEff === 'lite' && s2.vfxWant === 'aura' && s2.motionWant === 'aura';
const c3 = s3.vfxEff === 'aura' && s3.motionEff === 'aura';
const c4 =
  beforeRestart.lowPerf === '1' &&
  s4.lowPerf === '1' &&
  s4.vfxEff === 'weak' &&
  s4.motionEff === 'lite' &&
  s4.vfxWant === 'aura' &&
  s4.motionWant === 'aura' &&
  s5.vfxEff === 'aura' &&
  s5.motionEff === 'aura';

console.log('\n===== 判据 =====');
console.log(`${c1 ? '✓' : '✗'} ① 两个档位设成了 aura/aura（生效 ${s1.vfxEff}/${s1.motionEff}，选的 ${s1.vfxWant}/${s1.motionWant}）`);
console.log(`${c2 ? '✓' : '✗'} ② 开低性能模式：生效降到 ${s2.vfxEff}/${s2.motionEff}，**盘上仍是** ${s2.vfxWant}/${s2.motionWant}`);
console.log(`${c3 ? '✓' : '✗'} ③ 关掉：生效回到 ${s3.vfxEff}/${s3.motionEff}`);
console.log(`${c4 ? '✓' : '✗'} ④ ★ 重启后仍能回到用户档位（重启时开关=${s4.onSwitch}，生效 ${s4.vfxEff}/${s4.motionEff}，选的 ${s4.vfxWant}/${s4.motionWant} → 关掉后 ${s5.vfxEff}/${s5.motionEff}）`);
process.exit(c1 && c2 && c3 && c4 ? 0 : 1);
