/**
 * 一键准备 iOS 工程（在 macOS 上运行，或由 GitHub Actions 调用）。
 *
 * 为什么需要这个脚本：
 *   `npx cap add ios` 必须在 macOS 上执行（Capacitor 的 iOS 平台依赖 Xcode 工具链，
 *   Windows 上跑会直接失败）。因此本机（Windows）只能把配置准备好，
 *   真正生成 ios/ 目录要在 Mac 或 GitHub Actions 的 macos 运行器里做。
 *
 * 这个脚本在 `cap add ios` 之后自动做三件必要的事：
 *   1. 写入 ATS 例外（否则 iOS 会因为站点是 HTTP 而拒绝加载，白屏）
 *   2. 替换 App 图标为生成的图标
 *   3. 设置显示名称为「教务系统」
 *
 * 用法（Mac 上）：
 *   node scripts/prepare-ios.mjs
 *
 * Info.plist 的补丁逻辑是纯函数（patchInfoPlistText），
 * 可用 scripts/test-ios-plist.mjs 在任意平台上单测。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const IOS_APP = join(ROOT, 'ios', 'App', 'App');
const INFO_PLIST = join(IOS_APP, 'Info.plist');

const SITE_HOST = '113.200.156.241';
const APP_DISPLAY_NAME = '教务系统';

function log(msg) {
  console.log(msg);
}

/**
 * 对 Info.plist 文本写入 ATS 例外与应用名。
 *
 * 这是**纯函数**，方便在 Windows 上单测（本机无法真的生成 iOS 工程）。
 *
 * 三个必须同时满足的点，少一个都可能白屏：
 *   1. NSAppTransportSecurity → NSExceptionDomains → <域名> →
 *      NSExceptionAllowsInsecureHTTPLoads：允许对该域名发明文 HTTP
 *   2. NSAllowsArbitraryLoadsInWebContent：允许 WKWebView 内部加载非 HTTPS 内容。
 *      这一条是给 WebView 用的，和上面针对 NSURLSession 的例外不是一回事，
 *      配了这个套壳才稳（Capacitor 的内容全在自己的 WKWebView 里）。
 *   3. 结构必须保持合法（<dict> 与 </dict> 配对），否则 Xcode 读不了 plist。
 *
 * @param {string} plist 原始 Info.plist 内容
 * @returns {string} 补丁后的内容
 */
export function patchInfoPlistText(plist) {
  let out = plist;

  // ---- 1. 显示名称 ----
  out = out.replace(
    /(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/,
    `$1${APP_DISPLAY_NAME}$2`
  );

  // ---- 2. ATS 例外（只在缺失时插入，保证幂等）----
  if (!out.includes('NSAppTransportSecurity')) {
    const atsBlock = `\t<key>NSAppTransportSecurity</key>
\t<dict>
\t\t<!-- 教务系统只有 HTTP、没有 HTTPS，必须显式放行，否则 iOS 拒绝加载 -->
\t\t<key>NSAllowsArbitraryLoadsInWebContent</key>
\t\t<true/>
\t\t<key>NSExceptionDomains</key>
\t\t<dict>
\t\t\t<key>${SITE_HOST}</key>
\t\t\t<dict>
\t\t\t\t<key>NSExceptionAllowsInsecureHTTPLoads</key>
\t\t\t\t<true/>
\t\t\t\t<key>NSIncludesSubdomains</key>
\t\t\t\t<true/>
\t\t\t</dict>
\t\t</dict>
\t</dict>
`;

    // 插到最外层 </dict> 之前。
    // 注意：必须找**最后一个** </dict>（即根字典的闭合），
    // 插到别处会破坏 plist 结构。
    const idx = out.lastIndexOf('</dict>');
    if (idx === -1) {
      throw new Error('Info.plist 里找不到 </dict>，文件格式异常');
    }
    out = out.slice(0, idx) + atsBlock + out.slice(idx);
  } else if (!out.includes('NSAllowsArbitraryLoadsInWebContent')) {
    // 已有 ATS 块但缺 WebView 那条（例如别人手改过），补进去
    out = out.replace(
      /(<key>NSAppTransportSecurity<\/key>\s*<dict>)/,
      `$1\n\t\t<key>NSAllowsArbitraryLoadsInWebContent</key>\n\t\t<true/>`
    );
  }

  return out;
}

/** 1) 生成 ios/ 目录（如果还没有） */
function ensureIosProject() {
  if (existsSync(join(ROOT, 'ios', 'App', 'App.xcodeproj'))) {
    log('✓ ios/ 工程已存在，跳过 cap add ios');
    return;
  }
  log('> npx cap add ios');
  execFileSync('npx', ['cap', 'add', 'ios'], { cwd: ROOT, stdio: 'inherit' });
}

/** 2) 应用 Info.plist 补丁 */
function patchInfoPlist() {
  if (!existsSync(INFO_PLIST)) {
    log(`✗ 找不到 Info.plist：${INFO_PLIST}`);
    process.exit(1);
  }

  const before = readFileSync(INFO_PLIST, 'utf8');
  const after = patchInfoPlistText(before);

  // 写回前自检结构，避免把 plist 写坏
  const openDicts = (after.match(/<dict>/g) || []).length;
  const closeDicts = (after.match(/<\/dict>/g) || []).length;
  if (openDicts !== closeDicts) {
    log(`✗ 补丁后 plist 结构不合法（<dict>=${openDicts}, </dict>=${closeDicts}），已中止以免写坏文件`);
    process.exit(1);
  }

  if (after !== before) {
    writeFileSync(INFO_PLIST, after);
    log('✓ 已写入 ATS 例外 + 应用名（允许加载 HTTP 站点）');
  } else {
    log('✓ Info.plist 已是目标状态，无需修改');
  }
}

/**
 * 3) 替换 App 图标。
 * Capacitor 生成的 iOS 工程用 Assets.xcassets/AppIcon.appiconset，
 * 这里把预先生成的 1024 图标放进去并写好 Contents.json。
 */
function patchAppIcon() {
  const src = join(ROOT, 'assets', 'ios', 'AppIcon-1024.png');
  if (!existsSync(src)) {
    log('⚠ 找不到 assets/ios/AppIcon-1024.png，跳过图标替换');
    log('  （可先跑 node scripts/make-icons.mjs 生成，该脚本跨平台可用）');
    return;
  }

  const iconSet = join(IOS_APP, 'Assets.xcassets', 'AppIcon.appiconset');
  mkdirSync(iconSet, { recursive: true });
  copyFileSync(src, join(iconSet, 'AppIcon-1024.png'));

  // 单尺寸（1024）即可满足现代 Xcode 的要求
  writeFileSync(
    join(iconSet, 'Contents.json'),
    JSON.stringify(
      {
        images: [
          {
            filename: 'AppIcon-1024.png',
            idiom: 'universal',
            platform: 'ios',
            scale: '1x',
            size: '1024x1024',
          },
        ],
        info: { author: 'xcode', version: 1 },
      },
      null,
      2
    )
  );
  log('✓ 已替换 App 图标');
}

/**
 * 4) Podfile 平台设置 —— 仅当使用 CocoaPods 时才需要。
 *
 * 重要：Capacitor 8 已改用 **Swift Package Manager**，
 * `cap sync ios` 会输出 "All Capacitor plugins have a Package.swift file"，
 * 并且**不生成 Podfile**。所以这里不再强制要求 Podfile 存在，
 * 没有就安静跳过（早期版本误判为警告，且工作流里还跑了 pod install，
 * 导致报 "No Podfile found in the project directory" 而构建失败）。
 */
function ensurePodfilePlatform() {
  const podfile = join(ROOT, 'ios', 'App', 'Podfile');
  if (!existsSync(podfile)) {
    log('· 未发现 Podfile → Capacitor 8 使用 SPM，无需 CocoaPods，跳过');
    return;
  }

  let s = readFileSync(podfile, 'utf8');
  const before = s;

  if (/^\s*#?\s*platform\s+:ios/m.test(s)) {
    s = s.replace(/^\s*#?\s*platform\s+:ios.*$/m, "platform :ios, '14.0'");
  } else {
    s = s.replace(/^(require|source|target)/m, "platform :ios, '14.0'\n$1");
  }

  if (s !== before) {
    writeFileSync(podfile, s);
    log('✓ 已设置 Podfile 平台为 iOS 14.0');
  } else {
    log('✓ Podfile 平台已就绪');
  }
}

/**
 * 同步后修正：重新写入应用名与 ATS 例外。
 *
 * 为什么需要单独一步：
 *   `cap add ios` 生成工程时应用名是正确的，但**紧接着的 `cap sync ios`
 *   会重新生成 Info.plist，把 CFBundleDisplayName 覆盖成目录名 "App"**。
 *   实测产物里 CFBundleDisplayName = "App"，装到 iPhone 上桌面图标就叫 "App"，
 *   而不是「教务系统」。
 *   因此必须在 sync 之后再补一次，并校验结果。
 */
export function fixAfterSync() {
  log('=== 同步后修正（应用名 + ATS）===');
  patchInfoPlist();
  patchAppIcon();
  verifyInfoPlist();
}

/**
 * 校验 Info.plist 的关键字段是否正确写入。
 * 这是构建前的最后一道关，避免带着 "App" 这种名字或缺失 ATS 的包发出去。
 */
function verifyInfoPlist() {
  if (!existsSync(INFO_PLIST)) {
    throw new Error(`找不到 ${INFO_PLIST}`);
  }
  const s = readFileSync(INFO_PLIST, 'utf8');
  const problems = [];

  const nameMatch = s.match(/<key>CFBundleDisplayName<\/key>\s*<string>([^<]*)<\/string>/);
  if (!nameMatch) {
    problems.push('缺少 CFBundleDisplayName');
  } else if (nameMatch[1] !== APP_DISPLAY_NAME) {
    problems.push(`CFBundleDisplayName 为「${nameMatch[1]}」，期望「${APP_DISPLAY_NAME}」`);
  }

  if (!/NSAppTransportSecurity/.test(s)) problems.push('缺少 NSAppTransportSecurity');
  if (!/NSAllowsArbitraryLoadsInWebContent/.test(s)) problems.push('缺少 NSAllowsArbitraryLoadsInWebContent');
  if (!/NSExceptionAllowsInsecureHTTPLoads/.test(s)) problems.push('缺少 NSExceptionAllowsInsecureHTTPLoads');
  if (!s.includes(SITE_HOST)) problems.push(`缺少域名例外 ${SITE_HOST}`);

  if (problems.length) {
    log('✗ Info.plist 校验未通过：');
    problems.forEach((p) => log(`    - ${p}`));
    process.exit(1);
  }
  log(`✓ Info.plist 校验通过（应用名「${APP_DISPLAY_NAME}」，ATS 例外完整）`);
}

function main() {
  // 被当作模块导入（单测）时不要执行主流程
  if (process.argv[1] && !process.argv[1].endsWith('prepare-ios.mjs')) return;

  // --- 模式二：同步后修正（不依赖 macOS，只改文件）---
  // 用法：node scripts/prepare-ios.mjs --after-sync
  if (process.argv.includes('--after-sync')) {
    if (!existsSync(join(ROOT, 'ios'))) {
      log('✗ 找不到 ios/ 目录，请先执行 cap add ios');
      process.exit(1);
    }
    fixAfterSync();
    log('\n✓ 同步后修正完成');
    return;
  }

  // --- 模式一：首次准备工程（需要 macOS）---
  if (process.platform !== 'darwin') {
    log('⚠ 当前不是 macOS，cap add ios 无法在非 Mac 上运行。');
    log('  请在 Mac 上执行本脚本，或使用 .github/workflows/ios.yml 云端构建。');
    log('');
    log('  提示：plist 补丁逻辑可在任意平台单测：');
    log('    node scripts/test-ios-plist.mjs');
    process.exit(1);
  }

  log('=== 准备 iOS 工程 ===');
  ensureIosProject();
  patchInfoPlist();
  patchAppIcon();
  ensurePodfilePlatform();
  log('\n✓ iOS 工程准备完成');
  log('  下一步：npx cap sync ios && node scripts/prepare-ios.mjs --after-sync');
}

main();
