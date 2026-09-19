import type { CapacitorConfig } from '@capacitor/cli';

/**
 * 教学管理信息服务平台（正方教务系统）套壳 App 配置
 *
 * 站点事实（已实测）：
 *   - 入口：http://113.200.156.241/jwglxt/xtgl/index_initMenu.html  → 302 到 login_slogin.html
 *   - 服务器：Tengine/2.1.2，纯 HTTP，**没有 HTTPS**
 *   - 页面自身已是响应式（<meta viewport width=device-width>），手机显示正常
 *   - 登录：系统原生登录页（学号 + 密码），输错多次才出验证码
 *
 * 因为站点是纯 HTTP，Android 9+ 默认禁止 App 内加载明文流量，
 * 所以必须开 cleartextTraffic（见 android/app/src/main/res/xml/network_security_config.xml）。
 */
const config: CapacitorConfig = {
  appId: 'com.jwglxt.shell',
  appName: '教务系统',
  // 没有本地网页，webDir 指向一个只有占位页的目录；真实内容是远程加载
  webDir: 'www',
  // 关键：告诉 Capacitor 这是「远程 URL 套壳」模式
  server: {
    url: 'http://113.200.156.241/jwglxt/xtgl/index_initMenu.html',
    cleartext: true, // 允许 HTTP（Android）
    androidScheme: 'http', // 站点是 http，保持一致，避免混合内容被拦
    iosScheme: 'http',
    allowNavigation: ['113.200.156.241'],
  },
  android: {
    // 站点是 http，若不开启混合内容，WebView 会拒绝加载
    allowMixedContent: true,
    // 背景色跟随系统浅色，避免启动白闪
    backgroundColor: '#ffffff',
  },
  ios: {
    // iOS 同样需要放行 http 明文请求（配合 Info.plist 的 ATS 例外）
    contentInset: 'automatic',
    backgroundColor: '#ffffff',
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      backgroundColor: '#1e5eb8',
      showSpinner: false,
      androidScaleType: 'CENTER_CROP',
      splashFullScreen: true,
      splashImmersive: false,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#1e5eb8',
    },
  },
};

export default config;
