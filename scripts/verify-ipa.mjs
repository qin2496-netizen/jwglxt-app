/**
 * 校验 iOS IPA 的完整性与关键配置。
 *
 * 流程：解压 IPA（本质是 zip）→ 解析 Info.plist（二进制格式）→ 逐项核对。
 *
 * 为什么需要：
 *   - 构建成功 ≠ 包装对了。「ATS 例外没写进去」这类问题只有打开包才能发现，
 *     而它的表现是「装到手机上白屏」，排查起来很费劲。
 *   - 本机是 Windows，没有 macOS 的 plutil，所以自带一个二进制 plist 解析器。
 *
 * 用法：node scripts/verify-ipa.mjs <xxx.ipa>
 */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const ipaPath = process.argv[2];
if (!ipaPath) {
  console.error('用法: node scripts/verify-ipa.mjs <xxx.ipa>');
  process.exit(1);
}

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`✓ ${name}${detail ? `  ${detail}` : ''}`);
  } else {
    fail++;
    console.log(`✗ ${name}${detail ? `  ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// 1. 从 IPA（zip）里取出 Info.plist
// ---------------------------------------------------------------------------
console.log('=== 1. 读取 IPA ===');
const zip = readFileSync(ipaPath);
console.log(`文件：${ipaPath}`);
console.log(`大小：${(zip.length / 1024 / 1024).toFixed(2)} MB`);
check('是有效的 zip（IPA 格式）', zip.subarray(0, 2).toString('latin1') === 'PK');

/** 极简 zip 读取 */
function unzipEntry(buf, matcher) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('找不到 zip 中央目录');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);

    if (matcher(name)) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(dataStart, dataStart + compSize);
      return { name, data: method === 0 ? raw : inflateRawSync(raw) };
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

const plistEntry = unzipEntry(zip, (n) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(n));
check('找到 Info.plist', !!plistEntry, plistEntry?.name || '');
if (!plistEntry) process.exit(1);

// ---------------------------------------------------------------------------
// 2. 解析二进制 plist
// ---------------------------------------------------------------------------
console.log('\n=== 2. 解析 Info.plist ===');
const buf = plistEntry.data;
check('是二进制 plist', buf.subarray(0, 6).toString('latin1') === 'bplist');

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

/** 读取长度/数量：info != 0xf 时数据紧跟其后（next 不能 +1，否则偏移错位） */
function readLength(off, info) {
  if (info !== 0x0f) return { len: info, next: off };
  const sizeMarker = buf[off];
  const size = 1 << (sizeMarker & 0x0f);
  return { len: readUInt(off + 1, size), next: off + 1 + size };
}

const cache = new Map();
function parse(n, depth = 0) {
  if (depth > 60) return null;
  if (cache.has(n)) return cache.get(n);

  const off = offsets[n];
  if (off === undefined || off >= buf.length) return null;
  const marker = buf[off];
  const type = marker >> 4;
  const info = marker & 0x0f;
  let result;

  if (type === 0x0) result = info === 0x8 ? false : info === 0x9 ? true : null;
  else if (type === 0x1) result = readUInt(off + 1, 1 << info);
  else if (type === 0x2) result = (1 << info) === 8 ? buf.readDoubleBE(off + 1) : buf.readFloatBE(off + 1);
  else if (type === 0x4) result = `<data>`;
  else if (type === 0x5 || type === 0x6) {
    const { len, next } = readLength(off + 1, info);
    if (type === 0x5) result = buf.toString('latin1', next, next + len);
    else {
      // 手工按大端解码：不能用 swap16，它会破坏共享内存
      let s = '';
      for (let i = 0; i < len; i++) s += String.fromCharCode(buf.readUInt16BE(next + i * 2));
      result = s;
    }
  } else if (type === 0xa) {
    const { len: count, next } = readLength(off + 1, info);
    result = [];
    for (let i = 0; i < count; i++) {
      result.push(parse(readUInt(next + i * objectRefSize, objectRefSize), depth + 1));
    }
  } else if (type === 0xd) {
    const { len: count, next } = readLength(off + 1, info);
    result = {};
    for (let i = 0; i < count; i++) {
      const kRef = readUInt(next + i * objectRefSize, objectRefSize);
      const vRef = readUInt(next + (count + i) * objectRefSize, objectRefSize);
      const key = parse(kRef, depth + 1);
      result[typeof key === 'string' ? key : String(key)] = parse(vRef, depth + 1);
    }
  } else result = null;

  cache.set(n, result);
  return result;
}

const p = parse(topObject);
check('解析成功', p && typeof p === 'object' && Object.keys(p).length > 5, `${Object.keys(p || {}).length} 个字段`);

// ---------------------------------------------------------------------------
// 3. 关键项核对
// ---------------------------------------------------------------------------
console.log('\n=== 3. 关键配置核对 ===');

check('应用名（桌面显示）', p.CFBundleDisplayName === '教务系统', `「${p.CFBundleDisplayName}」`);
check('包标识', p.CFBundleIdentifier === 'com.jwglxt.shell', p.CFBundleIdentifier);
check('最低系统版本', !!p.MinimumOSVersion, `iOS ${p.MinimumOSVersion}`);
check('可执行文件存在', !!p.CFBundleExecutable, p.CFBundleExecutable);

const ats = p.NSAppTransportSecurity;
check('ATS 配置块存在', !!ats);
check('WebView 可加载 HTTP', ats?.NSAllowsArbitraryLoadsInWebContent === true);
const dom = ats?.NSExceptionDomains?.['113.200.156.241'];
check('目标域名例外', !!dom, '113.200.156.241');
check('  允许不安全 HTTP 加载', dom?.NSExceptionAllowsInsecureHTTPLoads === true);

const appEntry = unzipEntry(zip, (n) => /^Payload\/[^/]+\.app\/[^/]+$/.test(n) && !n.endsWith('Info.plist'));
check('主程序二进制已打包', !!appEntry, appEntry?.name || '');

const iconEntry = unzipEntry(zip, (n) => n.includes('Assets.car') || n.includes('AppIcon'));
check('图标资源已打包', !!iconEntry, iconEntry?.name || '');

// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(56));
console.log(`${pass} 项通过，${fail} 项失败`);
console.log('='.repeat(56));
if (fail === 0) {
  console.log('\n✓ 这个 IPA 结构完整、配置正确，可以拿去签名安装。');
  console.log('  还需一步：用 Sideloadly / AltStore 以你的 Apple ID 签名后装入 iPhone。');
} else {
  console.log('\n✗ 存在问题，请检查上面的失败项。');
}
process.exit(fail === 0 ? 0 : 1);
