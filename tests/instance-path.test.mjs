/**
 * 「按实例取磁盘路径时该用哪个字段」的回归测试。
 * ------------------------------------------------------------------
 * ★★ 2026-09-30 真机 bug：`ModsPanel` 给后端传了 `active.id`
 *   （`inst-mulcf1gv`）而不是 `config.slug`（`26.3-fabric-0.19.5`），
 *   于是后端去读 `versions/inst-mulcf1gv/mods` ⇒ 不存在 ⇒ **Mod 列表 0 个**。
 *
 *   实测到的诊断原文：
 *   ```
 *   scan_mods(instance_id="inst-mulcf1gv", …)
 *   实际读的目录：D:\IEML\.minecraft\versions\inst-mulcf1gv\mods
 *   结果：目录不存在或读不出来
 *   ```
 *
 * 这一组测试的意义：**两个字段都是 string，编译器抓不到** ——
 * 只能靠"判定只有一份 + 有测试钉着"来防。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instanceDirSlug } from '../src/domain/instance-path.ts';

test('★ 取的是 config.slug（磁盘目录名），不是 id', () => {
  const inst = { id: 'inst-mulcf1gv', config: { slug: '26.3-fabric-0.19.5' } };
  assert.equal(instanceDirSlug(inst), '26.3-fabric-0.19.5');
  assert.notEqual(
    instanceDirSlug(inst),
    inst.id,
    '★ 传 id 会让后端去读一个不存在的目录 —— 这正是那次真机 bug',
  );
});

test('slug 空的实例返回 null（调用方不许拿 id 顶上）', () => {
  assert.equal(instanceDirSlug({ id: 'inst-x', config: { slug: '' } }), null);
  assert.equal(instanceDirSlug({ id: 'inst-x', config: { slug: '   ' } }), null);
  assert.equal(instanceDirSlug(null), null);
  assert.equal(instanceDirSlug(undefined), null);
});

test('slug 两端空白会被去掉（手改过 instances.json 的情况）', () => {
  assert.equal(
    instanceDirSlug({ id: 'inst-x', config: { slug: '  26.3-fabric-0.19.5  ' } }),
    '26.3-fabric-0.19.5',
  );
});

test('中文 slug 原样返回（目录名可以是中文，ADR-055 只管新建时用规范名）', () => {
  assert.equal(
    instanceDirSlug({ id: 'inst-x', config: { slug: '我的整合包' } }),
    '我的整合包',
  );
});
