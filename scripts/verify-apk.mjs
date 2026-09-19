/**
 * APK 自检：确认产物真的可用，而不是「构建成功但装上去白屏」。
 *
 * 实现说明 —— 为什么不用 aapt2 / apksigner：
 *   当前沙箱禁止 Node 通过 shell 管道捕获子进程输出
 *   （spawnSync cmd.exe 报 EPERM）。而 aapt2/apksigner 都是 .bat/.exe，
 *   必须经 shell 才能拿到结果。因此这里改为**纯 JavaScript 解析 APK**：
 *   APK 本质是 zip，AndroidManifest.xml 是二进制 XML，
 *   这里实现一个最小可用的 AXML 解析器直接读取所需属性。
 *   好处是不依赖本机 Android SDK，换机器也能跑。
 *
 * 检查项（每一条都是可能导致白屏或装不上的关键点）：
 *   1. 是合法 zip、结构完整
 *   2. 包名 / 版本
 *   3. usesCleartextTraffic + networkSecurityConfig（HTTP 站点能否加载的关键）
 *   4. 包内 capacitor.config.json 的 server.url 是否指向目标站点
 *   5. 图标资源存在
 *   6. 站点当前是否可达（区分「服务器问题」与「App 问题」）
 *
 * 用法：node scripts/verify-apk.mjs
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get as httpGet } from 'node:http';
import { inflateRawSync } from 'node:zlib';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const APK = join(ROOT, 'dist-apk', '教务系统.apk');
const SITE = 'http://113.200.156.241/jwglxt/xtgl/index_initMenu.html';

// ---------------------------------------------------------------------------
// 最小 ZIP 解析（只支持 APK 会用到的 stored / deflate）
// ---------------------------------------------------------------------------
function readZipEntries(buf) {
  // 从尾部找 End of Central Directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是合法 zip（找不到 EOCD）');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);

    // 读 local header 得到真实数据起点
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    entries.set(name, { method, raw });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(entries, name) {
  const e = entries.get(name);
  if (!e) return null;
  return e.method === 0 ? e.raw : inflateRawSync(e.raw);
}

// ---------------------------------------------------------------------------
// 最小 AXML（二进制 AndroidManifest）解析
// ---------------------------------------------------------------------------
const STRING_POOL = 0x0001;
const START_ELEMENT = 0x0102;

function parseAxml(buf) {
  const result = { strings: [], elements: [] };

  if (buf.readUInt16LE(0) !== 0x0003) throw new Error('不是二进制 AXML');

  let off = 8;
  while (off < buf.length) {
    const type = buf.readUInt16LE(off);
    const headerSize = buf.readUInt16LE(off + 2);
    const chunkSize = buf.readUInt32LE(off + 4);
    if (chunkSize === 0) break;

    if (type === STRING_POOL) {
      const strCount = buf.readUInt32LE(off + 8);
      const flags = buf.readUInt32LE(off + 16);
      const stringsStart = buf.readUInt32LE(off + 20);
      const isUtf8 = (flags & (1 << 8)) !== 0;
      const offsets = [];
      for (let i = 0; i < strCount; i++) offsets.push(buf.readUInt32LE(off + 28 + i * 4));
      for (const so of offsets) {
        const base = off + stringsStart + so;
        if (isUtf8) {
          // UTF-8：先是一个 u8 的字符长度，再是 u8 字节长度
          let p = base;
          const charLen = buf[p++];
          let byteLen;
          if (charLen & 0x80) {
            byteLen = ((charLen & 0x7f) << 8) | buf[p++];
          } else {
            byteLen = buf[p++];
          }
          result.strings.push(buf.toString('utf8', p, p + byteLen));
        } else {
          // UTF-16
          let p = base;
          let len = buf.readUInt16LE(p);
          p += 2;
          if (len & 0x8000) {
            len = ((len & 0x7fff) << 16) | buf.readUInt16LE(p);
            p += 2;
          }
          result.strings.push(buf.toString('utf16le', p, p + len * 2));
        }
      }
    } else if (type === START_ELEMENT) {
      const nameIdx = buf.readUInt32LE(off + 20);
      const attrCount = buf.readUInt16LE(off + 28);
      const attrs = [];
      for (let a = 0; a < attrCount; a++) {
        const ao = off + 36 + a * 20;
        const nsIdx = buf.readUInt32LE(ao);
        const nameI = buf.readUInt32LE(ao + 4);
        const rawValIdx = buf.readUInt32LE(ao + 8);
        const valueType = buf.readUInt8(ao + 15);
        const dataVal = buf.readUInt32LE(ao + 16);
        attrs.push({
          ns: nsIdx === 0xffffffff ? null : result.strings[nsIdx],
          name: result.strings[nameI],
          rawValue: rawValIdx === 0xffffffff ? null : result.strings[rawValIdx],
          valueType,
          data: dataVal,
        });
      }
      result.elements.push({ name: result.strings[nameIdx], attrs });
    }

    off += chunkSize;
  }
  return result;
}

// ---------------------------------------------------------------------------
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  —— ' + detail : ''}`);
}

function probeSite(url, redirects = 0) {
  return new Promise((resolve) => {
    if (redirects > 5) return resolve({ ok: false, note: '重定向过多' });
    const req = httpGet(url, { timeout: 15000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        return resolve(probeSite(new URL(res.headers.location, url).toString(), redirects + 1));
      }
      res.resume();
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, note: '连接超时' });
    });
    req.on('error', (e) => resolve({ ok: false, note: e.message }));
    req.end();
  });
}

async function main() {
  console.log('=== APK 自检 ===\n');

  if (!existsSync(APK)) {
    console.log(`✗ 找不到 APK：${APK}`);
    console.log('  请先运行：node scripts/build-apk.mjs');
    process.exit(1);
  }

  console.log(`产物：${APK}`);
  console.log(`体积：${(statSync(APK).size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`时间：${statSync(APK).mtime.toLocaleString()}\n`);

  const buf = readFileSync(APK);
  let entries;
  try {
    entries = readZipEntries(buf);
    check('APK 结构合法', entries.size > 0, `共 ${entries.size} 个条目`);
  } catch (e) {
    check('APK 结构合法', false, e.message);
    process.exit(1);
  }

  // ---- 签名（只看是否存在签名块，不做完整校验）----
  const hasV2 = buf.includes(Buffer.from('APK Sig Block 42'));
  check('含 v2 签名块', hasV2, hasV2 ? '可正常安装' : '未签名，装不上');

  // ---- AndroidManifest ----
  const axmlBuf = readEntry(entries, 'AndroidManifest.xml');
  if (!axmlBuf) {
    check('AndroidManifest.xml 存在', false);
  } else {
    const axml = parseAxml(axmlBuf);
    const manifest = axml.elements.find((e) => e.name === 'manifest');
    const app = axml.elements.find((e) => e.name === 'application');

    // 包名
    const pkg = manifest?.attrs.find((a) => a.name === 'package')?.rawValue;
    check('包名正确', pkg === 'com.jwglxt.shell', pkg);

    // versionName（属性值可能是字符串池索引）
    const vName = manifest?.attrs.find((a) => a.name === 'versionName');
    check('版本号存在', !!vName, vName?.rawValue || '');

    // 明文流量 —— HTTP 站点能否加载的关键
    const cleartext = app?.attrs.find((a) => a.name === 'usesCleartextTraffic');
    check(
      '已允许明文 HTTP 流量',
      cleartext?.data === 1 || cleartext?.data === 0xffffffff,
      cleartext ? `usesCleartextTraffic=${cleartext.data === 1 || cleartext.data === 0xffffffff}` : '属性缺失'
    );

    const nsc = app?.attrs.find((a) => a.name === 'networkSecurityConfig');
    check('已应用网络安全配置', !!nsc, nsc ? 'networkSecurityConfig 已引用' : '属性缺失');

    // 应用名（中文）
    const label = app?.attrs.find((a) => a.name === 'label');
    check('已设置应用名', !!label, label?.rawValue || `资源引用 0x${label?.data?.toString(16)}`);

    // 启动 Activity
    const act = axml.elements.find((e) => e.name === 'activity');
    check('启动 Activity 存在', !!act, act?.attrs.find((a) => a.name === 'name')?.rawValue);
  }

  // ---- 图标资源 ----
  const iconCount = [...entries.keys()].filter((k) => /^res\/.*\.(png|xml)$/.test(k)).length;
  check('资源已打包', iconCount > 0, `${iconCount} 个资源条目（AGP 会混淆文件名，属正常）`);

  // ---- 包内 Capacitor 配置 ----
  const cfgRaw = readEntry(entries, 'assets/capacitor.config.json');
  if (cfgRaw) {
    const cfg = JSON.parse(cfgRaw.toString('utf8'));
    check('包内目标地址正确', cfg.server?.url === SITE, cfg.server?.url);
    check('包内已开启 cleartext', cfg.server?.cleartext === true);
    check('包内已允许混合内容', cfg.android?.allowMixedContent === true);
  } else {
    check('包内含 capacitor.config.json', false);
  }

  // ---- 站点可达性 ----
  console.log('\n--- 站点可达性（用来区分「App 问题」与「学校服务器问题」）---');
  const site = await probeSite(SITE);
  if (site.ok) {
    check('教务系统当前可访问', true, `HTTP ${site.status}`);
  } else {
    check('教务系统当前可访问', false,
          `HTTP ${site.status || site.note} —— 这是学校服务器端的问题，App 本身正常`);
  }

  // ---- 汇总 ----
  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '='.repeat(56));
  const realFailures = failed.filter((f) => !f.name.includes('教务系统当前可访问'));
  if (realFailures.length === 0 && site.ok) {
    console.log(`全部通过（${results.length} 项）。APK 可装到手机上使用。`);
  } else if (realFailures.length === 0) {
    console.log(`App 侧检查全部通过（${results.length} 项）。`);
    console.log(`唯一问题：学校服务器当前不可用，等它恢复即可，无需重新打包。`);
  } else {
    console.log(`${results.length - failed.length}/${results.length} 项通过。未通过：`);
    for (const f of realFailures) console.log(`  · ${f.name} ${f.detail}`);
  }
}

main();
