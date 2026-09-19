/**
 * 测试 plist 补丁函数对各种真实写法的处理。
 * 用法：node scripts/test-plist-variants.mjs
 */
import { patchInfoPlistText } from './prepare-ios.mjs';

const cases = [
  ['标准写法', '<key>CFBundleDisplayName</key>\n\t<string>App</string>'],
  ['变量写法', '<key>CFBundleDisplayName</key>\n\t<string>$(PRODUCT_NAME)</string>'],
  ['单行', '<key>CFBundleDisplayName</key><string>App</string>'],
  ['空格缩进', '    <key>CFBundleDisplayName</key>\n    <string>App</string>'],
  ['缺该 key', '<key>CFBundleName</key>\n\t<string>App</string>'],
  ['已中文', '<key>CFBundleDisplayName</key>\n\t<string>教务系统</string>'],
];

console.log('=== 各种 plist 写法下的补丁结果 ===\n');

for (const [name, snippet] of cases) {
  const plist =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n<dict>\n' +
    snippet +
    '\n</dict>\n</plist>\n';

  const out = patchInfoPlistText(plist);
  const m = out.match(/<key>CFBundleDisplayName<\/key>\s*<string>([^<]*)<\/string>/);
  const hasAts = out.includes('NSAppTransportSecurity');

  console.log(
    `${name.padEnd(10)} 显示名 → ${m ? `「${m[1]}」` : '(缺失)'}   ATS → ${hasAts ? '已加' : '未加'}`
  );
}

console.log('\n=== 检查 ATS 块是否破坏 plist 结构 ===');
const sample =
  '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n' +
  '<key>CFBundleDisplayName</key>\n\t<string>App</string>\n' +
  '<key>CFBundleIdentifier</key>\n\t<string>com.jwglxt.shell</string>\n' +
  '</dict>\n</plist>\n';
const result = patchInfoPlistText(sample);
console.log(result);

// 统计 dict 开闭是否配对
const openDicts = (result.match(/<dict>/g) || []).length;
const closeDicts = (result.match(/<\/dict>/g) || []).length;
console.log(`\n<dict> 数量: ${openDicts}  </dict> 数量: ${closeDicts}  → ${openDicts === closeDicts ? '✓ 配对' : '✗ 不配对'}`);
