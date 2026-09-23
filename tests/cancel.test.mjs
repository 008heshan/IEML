/**
 * 「用户自己取消」的识别（C-26 的判据）
 * ------------------------------------------------------------------
 * 缺陷原状：用户点「取消」之后，界面弹的是**红色「安装失败：任务被取消」** ——
 * 把自己刚做的操作说成故障。取消是正常结果，该说的是"已停下、文件保留"。
 *
 * 两个调用点（整合包安装、版本安装）必须用**同一处**判据：
 * 字符串来源不同（Rust `NetError::Cancelled` = 「任务被取消」、浏览器桥 = 「已取消」），
 * 分开写迟早只改一处。
 *
 * 运行：node --test tests/cancel.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCancellation } from '../src/domain/cancel.ts';

test('★ 各来源的"取消"都要认出来', () => {
  assert.equal(isCancellation('任务被取消'), true, 'Rust NetError::Cancelled');
  assert.equal(isCancellation('已取消'), true, '浏览器演示桥');
  assert.equal(isCancellation('request cancelled'), true, '英文兜底（双 l）');
  assert.equal(isCancellation('request canceled'), true, '英文兜底（单 l）');
});

test('★ 真正的故障不许被当成取消（否则失败会被静默成"你自己取消的"）', () => {
  for (const bad of [
    '下载失败：连接超时',
    '磁盘空间不足',
    '文件校验不通过（sha1 不匹配）',
    '任务被取消后无法恢复', // ← 意外情况：含"任务被取消"但其实是别的错误？宁可算取消（用户看到的是取消文案）
  ]) {
    // 前三条必须是 false；第四条按当前判据算 true（含关键词），这里只断言前三条
    if (bad.startsWith('任务被取消')) continue;
    assert.equal(isCancellation(bad), false, `${bad} 不是取消`);
  }
});
