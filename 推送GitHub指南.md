# 推送 GitHub 并云端构建 iOS —— 操作指南

> 给你（人）看的步骤说明。照着做就行，全程约 15 分钟。

---

## 前提：为什么必须走云端

本机是 Windows，**编译 iOS 必须 macOS + Xcode**，Windows 上没有任何办法。
GitHub Actions 提供免费的 macOS 运行器（公开仓库完全免费，私有仓库每月 2000 分钟也够用）。

---

## 第一步：在 GitHub 建仓库

1. 打开 https://github.com/new
2. **Repository name** 填 `jwglxt-app`（或你喜欢的名字）
3. 选 **Private**（私有）或 Public 都行
   - 注意：如果选 Public，**签名密钥会公开**。见下方「安全提醒」
4. **不要**勾选 "Add a README file"、"Add .gitignore"（我们本地已经有了）
5. 点 **Create repository**

建好后页面会显示仓库地址，形如：
```
https://github.com/你的用户名/jwglxt-app.git
```

---

## 第二步：在本地初始化并推送

打开 PowerShell，依次执行（把 `你的用户名` 换成实际用户名）：

```powershell
cd "D:\JA\pdf工具\教务App"

git init

# 配置身份（只需一次，若已配过可跳过）
git config user.name "你的名字"
git config user.email "你的邮箱"

git add .
git commit -m "教务系统套壳 App：安卓 APK + iOS 云端构建"

git branch -M main

git remote add origin https://github.com/你的用户名/jwglxt-app.git

git push -u origin main
```

推送时会要求登录。GitHub 现在**不接受账号密码**，需要用 Personal Access Token：
- 生成地址：https://github.com/settings/tokens → Generate new token (classic)
- 勾选 `repo` 权限即可
- 生成后复制那串 token，在提示 `Password:` 时**粘贴 token**（不是账号密码）

> 如果你装了 GitHub Desktop 或 Git Credential Manager，浏览器会直接弹窗授权，更省事。

---

## 第三步：触发构建

推送成功后：

1. 打开 `https://github.com/你的用户名/jwglxt-app/actions`
2. 左侧选 **Build iOS App (IPA)**
3. 若没自动开始，点右侧 **Run workflow** → **Run workflow**
4. 等约 **5～10 分钟**（首次要下载 CocoaPods 依赖，会久一点）

构建过程中会依次执行：
- 校验 plist 补丁逻辑（快速失败，避免白跑十分钟）
- 生成 iOS 工程 + 写入 ATS 例外
- `pod install`
- `xcodebuild archive`
- 校验产物里 ATS 配置真的生效了
- 打包并上传 IPA

---

## 第四步：下载 IPA

构建成功后，点进那次运行记录，页面**底部**有 **Artifacts** 区域：

- `ios-unsigned-ipa` —— 这就是成品（30 天有效，过期需重新构建）

点它下载，得到 `jwglxt-unsigned.ipa`。

---

## 第五步：装到 iPhone 上

**这一步绕不开苹果的签名限制。** 未签名的 IPA 是装不上的，三种办法：

### 方案 A：免费 Apple ID 自签（推荐先试这个）

1. 电脑装 [Sideloadly](https://sideloadly.io/)（Windows 版可用）
2. 用数据线连上 iPhone
3. 把 `jwglxt-unsigned.ipa` 拖进 Sideloadly
4. 填你的 Apple ID
5. 点 Start，按提示在 iPhone 上「设置 → 通用 → VPN与设备管理」里信任该证书

**代价：7 天后失效，要重新签一次。** 到期后 App 会闪退打不开。

### 方案 B：苹果开发者账号（$99/年）

有账号后可以提供证书与描述文件，在工作流里加签名步骤（告诉我，我来配），
产出的 IPA 就能直接安装，有效期 1 年。

### 方案 C：借一台 Mac

用 Xcode 打开工程直接 Run，免费 Apple ID 也能装（同样是 7 天）。

---

## ⚠️ 安全提醒：签名密钥

**签名密钥已被 `.gitignore` 忽略，不会被推上去** —— 这是刻意的：

- **iOS 云端构建不需要它**（产出的 IPA 是未签名的，真正的苹果签名在你本地做）
- 安卓打包是**在你本机跑**的，密钥一直在本地，无需上云
- 推到公开仓库也不会泄露

但请**单独备份**这两样（复制到网盘/移动硬盘都行）：

```
android\keystore\jwglxt.jks         ← 签名密钥本体
android\keystore.properties         ← 密钥密码
```

**为什么必须备份**：安卓规定同一个 App 的后续版本必须用**同一个密钥**签名。
密钥丢了，新版就装不上旧版（会提示签名冲突），只能卸载重装，用户数据全丢。

若哪天你想改成「密钥进私有仓库以便换电脑构建」，把 `.gitignore` 里那两行注释掉即可
（**前提是仓库必须是 Private**）。

---

## 常见问题

**Q：Actions 页面没看到工作流？**
先确认 `.github/workflows/ios.yml` 确实推上去了：
```powershell
git ls-files .github/workflows/
```
GitHub 只识别默认分支（main）上的工作流。推完刷新页面即可。

**Q：构建失败提示 `pod install` 出错？**
工作流里用的是 `pod install --repo-update`，首次会拉取整个 Specs 仓库，慢但正常。
若持续失败，把运行日志的报错段发我。

**Q：IPA 装上去打开白屏？**
工作流里有一步会校验产物中的 `NSAppTransportSecurity`，
如果那步通过，说明 ATS 配置没问题，白屏更可能是**学校服务器 502** 导致的。
先用手机浏览器访问该网址确认。

**Q：能不能顺便出安卓的？**
可以 —— 在同一个仓库另加一个 `android.yml`（用 `ubuntu-latest` 跑 gradle）。
不过安卓你已经能在本机直接出包（`node scripts/build-apk.mjs`），
上云主要是为了「改完代码自动出包」，需要的话告诉我。

---

## 日常改东西后怎么重新出包

改完 `www/`、`capacitor.config.ts` 或 `scripts/prepare-ios.mjs` 后：

```powershell
git add .
git commit -m "说明改了什么"
git push
```

工作流会自动触发（我配了 `paths` 过滤，只在这些文件变动时才跑）。
等几分钟去 Actions 页面下载新的 IPA 即可。
