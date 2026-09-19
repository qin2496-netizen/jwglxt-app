/**
 * 一键打包安卓 APK。
 *
 * 依次完成：cap sync → 修补被 Capacitor 重置的构建配置 → gradlew assembleRelease → 归类产物
 *
 * 为什么要「修补」：Capacitor 8 每次 `cap sync` 都会重新生成
 * android/app/capacitor.build.gradle，里面把 Java 版本写死成 21，
 * 还会把 variables.gradle 的 compileSdk 重置成 36。本机只有 JDK 17，
 * 且只装了 android-35 平台，直接构建必然报错。所以每次同步后都要重新覆盖一次。
 *
 * 用法：
 *   node scripts/build-apk.mjs             # release，签名用 android/keystore.properties
 *   node scripts/build-apk.mjs --debug     # debug 版，不签名，方便快速验证
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const ANDROID = join(ROOT, 'android');
const isDebug = process.argv.includes('--debug');
const variant = isDebug ? 'debug' : 'release';

/** 本机 JDK 17 路径（JAVA_HOME 已设，这里只做兜底提示） */
const JAVA_HOME = process.env.JAVA_HOME || 'C:\\Program Files\\Eclipse Adoptium\\jdk-17.0.20.101-hotspot';

/**
 * Gradle 用户目录与分发包。
 *
 * 两个环境约束逼出来的方案：
 *
 * 1. 沙箱只允许写工作区。Gradle 默认用 C:\Users\<用户>\.gradle，
 *    连锁文件都建不了，报 "gradle-8.14.3-all.zip.lck 拒绝访问"。
 *    → 把 GRADLE_USER_HOME 指到工作区内。
 *
 * 2. 工作区路径含中文（D:\JA\pdf工具\），而 Gradle 的 file:// 分发包
 *    URL 解析中文会出错。
 *    → 额外准备一个**纯 ASCII 子目录** jwglxt-build-tools 存放 zip 与 gradle home。
 *
 * 3. 本机网络对大文件下载极不稳定（Invoke-WebRequest/curl 都在中途断），
 *    所以 gradle-8.13-bin.zip 是离线下载好并固化在这里的，wrapper 走 file:// 读取。
 */
const BUILD_TOOLS = join(ROOT, '..', 'jwglxt-build-tools');
const GRADLE_USER_HOME = process.env.GRADLE_USER_HOME || join(BUILD_TOOLS, 'gradle-home');
const GRADLE_ZIP = join(BUILD_TOOLS, 'gradle-8.13-bin.zip');

/** 确保 Gradle 分发包就位（从旧位置搬到 ASCII 目录） */
function ensureGradleZip() {
  mkdirSync(BUILD_TOOLS, { recursive: true });
  if (existsSync(GRADLE_ZIP)) return;
  const legacy = join(ROOT, '..', '.gradle-home', 'gradle-8.13-bin.zip');
  if (existsSync(legacy)) {
    console.log(`搬运 Gradle 分发包 → ${GRADLE_ZIP}`);
    copyFileSync(legacy, GRADLE_ZIP);
  } else {
    console.log('⚠ 未找到 gradle-8.13-bin.zip，wrapper 将尝试联网下载（可能很慢）');
  }
  mkdirSync(GRADLE_USER_HOME, { recursive: true });
}

/**
 * 写入 local.properties（Android SDK 位置）。
 *
 * 这个文件本来应由 Android Studio 生成，命令行构建没有就得自己写。
 * 路径必须按 properties 格式转义（冒号与反斜杠都要转），
 * ��则含中文的工程路径会被解析错。
 */
function ensureLocalProperties() {
  const target = join(ANDROID, 'local.properties');
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || 'C:\\Users\\L\\AppData\\Local\\Android\\Sdk';

  if (existsSync(target)) {
    const cur = readFileSync(target, 'utf8');
    if (cur.includes('sdk.dir')) return; // 已配好，不动用户的设置
  }

  const escaped = sdk.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
  writeFileSync(
    target,
    `## 由 build-apk.mjs 自动生成：指向本机 Android SDK\nsdk.dir=${escaped}\n`
  );
  console.log(`  已写入 local.properties（sdk.dir=${sdk}）`);
}

function run(cmd, args, opts = {}) {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  return execFileSync(cmd, args, {
    cwd: opts.cwd || ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...opts.env },
    shell: process.platform === 'win32',
  });
}

/**
 * 修补 Capacitor 生成的文件。
 * 每次 cap sync 后都会重置，所以必须放在 sync 之后、构建之前执行。
 */
function patchGeneratedConfigs() {
  console.log('\n=== 修补 Capacitor 生成的构建配置 ===');

  // 1) capacitor.build.gradle 里写死 Java 21 → 改回 17
  const capBuild = join(ANDROID, 'app', 'capacitor.build.gradle');
  if (existsSync(capBuild)) {
    let s = readFileSync(capBuild, 'utf8');
    const before = s;
    s = s.replace(/JavaVersion\.VERSION_21/g, 'JavaVersion.VERSION_17');
    if (s !== before) {
      writeFileSync(capBuild, s);
      console.log('  已把 capacitor.build.gradle 的 Java 21 改回 17');
    }
  }

  // 2) variables.gradle 被重置成 compileSdk 36 → 改回本机可用的 35
  const vars = join(ANDROID, 'variables.gradle');
  if (existsSync(vars)) {
    let s = readFileSync(vars, 'utf8');
    const before = s;
    s = s.replace(/compileSdkVersion\s*=\s*36/g, 'compileSdkVersion = 35');
    s = s.replace(/targetSdkVersion\s*=\s*36/g, 'targetSdkVersion = 35');
    if (s !== before) {
      writeFileSync(vars, s);
      console.log('  已把 variables.gradle 的 compileSdk/targetSdk 改回 35');
    }
  }

  // 2b) 根 build.gradle：给所有子模块统一 Java 17 + build-tools 36.0.0
  //
  // 这一条是最关键的。Capacitor 的 :capacitor-android / :capacitor-app 等
  // library 模块各自带一份 build.gradle，硬编码 Java 21 且不指定 buildToolsVersion。
  // 只改 app 模块管不到它们，会在 :capacitor-app:compileReleaseJavaWithJavac 处失败。
  // 所以必须在根 build.gradle 的 subprojects 层面统一覆盖。
  const rootBuild = join(ANDROID, 'build.gradle');
  if (existsSync(rootBuild)) {
    let s = readFileSync(rootBuild, 'utf8');
    if (!s.includes('统一各子模块')) {
      s = s.replace(
        /task clean\(type: Delete\)/,
        `// ===========================================================================
// 统一各子模块的 Java 版本与 Build Tools 版本（由 build-apk.mjs 自动补入）
// ---------------------------------------------------------------------------
// 原因：Capacitor 的各 library 模块自带 build.gradle，硬编码 Java 21 且不指定
// buildToolsVersion。本机只有 JDK 17 与 build-tools 34/36，
// 不统一覆盖会在 :capacitor-app:compileReleaseJavaWithJavac 处失败。
// ===========================================================================
subprojects {
    afterEvaluate { project ->
        if (project.hasProperty('android')) {
            project.android {
                buildToolsVersion = "36.0.0"
                compileOptions {
                    sourceCompatibility JavaVersion.VERSION_17
                    targetCompatibility JavaVersion.VERSION_17
                }
            }
        }
        // 排除 Kotlin 1.6.21 的 jdk7/jdk8 拆分包，避免与 1.8.22 冲突
        project.configurations.all {
            exclude group: 'org.jetbrains.kotlin', module: 'kotlin-stdlib-jdk7'
            exclude group: 'org.jetbrains.kotlin', module: 'kotlin-stdlib-jdk8'
        }
    }
}

task clean(type: Delete)`
      );
      writeFileSync(rootBuild, s);
      console.log('  已在根 build.gradle 补上子模块统一配置（Java 17 + build-tools 36.0.0）');
    }
  }

  // 3) app/build.gradle —— 若被插入 Java 21，改回 17；并确保 buildToolsVersion 指向本机已有版本
  const appBuild = join(ANDROID, 'app', 'build.gradle');
  if (existsSync(appBuild)) {
    let s = readFileSync(appBuild, 'utf8');

    if (s.includes('VERSION_21')) {
      s = s.replace(/VERSION_21/g, 'VERSION_17');
      console.log('  已把 app/build.gradle 的 Java 21 改回 17');
    }

    // 本机装的是 build-tools 34.0.0 与 36.0.0，没有 AGP 默认要用的 35.0.0，
    // 不指定会报 "Failed to find Build Tools revision 35.0.0"。
    if (!s.includes('buildToolsVersion')) {
      s = s.replace(
        /(compileSdk\s*=\s*rootProject\.ext\.compileSdkVersion)/,
        '$1\n    buildToolsVersion = "36.0.0"'
      );
      console.log('  已指定 buildToolsVersion = 36.0.0（本机已有版本）');
    }

    writeFileSync(appBuild, s);
  }

  // 4) android.overridePathCheck —— 工程路径含中文，AGP 默认拒绝
  const gradleProps = join(ANDROID, 'gradle.properties');
  if (existsSync(gradleProps)) {
    let s = readFileSync(gradleProps, 'utf8');
    if (!s.includes('android.overridePathCheck')) {
      s += '\n# 工程路径含中文（D:\\JA\\...），AGP 默认拒绝非 ASCII 路径，这里显式放行\nandroid.overridePathCheck=true\n';
      writeFileSync(gradleProps, s);
      console.log('  已补上 android.overridePathCheck=true');
    }
  }

  // 5) 确认网络配置存在（HTTP 明文放行），被 cap sync 删掉就补回来
  const netCfg = join(ANDROID, 'app', 'src', 'main', 'res', 'xml', 'network_security_config.xml');
  const manifest = join(ANDROID, 'app', 'src', 'main', 'AndroidManifest.xml');
  if (existsSync(manifest)) {
    let m = readFileSync(manifest, 'utf8');
    let changed = false;
    if (!m.includes('networkSecurityConfig')) {
      m = m.replace(
        /android:supportsRtl="true"/,
        'android:supportsRtl="true"\n        android:usesCleartextTraffic="true"\n        android:networkSecurityConfig="@xml/network_security_config"'
      );
      changed = true;
    }
    if (changed) {
      writeFileSync(manifest, m);
      console.log('  已恢复 AndroidManifest 的明文流量配置');
    }
  }
  if (!existsSync(netCfg)) {
    console.log('  ⚠ 警告：network_security_config.xml 缺失，HTTP 站点可能无法加载');
  }

  // 6) kotlin-stdlib 冲突（Duplicate class kotlin.io.path.*）+ androidx.activity 显式依赖
  if (existsSync(appBuild)) {
    let s = readFileSync(appBuild, 'utf8');
    let changed = false;

    // MainActivity 用了 OnBackPressedCallback，它来自 androidx.activity。
    // 虽然是 appcompat 的传递依赖，但显式声明更可靠（避免版本解析出意外结果）。
    if (!s.includes('androidx.activity:activity')) {
      s = s.replace(
        /(implementation project\(':capacitor-cordova-android-plugins'\))/,
        "implementation \"androidx.activity:activity:$androidxActivityVersion\"\n    $1"
      );
      changed = true;
      console.log('  已加入 androidx.activity 显式依赖（返回键回调需要）');
    }

    if (!s.includes('kotlin-stdlib-jdk7')) {
      s += `
// kotlin-stdlib 1.8.22 与被传递依赖带入的 1.6.21 jdk7/jdk8 会冲突，
// 报 "Duplicate class kotlin.io.path.*"，这里排除旧的两个拆分包。
configurations.all {
    exclude group: 'org.jetbrains.kotlin', module: 'kotlin-stdlib-jdk7'
    exclude group: 'org.jetbrains.kotlin', module: 'kotlin-stdlib-jdk8'
    resolutionStrategy {
        force 'org.jetbrains.kotlin:kotlin-stdlib:1.8.22'
    }
}
`;
      changed = true;
      console.log('  已补上 kotlin-stdlib 冲突排除');
    }

    if (changed) writeFileSync(appBuild, s);
  }
}

function main() {
  console.log(`=== 打包教务系统 App（${variant}）===`);

  // ---- 0. 确保 Gradle 分发包就位 ----
  ensureGradleZip();

  // ---- 1. 同步网页资源与原生工程 ----
  run('npx', ['cap', 'sync', 'android']);

  // ---- 2. 修补被重置的配置 ----
  patchGeneratedConfigs();

  // ---- 2b. 确保 SDK 路径配置存在 ----
  ensureLocalProperties();

  // ---- 3. 构建 ----
  const gradlew = join(ANDROID, 'gradlew.bat');
  const task = isDebug ? 'assembleDebug' : 'assembleRelease';
  console.log(`\nGradle 用户目录：${GRADLE_USER_HOME}`);
  run(gradlew, [task, '--no-daemon'], {
    cwd: ANDROID,
    env: { JAVA_HOME, GRADLE_USER_HOME },
  });

  // ---- 4. 归类产物 ----
  const apkName = isDebug ? 'app-debug.apk' : 'app-release.apk';
  const built = join(ANDROID, 'app', 'build', 'outputs', 'apk', variant, apkName);
  if (!existsSync(built)) {
    console.error(`\n✗ 构建结束但找不到产物：${built}`);
    process.exit(1);
  }

  const outDir = join(ROOT, 'dist-apk');
  mkdirSync(outDir, { recursive: true });
  const outName = isDebug ? '教务系统-debug.apk' : '教务系统.apk';
  const outPath = join(outDir, outName);
  copyFileSync(built, outPath);

  const mb = (statSync(outPath).size / 1024 / 1024).toFixed(1);
  console.log(`\n✓ 打包完成`);
  console.log(`  产物：${outPath}`);
  console.log(`  体积：${mb} MB`);
  if (!isDebug) {
    console.log(`\n安装：把上面这个 apk 传到手机点开安装，首次需允许「安装未知来源应用」。`);
  }
}

main();
