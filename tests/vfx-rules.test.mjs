/**
 * 视效档位的**判据表**（`src/ui/vfx.ts`）—— 三档 + 降级。
 * ------------------------------------------------------------------
 * 为什么这些要写成测试（而不是"设置页点一下看看"）：
 *
 *   降级这件事**只会在别人的机器上发生**。开发机永远是有真显卡的新系统 ——
 *   也就是说，"Win7 / 无 WebGL2 / 软渲染 → 落到适中且不开放灵动"这条判据
 *   在这台机器上**永远跑不到**。跑不到的判据等于没有判据，所以把它拆成
 *   纯函数（`osFromUA` / `isSoftwareRenderer` / `auraGate` / `decideVfx`），
 *   用**真实 UA 串**喂它。
 *
 * ★ 判据用的 UA 串是**真机抄来的**（本机 WebView2 报的那一条），不是编的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VFX_HINT,
  VFX_LABEL,
  VFX_LEVELS,
  auraGate,
  decideVfx,
  isSoftwareRenderer,
  osFromUA,
} from '../src/ui/vfx.ts';

/**
 * 造一份"完全够格"的能力，再按需覆盖某个字段。
 *
 * ★ 本文件是 `.mjs`：**它自己**不能写 TS 类型语法（`import { type X }` 会直接
 *   语法错误 —— 实测踩过）。被 import 的 `vfx.ts` 由 Node 剥类型，没问题；
 *   但这里只能靠 JSDoc。
 *
 * @param {Partial<import('../src/ui/vfx.ts').VfxCapability>} over
 * @returns {import('../src/ui/vfx.ts').VfxCapability}
 */
function cap(over = {}) {
  /** @type {import('../src/ui/vfx.ts').VfxCapability} */
  const base = {
    webgl2: true,
    renderer: 'ANGLE (Intel, Intel(R) UHD Graphics (0x000046A3) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    software: false,
    os: { name: 'Windows 10/11', legacy: false },
    auraAllowed: true,
    reason: null,
  };
  return { ...base, ...over };
}

/* ====================== 系统版本 ====================== */

test('UA：本机这一条（Win10/11）不算老系统', () => {
  const ua =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0';
  const os = osFromUA(ua);
  assert.equal(os.legacy, false);
  assert.equal(os.name, 'Windows 10/11');
});

test('UA：Win7 / 8 / 8.1（NT 6.x）都算老系统', () => {
  assert.equal(osFromUA('Mozilla/5.0 (Windows NT 6.1; Win64; x64)').legacy, true);
  assert.equal(osFromUA('Mozilla/5.0 (Windows NT 6.2; Win64; x64)').legacy, true);
  assert.equal(osFromUA('Mozilla/5.0 (Windows NT 6.3; Win64; x64)').legacy, true);
  assert.equal(osFromUA('Mozilla/5.0 (Windows NT 6.1; Win64; x64)').name, 'Windows 7');
});

test('UA：认不出来就说不知道，**不因此禁掉灵动**', () => {
  // ★ 这是刻意的："不是 Windows"不等于"显卡不行"。真正的拦截交给 WebGL2 那条判据，
  //   在这里顺手禁掉会让一台 Linux 上的好显卡平白降级。
  const os = osFromUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
  assert.equal(os.legacy, false);
  assert.equal(os.name, '未知');
});

/* ====================== 软渲染 ====================== */

test('软渲染：SwiftShader / Basic Render Driver 都算', () => {
  assert.equal(isSoftwareRenderer('Google SwiftShader'), true);
  assert.equal(isSoftwareRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))'), true);
  assert.equal(isSoftwareRenderer('Microsoft Basic Render Driver'), true);
  assert.equal(isSoftwareRenderer('llvmpipe (LLVM 15.0.7, 256 bits)'), true);
});

test('软渲染：真显卡不算（本机实测那条渲染器名）', () => {
  assert.equal(
    isSoftwareRenderer('ANGLE (Intel, Intel(R) UHD Graphics (0x000046A3) Direct3D11 vs_5_0 ps_5_0, D3D11)'),
    false,
  );
  assert.equal(isSoftwareRenderer(null), false, '拿不到渲染器名 ≠ 软渲染');
});

/* ====================== 灵动档的门 ====================== */

test('灵动门：没有 WebGL2 → 不开，理由里要写清是 WebGL 2.0', () => {
  const g = auraGate({ webgl2: false, renderer: null, os: { name: 'Windows 10/11', legacy: false } });
  assert.equal(g.allowed, false);
  assert.match(String(g.reason), /WebGL 2\.0/);
});

test('灵动门：软渲染 → 不开，理由里要带渲染器名（用户能拿去搜）', () => {
  const g = auraGate({
    webgl2: true,
    renderer: 'Google SwiftShader',
    os: { name: 'Windows 10/11', legacy: false },
  });
  assert.equal(g.allowed, false);
  assert.match(String(g.reason), /SwiftShader/);
});

test('灵动门：老系统 → 不开（哪怕 WebGL2 报可用）', () => {
  const g = auraGate({
    webgl2: true,
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 750 Ti Direct3D11, D3D11)',
    os: { name: 'Windows 7', legacy: true },
  });
  assert.equal(g.allowed, false);
  assert.match(String(g.reason), /Windows 7/);
});

test('灵动门：真显卡 + 新系统 → 开', () => {
  const g = auraGate({
    webgl2: true,
    renderer: 'ANGLE (Intel, Intel(R) UHD Graphics, D3D11)',
    os: { name: 'Windows 10/11', legacy: false },
  });
  assert.equal(g.allowed, true);
  assert.equal(g.reason, null);
});

/* ====================== 最终档位 ====================== */

test('默认：没选过 → 适中', () => {
  const d = decideVfx(null, cap());
  assert.equal(d.level, 'mid');
  assert.equal(d.clamped, false);
});

test('坏值：不认识的字符串 → 落到适中（不是弱化）', () => {
  // ★ 落到 weaker 会让人以为"玻璃坏了"；适中才是设计过的正常样子。
  for (const bad of ['', 'ultra', 'AURA', 'high', '1']) {
    assert.equal(decideVfx(bad, cap()).level, 'mid', `坏值 ${JSON.stringify(bad)} 应落到适中`);
  }
});

test('弱化 / 适中：不受能力限制（老机器就该能用）', () => {
  const weakCap = cap({ webgl2: false, auraAllowed: false, reason: '不支持 WebGL 2.0' });
  assert.equal(decideVfx('weak', weakCap).level, 'weak');
  assert.equal(decideVfx('mid', weakCap).level, 'mid');
  assert.equal(decideVfx('weak', weakCap).clamped, false);
});

test('★ 存了灵动但机器不够格 → 读到的是适中，并且**带得出原因**', () => {
  const weakCap = cap({
    webgl2: false,
    auraAllowed: false,
    reason: '这台机器的显卡（或驱动）不支持 WebGL 2.0，灵动视效开不了',
  });
  const d = decideVfx('aura', weakCap);
  assert.equal(d.level, 'mid', '必须降级');
  assert.equal(d.clamped, true, '要告诉界面"你选的被挡了"');
  assert.match(String(d.why), /WebGL 2\.0/);
});

test('够格时，用户选的灵动原样生效', () => {
  const d = decideVfx('aura', cap());
  assert.equal(d.level, 'aura');
  assert.equal(d.clamped, false);
  assert.equal(d.why, null);
});

/* ====================== 文案与三档的完整性 ====================== */

test('三档都有名字和说明（用户给的三个词，原样用）', () => {
  assert.deepEqual([...VFX_LEVELS], ['weak', 'mid', 'aura']);
  assert.equal(VFX_LABEL.weak, '弱化视效');
  assert.equal(VFX_LABEL.mid, '适中视效');
  assert.equal(VFX_LABEL.aura, '灵动视效');
  for (const lv of VFX_LEVELS) {
    assert.ok(VFX_HINT[lv] && VFX_HINT[lv].length > 8, `${lv} 缺说明`);
  }
});
