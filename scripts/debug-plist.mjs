/**
 * 调试：在 IPA 的二进制 plist 里定位字符串对象。
 * 用法：node scripts/debug-plist.mjs <Info.plist>
 */
import { readFileSync } from 'node:fs';

const buf = readFileSync(process.argv[2]);
const t = buf.subarray(buf.length - 32);
const ois = t[6];
const ors = t[7];
const numObjects = Number(t.readBigUInt64BE(8));
const ots = Number(t.readBigUInt64BE(24));

function readUInt(off, size) {
  if (size === 1) return buf[off];
  if (size === 2) return buf.readUInt16BE(off);
  if (size === 4) return buf.readUInt32BE(off);
  return Number(buf.readBigUInt64BE(off));
}

const offsets = [];
for (let i = 0; i < numObjects; i++) offsets.push(readUInt(ots + i * ois, ois));

console.log(`对象数 ${numObjects}，偏移表 @${ots}，intSize=${ois}，refSize=${ors}\n`);

/** 读字符串对象，返回值和数据起点，便于核对偏移 */
function readStr(i) {
  const off = offsets[i];
  const m = buf[off];
  const type = m >> 4;
  const info = m & 0xf;
  if (type !== 5 && type !== 6) return null;

  let len = info;
  let p = off + 1;
  let sizeInfo = '';
  if (info === 0xf) {
    const sm = buf[p];
    const size = 1 << (sm & 0xf);
    len = readUInt(p + 1, size);
    sizeInfo = `[lenObj@${p} marker=0x${sm.toString(16)} size=${size}]`;
    p += 1 + size;
  }
  let s;
  if (type === 5) {
    s = buf.toString('latin1', p, p + len);
  } else {
    // 手工按大端解码，避免 swap16 破坏共享内存
    s = '';
    for (let k = 0; k < len; k++) s += String.fromCharCode(buf.readUInt16BE(p + k * 2));
  }
  return { off, type, info, len, dataOff: p, sizeInfo, s };
}

console.log('=== 所有字符串对象（含 App / 教务 的）===');
for (let i = 0; i < numObjects; i++) {
  const r = readStr(i);
  if (!r) continue;
  if (r.s.includes('App') || r.s.includes('教务') || r.s.includes('CFBundle')) {
    console.log(`#${i} off=${r.off} type=0x${r.type.toString(16)} len=${r.len} ${r.sizeInfo} dataOff=${r.dataOff}`);
    console.log(`    值: "${r.s}"`);
  }
}

console.log('\n=== 原始字节速查：找 "App" 的 UTF-8 位置 ===');
const needle = Buffer.from('App', 'latin1');
for (let i = 0; i < buf.length - 3; i++) {
  if (buf[i] === 0x41 && buf[i + 1] === 0x70 && buf[i + 2] === 0x70) {
    console.log(`  偏移 ${i}: 后续 ${buf.subarray(i, i + 16).toString('hex')}  "${buf.subarray(i, i + 16).toString('latin1')}"`);
  }
}
