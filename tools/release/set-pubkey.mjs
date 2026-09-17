// 把 tauri.conf.json 里的 pubkey 换成指定的公钥文件内容。
// 用原文替换而不是 JSON.parse/stringify —— 后者会把整个 conf 重排一遍，
// 产生几百行无意义 diff，以后 review 时看不出真正改了什么。
import { readFileSync, writeFileSync } from 'node:fs';

const confPath = 'src-tauri/tauri.conf.json';
const pubPath = process.argv[2];
if (!pubPath) {
  console.error('用法: node tools/release/set-pubkey.mjs <公钥文件路径>');
  process.exit(1);
}

const raw = readFileSync(confPath, 'utf8');
const newPub = readFileSync(pubPath, 'utf8').trim();
const conf = JSON.parse(raw);
const oldPub = conf.plugins?.updater?.pubkey;
if (!oldPub) {
  console.error('✗ tauri.conf.json 里没有 plugins.updater.pubkey');
  process.exit(1);
}
if (oldPub === newPub) {
  console.log('已经是这把公钥了，无需改动。');
  process.exit(0);
}
if (!raw.includes(oldPub)) {
  console.error('✗ 在原文里找不到旧 pubkey 字符串，无法安全替换');
  process.exit(1);
}
writeFileSync(confPath, raw.replace(oldPub, newPub));
console.log(`✓ pubkey 已替换`);
console.log(`  旧: ${oldPub.slice(0, 40)}…`);
console.log(`  新: ${newPub.slice(0, 40)}…`);
// 回读确认真的生效
const after = JSON.parse(readFileSync(confPath, 'utf8')).plugins.updater.pubkey;
console.log(after === newPub ? '✓ 回读一致' : '✗ 回读不一致！');
