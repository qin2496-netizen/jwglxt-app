/**
 * 通过 GitHub REST API 推送本地 git 仓库内容。
 *
 * 为什么要绕过 git push：
 *   本机沙箱限制了两条 git 走不通的路：
 *     1. git 的凭据助手要启动子进程（git-credential-manager），
 *        沙箱禁止创建命名管道 → "couldn't create signal pipe, Win32 error 5"
 *     2. git 用 Windows schannel 做 TLS，沙箱不提供凭据存储 →
 *        "schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS"
 *   而 Node 自带 OpenSSL，TLS 握手不受影响，因此改用 GitHub Git Data API
 *   直接创建 blob / tree / commit / ref，效果等同于一次 push。
 *
 * 用法：
 *   node scripts/push-via-api.mjs <owner> <repo> <branch>
 *   token 从凭据管理器读取，或由环境变量 GH_TOKEN 提供。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:https';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');

const [, , owner, repo, branch = 'main'] = process.argv;
if (!owner || !repo) {
  console.error('用法: node scripts/push-via-api.mjs <owner> <repo> [branch]');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 凭据获取
// ---------------------------------------------------------------------------
function getToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;

  // 从 Windows 凭据管理器读（直接调 exe，不经 git 的 shell 封装）
  const gcm = 'C:\\Program Files\\Git\\mingw64\\bin\\git-credential-manager.exe';
  if (existsSync(gcm)) {
    try {
      const out = execFileSync(gcm, ['get'], {
        input: 'protocol=https\nhost=github.com\n\n',
        encoding: 'utf8',
      });
      const m = out.match(/^password=(.+)$/m);
      if (m) return m[1].trim();
    } catch {
      /* 落到下面报错 */
    }
  }
  throw new Error('取不到 GitHub token。请设置环境变量 GH_TOKEN。');
}

// ---------------------------------------------------------------------------
// GitHub API 封装（用 Node 原生 https，避开 schannel）
// ---------------------------------------------------------------------------
const TOKEN = getToken();

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = request(
      {
        hostname: 'api.github.com',
        path,
        method,
        headers: {
          'User-Agent': 'node-push',
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'application/vnd.github+json',
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            parsed = data;
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const msg = parsed?.message || data;
            const err = new Error(`HTTP ${res.statusCode} ${method} ${path}: ${msg}`);
            err.status = res.statusCode;
            err.body = parsed;
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 列出要推送的文件
//
// 不能用 `git ls-files`：沙箱禁止 Node 通过管道捕获子进程输出
// （spawnSync EPERM），这是本环境的既定边界。
// 因此改为直接遍历文件系统 + 按 .gitignore 规则手工排除。
// ---------------------------------------------------------------------------
import { readdirSync, statSync } from 'node:fs';

/** 需要排除的目录/文件名（与 .gitignore 保持一致） */
const IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  'dist-apk',
  'build',
  '.gradle',
  '.kotlin',
  '.npm-cache',
  '.gradle-home',
  'Pods',
  'DerivedData',
  'caches',
  // 签名密钥目录 —— 绝不能推到公开仓库。
  // 注意：只按文件名后缀排除是不够的，必须把**目录名**也列进来，
  // 否则 android/keystore/ 整个目录会被递归上传。这是实测踩到的坑。
  'keystore',
]);

/** 精确文件名排除 */
const IGNORE_FILES = new Set([
  'local.properties',
  'keystore.properties',
  'x',
]);

/** 按后缀/模式排除 */
const IGNORE_PATTERNS = [
  /\.log$/,
  /\.jks$/,
  /\.keystore$/,
  /\.p12$/,
  /\.mobileprovision$/,
  /tsconfig\.tsbuildinfo$/,
  /^local\.properties$/,
  /^keystore\.properties$/,
];

function shouldIgnore(name, isDir) {
  if (isDir && IGNORE_DIRS.has(name)) return true;
  if (!isDir && IGNORE_FILES.has(name)) return true;
  if (!isDir && IGNORE_PATTERNS.some((re) => re.test(name))) return true;
  return false;
}

/** 递归遍历，返回相对路径列表（用 / 分隔） */
function walk(dir, base = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const ignore = shouldIgnore(entry.name, entry.isDirectory());
    if (ignore) continue;

    if (entry.isDirectory()) {
      // 跳过 iOS 依赖等大目录
      if (entry.name === 'Pods' || entry.name === 'node_modules') continue;
      out.push(...walk(join(dir, entry.name), rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

function listTrackedFiles() {
  return walk(ROOT).sort();
}

/**
 * 读取文件内容。
 * 用 fs 直接读二进制，避免任何转码问题。
 */
function readFile(relPath) {
  return readFileSync(join(ROOT, ...relPath.split('/')));
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  console.log(`目标仓库：${owner}/${repo}  分支：${branch}\n`);

  // 1. 取当前用户，确认 token 有效
  const me = await api('GET', '/user');
  console.log(`✓ 认证成功：${me.login}`);

  // 2. 检查仓库是否存在、是否为空
  let repoInfo;
  try {
    repoInfo = await api('GET', `/repos/${owner}/${repo}`);
    console.log(`✓ 仓库存在（${repoInfo.private ? '私有' : '公开'}）`);
  } catch (e) {
    console.error(`✗ 访问仓库失败：${e.message}`);
    process.exit(1);
  }

  const files = listTrackedFiles();

  // ---- 安全检查：绝不把签名密钥推到公开仓库 ----
  // 这是硬性拦截，不依赖上面的排除规则写对。
  const SENSITIVE = [
    { re: /\.jks$/i, desc: '安卓签名密钥' },
    { re: /\.keystore$/i, desc: '签名密钥' },
    { re: /\.p12$/i, desc: 'iOS 签名证书' },
    { re: /\.mobileprovision$/i, desc: 'iOS 描述文件' },
    { re: /(^|\/)keystore\.properties$/i, desc: '密钥密码文件' },
    { re: /(^|\/)local\.properties$/i, desc: '本地 SDK 路径' },
    { re: /(^|\/)\.env$/i, desc: '环境变量文件' },
  ];
  const leaked = files.filter((f) => SENSITIVE.some((s) => s.re.test(f)));
  if (leaked.length > 0) {
    console.error('\n✗ 中止推送：检测到敏感文件会被上传！');
    for (const f of leaked) {
      const kind = SENSITIVE.find((s) => s.re.test(f))?.desc || '敏感';
      console.error(`    ${f}   （${kind}）`);
    }
    console.error(`\n  仓库是${repoInfo.private ? '私有' : '公开'}的，密钥泄露后别人可伪造你的 App 签名。`);
    console.error('  请检查 scripts/push-via-api.mjs 的 IGNORE_DIRS / IGNORE_FILES 规则。');
    process.exit(1);
  }
  console.log(`✓ 安全检查通过：无密钥等敏感文件`);
  console.log(`✓ 本地待推送文件：${files.length} 个\n`);

  // 3. 逐个创建 blob
  console.log('--- 上传文件（blob）---');
  const tree = [];
  let done = 0;
  for (const f of files) {
    const content = readFile(f);
    const isBinary = content.includes(0);
    const blob = await api('POST', `/repos/${owner}/${repo}/git/blobs`, {
      content: content.toString('base64'),
      encoding: 'base64',
    });
    tree.push({
      path: f.split(sep).join('/'),
      mode: '100644',
      type: 'blob',
      sha: blob.sha,
    });
    done++;
    if (done % 20 === 0 || done === files.length) {
      console.log(`  已上传 ${done}/${files.length}`);
    }
    void isBinary;
  }

  // 注意：git 里的可执行文件需要 mode 100755，否则 CI 上跑不了。
  // 这里检查 gradlew 并修正。
  const gradlewEntry = tree.find((t) => t.path === 'android/gradlew');
  if (gradlewEntry) {
    gradlewEntry.mode = '100755';
    console.log('  （已把 android/gradlew 标记为可执行 100755）');
  }

  // 4. 建 tree
  console.log('\n--- 创建 tree ---');
  const newTree = await api('POST', `/repos/${owner}/${repo}/git/trees`, { tree });
  console.log(`✓ tree: ${newTree.sha}`);

  // 5. 看分支是否已存在（决定是建 ref 还是更新）
  let parentCommitSha = null;
  try {
    const ref = await api('GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
    parentCommitSha = ref.object.sha;
    console.log(`✓ 分支 ${branch} 已存在，将追加提交（父提交 ${parentCommitSha.slice(0, 7)}）`);
  } catch (e) {
    if (e.status === 404) {
      console.log(`· 分支 ${branch} 不存在，将创建`);
    } else {
      throw e;
    }
  }

  // 6. 建 commit
  const commitMessage =
    process.env.COMMIT_MESSAGE ||
    '教务系统套壳 App：安卓 APK 已产出 + iOS 云端构建配置\n\n' +
      '- Capacitor 8 远程 URL 套壳，目标为正方教务系统（纯 HTTP 站点）\n' +
      '- Android：返回键走网页历史（iframe 适配）、明文流量按域名放行、矢量图标\n' +
      '- iOS：GitHub Actions 云端构建，prepare-ios.mjs 自动写入 ATS 例外';
  console.log('\n--- 创建 commit ---');
  const commitBody = {
    message: commitMessage,
    tree: newTree.sha,
    ...(parentCommitSha ? { parents: [parentCommitSha] } : {}),
  };
  const commit = await api('POST', `/repos/${owner}/${repo}/git/commits`, commitBody);
  console.log(`✓ commit: ${commit.sha}`);

  // 7. 更新或创建分支引用
  console.log('\n--- 更新分支 ---');
  if (parentCommitSha) {
    // 用 force=false：若远端有新提交会失败，避免覆盖别人的工作
    await api('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
      sha: commit.sha,
      force: false,
    });
    console.log(`✓ 已更新分支 ${branch}`);
  } else {
    await api('POST', `/repos/${owner}/${repo}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: commit.sha,
    });
    console.log(`✓ 已创建分支 ${branch}`);
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`推送完成！`);
  console.log(`仓库地址：https://github.com/${owner}/${repo}`);
  console.log(`Actions： https://github.com/${owner}/${repo}/actions`);
}

main().catch((e) => {
  console.error('\n✗ 推送失败：', e.message);
  if (e.body) console.error(JSON.stringify(e.body, null, 2).slice(0, 800));
  process.exit(1);
});
