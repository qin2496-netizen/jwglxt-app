/**
 * 解析 iPhone IPA 里的二进制 Info.plist，输出关键字段。
 *
 * 为什么自己写解析器：
 *   本机是 Windows，没有 macOS 的 plutil。Info.plist 在打包后是二进制
 *   plist（bplist00），当文本读看不到内容。
 *
 * 用途：确认 ATS 例外与应用名真的进了成品包 —— 这是「装上去白屏」
 * 和「图标名显示成 App」两类问题的最终把关。
 *
 * 用法：node scripts/read-ipa-plist.mjs <Info.plist>
 */
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('用法: node scripts/read-ipa-plist.mjs <Info.plist>');
  process.exit(1);
}

const buf = readFileSync(path);

if (buf.subarray(0, 6).toString('latin1') !== 'bplist') {
  console.log('（XML plist）');
  console.log(buf.toString('utf8'));
  process.exit(0);
}

// --- 读 trailer（末尾 32 字节）---
const t = buf.subarray(buf.length - 32);
const offsetIntSize = t[6];
const objectRefSize = t[7];
const numObjects = Number(t.readBigUInt64BE(8));
const topObject = Number(t.readBigUInt64BE(16));
const offsetTableOffset = Number(t.readBigUInt64BE(24));

function readUInt(off, size) {
  if (size === 1) return buf[off];
  if (size === 2) return buf.readUInt16BE(off);
  if (size === 4) return buf.readUInt32BE(off);
  if (size === 8) return Number(buf.readBigUInt64BE(off));
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + buf[off + i];
  return v;
}

const offsets = [];
for (let i = 0; i < numObjects; i++) {
  offsets.push(readUInt(offsetTableOffset + i * offsetIntSize, offsetIntSize));
}

/**
 * 读取「长度编码」。
 *
 * bplist 的约定：对象头低 4 位是 0xf 时，长度/数量另用一个整数对象表示。
 * 那个整数字节本身是 **0x1n** 形式，n 表示后面跟 2^n 个字节。
 * 所以字节数 = 1 << (marker & 0x0f)，而不是 1 << marker。
 *
 * 踩过的坑：早先写成 `1 << buf[p]`，当 buf[p]=0x10 时得到 65536，
 * 把数量读成天文数字，整个解析结果为空对象。
 */
function readLength(off, info) {
  // off 指向对象头**之后**的第一个字节。
  // 当 info != 0xf 时，长度就是 info 本身，数据紧跟在 off 处 ——
  // 这里必须返回 off，不能再 +1，否则会多跳一个字节，
  // 把 "App" 读成 "ppÑ"（这个 bug 实测踩到过）。
  if (info !== 0x0f) return { len: info, next: off };
  const sizeMarker = buf[off];
  const size = 1 << (sizeMarker & 0x0f);
  return { len: readUInt(off + 1, size), next: off + 1 + size };
}

/** 解析对象；用 cache 防止循环引用 */
const cache = new Map();
function parse(n, depth = 0) {
  if (depth > 60) return '<too deep>';
  if (cache.has(n)) return cache.get(n);

  const off = offsets[n];
  if (off === undefined || off >= buf.length) return '<bad ref>';

  const marker = buf[off];
  const type = marker >> 4;
  const info = marker & 0x0f;

  let result;

  if (type === 0x0) {
    result = info === 0x8 ? false : info === 0x9 ? true : null;
  } else if (type === 0x1) {
    result = readUInt(off + 1, 1 << info);
  } else if (type === 0x2) {
    result = (1 << info) === 8 ? buf.readDoubleBE(off + 1) : buf.readFloatBE(off + 1);
  } else if (type === 0x4) {
    const { len } = readLength(off + 1, info);
    result = `<data ${len}B>`;
  } else if (type === 0x5 || type === 0x6) {
    const { len, next } = readLength(off + 1, info);
    if (type === 0x5) {
      result = buf.toString('latin1', next, next + len);
    } else {
      // UTF-16BE → 手工按大端读码元，再组合成字符串。
      //
      // 不要用 tmp.swap16()：Buffer.from(subarray(...)) 在 Node 里可能
      // 与原 buffer 共享底层内存，swap16 会就地破坏原始数据，
      // 导致同一个文件解析两次结果不同（实测踩到）。
      let s = '';
      for (let i = 0; i < len; i++) {
        s += String.fromCharCode(buf.readUInt16BE(next + i * 2));
      }
      result = s;
    }
  } else if (type === 0xa) {
    const { len: count, next } = readLength(off + 1, info);
    const arr = [];
    for (let i = 0; i < count; i++) {
      arr.push(parse(readUInt(next + i * objectRefSize, objectRefSize), depth + 1));
    }
    result = arr;
  } else if (type === 0xd) {
    const { len: count, next } = readLength(off + 1, info);
    const obj = {};
    for (let i = 0; i < count; i++) {
      const kRef = readUInt(next + i * objectRefSize, objectRefSize);
      const vRef = readUInt(next + (count + i) * objectRefSize, objectRefSize);
      const key = parse(kRef, depth + 1);
      obj[typeof key === 'string' ? key : String(key)] = parse(vRef, depth + 1);
    }
    result = obj;
  } else {
    result = `<type 0x${type.toString(16)}>`;
  }

  cache.set(n, result);
  return result;
}

const plist = parse(topObject);

console.log('=== Info.plist 内容 ===');
console.log(JSON.stringify(plist, null, 2));

// ---- 针对性校验 ----
console.log('\n' + '='.repeat(64));
console.log('本项目关键项校验');
console.log('='.repeat(64));

const checks = [];
const ats = plist.NSAppTransportSecurity;

checks.push(['应用名 CFBundleDisplayName', plist.CFBundleDisplayName, plist.CFBundleDisplayName === '教务系统']);
checks.push(['包标识 CFBundleIdentifier', plist.CFBundleIdentifier, plist.CFBundleIdentifier === 'com.jwglxt.shell']);
checks.push(['最低系统版本', plist.MinimumOSVersion, !!plist.MinimumOSVersion]);
checks.push(['ATS 块存在', ats ? '是' : '否', !!ats]);
checks.push([
  'WebView 允许 HTTP',
  ats?.NSAllowsArbitraryLoadsInWebContent,
  ats?.NSAllowsArbitraryLoadsInWebContent === true,
]);
const dom = ats?.NSExceptionDomains?.['113.200.156.241'];
checks.push(['域名例外 113.200.156.241', dom ? '有' : '无', !!dom]);
checks.push([
  '  允许不安全 HTTP 加载',
  dom?.NSExceptionAllowsInsecureHTTPLoads,
  dom?.NSExceptionAllowsInsecureHTTPLoads === true,
]);

let allOk = true;
for (const [name, val, ok] of checks) {
  if (!ok) allOk = false;
  console.log(`${ok ? '✓' : '✗'} ${name}: ${val}`);
}

console.log('\n' + (allOk ? '结论：全部通过，可正常安装使用' : '结论：有项目未通过'));
process.exit(allOk ? 0 : 1);
