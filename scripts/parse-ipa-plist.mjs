/**
 * 解析 iOS IPA 里的 Info.plist（支持二进制与 XML 两种格式）。
 *
 * 为什么需要：iOS 的 Info.plist 在打包后通常是**二进制 plist**，
 * 直接当文本读看不到内容。本机没有 plutil（那是 macOS 工具），
 * 因此这里用纯 JS 实现一个最小二进制 plist 解析器，
 * 只处理 Info.plist 里会出现的类型（dict/array/string/bool/integer）。
 *
 * 用途：确认 ATS 例外、应用名、包标识真的进了成品 ——
 * 漏了 ATS 的话，装到 iPhone 上就是白屏。
 *
 * 用法：node scripts/parse-ipa-plist.mjs <Info.plist 路径>
 */
import { readFileSync } from 'node:fs';

const [, , plistPath] = process.argv;
if (!plistPath) {
  console.error('用法: node scripts/parse-ipa-plist.mjs <Info.plist 路径>');
  process.exit(1);
}

const buf = readFileSync(plistPath);

// ---------------------------------------------------------------------------
// 判断格式
// ---------------------------------------------------------------------------
const isBinary = buf.subarray(0, 8).toString('latin1') === 'bplist00';

if (!isBinary) {
  // XML 格式，直接输出
  console.log('（XML 格式 plist）\n');
  console.log(buf.toString('utf8'));
  process.exit(0);
}

console.log('（二进制 plist，开始解析）\n');

// ---------------------------------------------------------------------------
// 最小 bplist 解析器
// ---------------------------------------------------------------------------
const TRAILER_SIZE = 32;
const trailer = buf.subarray(buf.length - TRAILER_SIZE);
const offsetIntSize = trailer[6];
const objectRefSize = trailer[7];
const numObjects = Number(trailer.readBigUInt64BE(8));
const topObject = Number(trailer.readBigUInt64BE(16));
const offsetTableOffset = Number(trailer.readBigUInt64BE(24));

/** 读一个整数（1/2/4/8 字节，大端） */
function readInt(off, size) {
  if (size === 1) return buf[off];
  if (size === 2) return buf.readUInt16BE(off);
  if (size === 4) return buf.readUInt32BE(off);
  return Number(buf.readBigUInt64BE(off));
}

/** 对象偏移表 */
const offsets = [];
for (let i = 0; i < numObjects; i++) {
  offsets.push(readInt(offsetTableOffset + i * offsetIntSize, offsetIntSize));
}

/** 解析第 n 个对象 */
function parseObject(n, depth = 0) {
  if (depth > 40) return '<嵌套过深>';
  const off = offsets[n];
  const marker = buf[off];
  const type = marker >> 4;
  const info = marker & 0x0f;

  switch (type) {
    case 0x0: {
      // 简单类型
      if (info === 0x0) return null;
      if (info === 0x8) return false;
      if (info === 0x9) return true;
      return `<simple 0x${info.toString(16)}>`;
    }
    case 0x1: {
      // 整数
      const size = 1 << info;
      return readInt(off + 1, size);
    }
    case 0x2: {
      // 实数
      const size = 1 << info;
      return size === 8 ? buf.readDoubleBE(off + 1) : buf.readFloatBE(off + 1);
    }
    case 0x3: {
      // 日期
      return new Date((buf.readDoubleBE(off + 1) + 978307200) * 1000).toISOString();
    }
    case 0x4: {
      // 数据
      let len = info;
      let p = off + 1;
      if (info === 0x0f) {
        const intSize = 1 << buf[p];
        len = readInt(p + 1, intSize);
        p += 1 + intSize;
      }
      return `<data ${len} bytes>`;
    }
    case 0x5: {
      // ASCII 字符串
      let len = info;
      let p = off + 1;
      if (info === 0x0f) {
        const intSize = 1 << buf[p];
        len = readInt(p + 1, intSize);
        p += 1 + intSize;
      }
      return buf.toString('latin1', p, p + len);
    }
    case 0x6: {
      // UTF-16BE 字符串
      let len = info;
      let p = off + 1;
      if (info === 0x0f) {
        const intSize = 1 << buf[p];
        len = readInt(p + 1, intSize);
        p += 1 + intSize;
      }
      // 逐字符按大端读
      let s = '';
      for (let i = 0; i < len; i++) s += String.fromCharCode(buf.readUInt16BE(p + i * 2));
      return s;
    }
    case 0xa: {
      // 数组
      let count = info;
      let p = off + 1;
      if (info === 0x0f) {
        const intSize = 1 << buf[p];
        count = readInt(p + 1, intSize);
        p += 1 + intSize;
      }
      const arr = [];
      for (let i = 0; i < count; i++) {
        arr.push(parseObject(readInt(p + i * objectRefSize, objectRefSize), depth + 1));
      }
      return arr;
    }
    case 0xd: {
      // 字典
      let count = info;
      let p = off + 1;
      if (info === 0x0f) {
        const intSize = 1 << buf[p];
        count = readInt(p + 1, intSize);
        p += 1 + intSize;
      }
      const obj = {};
      for (let i = 0; i < count; i++) {
        const keyRef = readInt(p + i * objectRefSize, objectRefSize);
        const valRef = readInt(p + (count + i) * objectRefSize, objectRefSize);
        obj[parseObject(keyRef, depth + 1)] = parseObject(valRef, depth + 1);
      }
      return obj;
    }
    default:
      return `<未知类型 0x${type.toString(16)}>`;
  }
}

const plist = parseObject(topObject);
console.log(JSON.stringify(plist, null, 2));

// ---------------------------------------------------------------------------
// 针对本项目的关键校验
// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(60));
console.log('关键配置校验');
console.log('='.repeat(60));

const ats = plist.NSAppTransportSecurity;
let ok = true;

if (ats) {
  console.log('✓ 存在 NSAppTransportSecurity');
  if (ats.NSAllowsArbitraryLoadsInWebContent) {
    console.log('✓ NSAllowsArbitraryLoadsInWebContent = true（WebView 可加载 HTTP）');
  } else {
    console.log('· 未设置 NSAllowsArbitraryLoadsInWebContent');
  }
  const domains = ats.NSExceptionDomains;
  if (domains && domains['113.200.156.241']) {
    console.log('✓ 例外域名 113.200.156.241 已配置');
    const d = domains['113.200.156.241'];
    console.log('    NSExceptionAllowsInsecureHTTPLoads =', d.NSExceptionAllowsInsecureHTTPLoads);
  } else {
    console.log('✗ 未找到目标域名例外');
    ok = false;
  }
} else {
  console.log('✗ 缺少 NSAppTransportSecurity —— 装上去会白屏！');
  ok = false;
}

console.log('\n应用名 (CFBundleDisplayName):', plist.CFBundleDisplayName || '(未设置)');
console.log('包标识 (CFBundleIdentifier):', plist.CFBundleIdentifier);
console.log('版本 (CFBundleShortVersionString):', plist.CFBundleShortVersionString);
console.log('最低系统 (MinimumOSVersion):', plist.MinimumOSVersion);

console.log('\n' + (ok ? '结论：配置完整，可正常加载 HTTP 站点' : '结论：配置缺失，需要修复'));
process.exit(ok ? 0 : 1);
