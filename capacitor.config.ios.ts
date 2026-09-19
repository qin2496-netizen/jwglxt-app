import type { CapacitorConfig } from '@capacitor/cli';

/**
 * 教学管理信息服务平台（正方教务系统）套壳 App 配置 —— iOS
 *
 * ⚠️ iOS 与 Android 的关键差异（已实测确认）：
 *
 * 1. 该站点是 **纯 HTTP**（http://113.200.156.241/jwglxt/...），没有 HTTPS。
 *    苹果的 App Transport Security (ATS) 默认禁止明文 HTTP 请求，
 *    因此 iOS 工程必须加 ATS 例外（见 ios/App/App/Info.plist 的 NSAppTransportSecurity）。
 *
 * 2. 苹果审核指南 4.2 明确规定：**纯网页套壳的 App 会被拒**。
 *    也就是说这个 iOS 包**可以自己装到手机上用**（自签 / 描述文件 / TestFlight），
 *    但**基本不可能通过 App Store 审核**。这是苹果政策，不是技术问题。
 *    自用/小范围分发是可行的。
 *
 * 用法差异：
 *   - Android：`node scripts/build-apk.mjs` 直接在本机出 APK
 *   - iOS：本机是 Windows，无法编译 iOS，需走 macOS 或 GitHub Actions（见 .github/workflows/ios.yml）
 */
const config: CapacitorConfig = {
  appId: 'com.jwglxt.shell',
  appName: '教务系统',
  webDir: 'www',
  server: {
    url: 'http://113.200.156.241/jwglxt/xtgl/index_initMenu.html',
    cleartext: true,
    // iOS 侧同样走 http scheme，避免 ATS 与混合内容双重拦截
    iosScheme: 'http',
    allowNavigation: ['113.200.156.241'],
  },
  ios: {
    contentInset: 'automatic',
    backgroundColor: '#ffffff',
    // 允许 WebView 内的链接跳转留在 App 内
    limitsNavigationsToAppBoundDomains: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      backgroundColor: '#1e5eb8',
      showSpinner: false,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#1e5eb8',
    },
  },
};

export default config;
