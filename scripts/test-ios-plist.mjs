/**
 * 测试 prepare-ios.mjs 的 Info.plist 补丁逻辑是否正确。
 *
 * 为什么需要这个测试：
 *   本机是 Windows，无法真正跑 `cap add ios` 来验证脚本。
 *   但 Info.plist 的补丁逻辑（ATS 例外）是 iOS 能否加载 HTTP 站点的关键，
 *   一旦写错就是白屏，而云端 CI 跑一次要好几分钟才发现。
 *   所以这里用一份「和 Capacitor 生成的 Info.plist 结构一致」的样本来单测。
 *
 * 用法：node scripts/test-ios-plist.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');

// 从 prepare-ios.mjs 里导入补丁函数（需先把它导出）
const { patchInfoPlistText } = await import('./prepare-ios.mjs');

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleDevelopmentRegion</key>
\t<string>en</string>
\t<key>CFBundleDisplayName</key>
\t<string>App</string>
\t<key>CFBundleExecutable</key>
\t<string>$(EXECUTABLE_NAME)</string>
\t<key>UIRequiredDeviceCapabilities</key>
\t<array>
\t\t<string>armv7</string>
\t</array>
\t<key>UISupportedInterfaceOrientations</key>
\t<array>
\t\t<string>UIInterfaceOrientationPortrait</string>
\t</array>
</dict>
</plist>
`;

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`✓ ${name}`);
  } else {
    fail++;
    console.log(`✗ ${name}  ${detail}`);
  }
}

console.log('=== 测试 Info.plist 补丁逻辑 ===\n');

const out = patchInfoPlistText(SAMPLE);

// 1. 显示名称被替换
check('应用名改为「教务系统」', out.includes('<string>教务系统</string>'), '未找到中文名');

// 2. ATS 例外写入
check('写入 NSAppTransportSecurity', out.includes('<key>NSAppTransportSecurity</key>'));

// 3. 目标域名在例外列表里
check('例外包含目标域名 113.200.156.241', out.includes('<key>113.200.156.241</key>'));

// 4. 允许非安全 HTTP 加载
check('允许 NSExceptionAllowsInsecureHTTPLoads', out.includes('NSExceptionAllowsInsecureHTTPLoads'));
check('开启 NSIncludesSubdomains', out.includes('NSIncludesSubdomains'));

// 5. WebView 内容也放行（这条是给 WKWebView 用的，缺了会白屏）
check('开启 NSAllowsArbitraryLoadsInWebContent', out.includes('NSAllowsArbitraryLoadsInWebContent'));

// 6. 结构完整性：<dict> 与 </dict> 数量必须相等，否则 plist 损坏
const openDicts = (out.match(/<dict>/g) || []).length;
const closeDicts = (out.match(/<\/dict>/g) || []).length;
check('plist 结构完整（dict 标签配对）', openDicts === closeDicts, `<dict>=${openDicts}, </dict>=${closeDicts}`);

// 7. 原有内容未被破坏
check('原有键值保留（CFBundleExecutable）', out.includes('CFBundleExecutable'));
check('原有数组结构保留', out.includes('<string>armv7</string>'));

// 8. 幂等性：再跑一次不应重复插入
const out2 = patchInfoPlistText(out);
const atsCount2 = (out2.match(/NSAppTransportSecurity/g) || []).length;
check('重复执行不会重复插入 ATS', atsCount2 === 1, `出现 ${atsCount2} 次`);

// 9. 幂等性下结构仍完整
const open2 = (out2.match(/<dict>/g) || []).length;
const close2 = (out2.match(/<\/dict>/g) || []).length;
check('重复执行后结构仍完整', open2 === close2, `<dict>=${open2}, </dict>=${close2}`);

// 10. XML 声明与 DOCTYPE 未被破坏
check('XML 头保留', out.trimStart().startsWith('<?xml'));
check('DOCTYPE 保留', out.includes('<!DOCTYPE plist'));
check('plist 闭合标签保留', out.trimEnd().endsWith('</plist>'));

console.log(`\n${'='.repeat(40)}`);
console.log(`${pass} 项通过，${fail} 项失败`);

if (fail > 0) {
  console.log('\n补丁后的完整内容：\n');
  console.log(out);
  process.exit(1);
}
