# 教务系统 App（Android / iOS 套壳）

把学校的**教学管理信息服务平台**（正方教务系统）包装成手机 App。

| 项目 | 值 |
|---|---|
| 目标站点 | `http://113.200.156.241/jwglxt/xtgl/index_initMenu.html` |
| 站点性质 | 正方教务系统（zfsoft），纯 HTTP、无 HTTPS，页面本身已响应式 |
| App 名称 | 教务系统 |
| 包名 / Bundle ID | `com.jwglxt.shell` |
| 技术方案 | Capacitor 8 远程 URL 套壳（WebView 直接加载线上站点） |

---

## 一、结论速览：你这台电脑能做出什么

| 平台 | 本机能否直接做出成品 | 说明 |
|---|---|---|
| **Android** | ✅ **能，且已做出** | 产物在 `dist-apk/教务系统.apk`（2.9 MB，已签名） |
| **iOS** | ❌ **不能** | 编译 iOS 必须 macOS + Xcode，Windows 无解（苹果的硬性限制，不是缺工具）。已配好 GitHub Actions，推到 GitHub 上云端免费出包 |

### ⚠️ 打包当天站点本身的状况（重要）

打包期间实测：**学校服务器持续返回 502 Bad Gateway**。
反复测 10 次全部 502，`/`、`/jwglxt/`、登录页都一样。

**这是学校服务器端的故障，与 App 无关**，依据是：

- 同一天早些时候该站可以正常访问，登录页内容成功抓取过
  （标题「教学管理信息服务平台」、响应式 viewport 都已确认）
- 期间只偶发恢复过一次（某次探测返回 200，随后又全部 502）
- App 侧 13 项自检全部通过（签名、明文流量、目标地址、图标等）

**影响与应对**：APK 本身完全正常。如果装上时服务器还没修好，打开会停在
「正在打开教务系统…」的占位页。**等学校服务器恢复后直接就能用，不需要重新打包。**

先用手机浏览器访问该网址验证一下服务器是否恢复，是最快的判断方式。

---

## 二、打包安卓 APK（本机可完成）

```bash
node scripts/build-apk.mjs
```

脚本会依次完成：

1. `cap sync android` —— 同步配置到原生工程
2. **修补被 Capacitor 重置的构建配置**（见下方「踩过的坑」）
3. `gradlew assembleRelease` —— 构建签名 APK
4. 把产物复制到 `dist-apk/教务系统.apk`

调试版（不签名、装得快）：

```bash
node scripts/build-apk.mjs --debug
```

### 自检（装到手机前建议跑一次）

```bash
node scripts/verify-apk.mjs
```

会检查 13 项：签名块、包名、明文流量开关、网络安全配置、包内目标地址、
图标资源、以及**站点当前是否可达**（用来区分「App 有问题」和「学校服务器挂了」）。

> 该脚本是**纯 JavaScript 解析 APK**（自实现 ZIP + 二进制 AXML 解析），
> 不依赖本机 Android SDK，换台电脑也能跑。

### 装到手机

把 `dist-apk/教务系统.apk` 传到手机（微信/QQ/数据线/网盘均可），点开安装，
首次会提示「未知来源应用」，允许即可。

---

## 三、iOS 怎么做（云端出包）

本机是 Windows，**无法**编译 iOS。已准备好 GitHub Actions 工作流：
`.github/workflows/ios.yml`

流程：

1. 在 GitHub 建一个仓库，把 `教务App` 整个目录推上去
2. 打开仓库的 **Actions** 页 → 选 **Build iOS App (IPA)** → **Run workflow**
3. 等约 5～10 分钟，在该次运行页面底部下载 `ios-unsigned-ipa` 产物

### ⚠️ 关于 iOS 的三个硬事实（必须知道）

1. **未签名的 IPA 装不到 iPhone 上。**
   工作流默认产出未签名包，要装到手机上还需要苹果签名，三种途径：
   - 苹果开发者账号（$99/年）→ 可装设备、可上架
   - 用免费 Apple ID + Sideloadly / AltStore 自签 → **7 天有效期**，到期要重签
   - 借一台 Mac，用 Xcode 直接 Run（免费 Apple ID 也能装，同样 7 天）

2. **这个 App 基本不可能通过 App Store 审核。**
   苹果审核指南 4.2 明确规定「仅仅是网页套壳的 App」会被拒。
   自己装、小范围分发给同学用没问题，上架希望渺茫。

3. **在 Mac 上生成 iOS 工程要先跑一次准备脚本：**
   ```bash
   node scripts/prepare-ios.mjs
   ```
   它会执行 `cap add ios`，并自动写入 iOS 必需的 **ATS 例外**
   （站点是 HTTP，不配这个 iOS 会直接拒绝加载、白屏）。

---

## 四、踩过的坑（都已在脚本里自动处理）

| 现象 | 原因 | 处理 |
|---|---|---|
| `无效的源发行版：21` | Capacitor 8 生成的 `capacitor.build.gradle` 写死 Java 21，本机只有 JDK 17 | 构建脚本每次自动把 `VERSION_21` 改回 17 |
| `Minimum supported Gradle version is 8.13` | Capacitor 8 的 AGP 要求 Gradle ≥ 8.13 | wrapper 用 `gradle-8.13-bin` |
| `gradle-x.x.zip.lck 拒绝访问` | 沙箱限制写 `C:\Users\L\.gradle` | 构建时把 `GRADLE_USER_HOME` 指到工作区内 `.gradle-home` |
| `Your project path contains non-ASCII characters` | 工程路径含中文（`D:\JA\pdf工具\`），AGP 默认拒绝 | `android/gradle.properties` 加 `android.overridePathCheck=true` |
| `Duplicate class kotlin.io.path.*` | `kotlin-stdlib` 1.8.22 与被传递依赖带入的 1.6.21 `jdk7/jdk8` 冲突 | `app/build.gradle` 排除这两个旧拆分包 |
| **安卓 9+ 页面白屏** | 站点是 HTTP，Android 9 起默认禁止 App 加载明文流量 | 加 `network_security_config.xml`，只对本校 IP 放行明文 |
| **iOS 白屏** | 苹果 ATS 默认只允许 HTTPS | Info.plist 加 `NSAppTransportSecurity` 例外（`prepare-ios.mjs` 自动写入） |
| `compileSdk 36` 找不到平台 | 本机只有 `android-35` 与 `android-36.1`，而 36.1 **不满足** "compileSdk 36" | `variables.gradle` 用 35，并配 API 35 可编译的 androidx 版本 |

---

## 五、这个套壳做了哪些「原生适配」

不只是塞一个 WebView，以下几项是实际用起来能感受到的差别：

### 1. 返回键走网页历史（`MainActivity.java`）

正方教务系统大量用 iframe：点左侧菜单，内容区是 iframe 跳转，
主 WebView 的历史长度几乎不变。Capacitor 默认行为是「不能后退就退出 App」，
结果学生在「课表 → 成绩详情」里按一下返回，**App 直接被关掉，得重新登录**。

处理方式分三层：

1. 主 WebView 能后退 → 后退
2. 主页面不能后退，但内层 iframe 有历史 → 让最内层 iframe 后退
3. 都到根页面了 → **连按两次返回才退出**，并弹 Toast 提示（防误触）

### 2. HTTP 明文流量放行

站点没有 HTTPS。Android 用 `network_security_config.xml` 只对
`113.200.156.241` 放行明文，其它域名仍强制 HTTPS，避免整体放开带来的安全面扩大。

### 3. 启动图标与名称

图标用 SVG 矢量绘制（深蓝底 + 白色学士帽 + 金色流苏），
覆盖 Android 全套密度（mdpi～xxxhdpi，含圆形与自适应前景层）与 iOS 1024 图标。

> 为什么不用站点自带 favicon：实测它只是单个 **32×32 的 BMP 位图**，
> 放大到 192/1024 会非常模糊。用矢量自绘清晰得多。

---

## 六、目录结构

```
教务App/
├─ capacitor.config.ts          # 主配置（远程 URL、明文放行、插件）
├─ capacitor.config.ios.ts      # iOS 侧说明与配置参考
├─ www/index.html               # 占位页（仅远程打不开时可见）
├─ scripts/
│  ├─ build-apk.mjs             # ★ 一键出安卓 APK（本机可用）
│  ├─ prepare-ios.mjs           # ★ 生成 iOS 工程 + 写 ATS 例外（需 Mac）
│  ├─ make-icons.mjs            # 生成全套 App 图标
│  └─ download.mjs              # 断点续传下载器（网络不稳时用）
├─ assets/                      # 图标源文件与预览
├─ android/                     # 原生工程（已生成，本机可构建）
│  ├─ keystore.properties       # 签名配置
│  └─ keystore/jwglxt.jks       # 签名密钥（★ 务必备份）
├─ .github/workflows/ios.yml    # iOS 云端构建
└─ dist-apk/                    # 打包产物
```

---

## 七、重要提醒

- **`android/keystore/jwglxt.jks` 务必单独备份。**
  安卓规定：同一个 App 的后续版本必须用同一个密钥签名。
  密钥丢了，就只能卸载重装，用户数据（登录状态等）会丢。
  密码写在 `android/keystore.properties` 里。

- **App 内的登录是系统原生的登录页**，学号密码直接提交给学校服务器，
  本 App 不接触、不存储任何账号信息。

- **站点只有 HTTP，登录信息是明文传输的**（这是学校服务器的配置决定的，
  不是 App 引入的问题，用手机浏览器访问同样如此）。
