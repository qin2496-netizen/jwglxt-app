/**
 * 初始化一个空的 GitHub 仓库。
 *
 * 为什么需要这一步：
 *   GitHub 的 Git Data API 不允许往**完全空的仓库**写 blob，
 *   会报 409 "Git Repository is empty."。
 *   必须先有一个提交把仓库激活，之后才能正常用 blob/tree/commit 推送。
 *
 * 做法：用 Contents API 创建一个 README.md（这一步会自动产生初始提交）。
 *
 * 用法：node scripts/init-empty-repo.mjs <owner> <repo>
 */
import { request } from 'node:https';

const [, , owner, repo] = process.argv;
if (!owner || !repo) {
  console.error('用法: node scripts/init-empty-repo.mjs <owner> <repo>');
  process.exit(1);
}

const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) {
  console.error('需要环境变量 GH_TOKEN');
  process.exit(1);
}

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = request(
      {
        hostname: 'api.github.com',
        path,
        method,
        headers: {
          'User-Agent': 'node-init',
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
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
          else {
            const err = new Error(`HTTP ${res.statusCode}: ${parsed?.message || data}`);
            err.status = res.statusCode;
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

async function main() {
  // 判断仓库是否已初始化（有分支说明不为空）
  //
  // 注意：不能靠 GET /contents/README.md 判断 ——
  // 空仓库上这个接口也会返回 404，和「文件不存在」无法区分。
  // 正确做法是查 branches。
  let hasBranch = false;
  try {
    await api('GET', `/repos/${owner}/${repo}/branches/main`);
    hasBranch = true;
  } catch (e) {
    if (e.status !== 404) throw e;
  }

  if (hasBranch) {
    console.log('· 仓库已有 main 分支，无需初始化');
    return;
  }

  // 若仓库已有其他默认分支（例如 master），也算已初始化
  try {
    const repoInfo = await api('GET', `/repos/${owner}/${repo}`);
    if (repoInfo.default_branch) {
      try {
        await api('GET', `/repos/${owner}/${repo}/branches/${repoInfo.default_branch}`);
        console.log(`· 仓库已有默认分支 ${repoInfo.default_branch}，无需初始化`);
        return;
      } catch {
        /* 默认分支还没有提交，继续初始化 */
      }
    }
  } catch {
    /* 继续 */
  }

  console.log('仓库为空，创建初始提交以激活…');
  const content = Buffer.from(
    `# 教务系统 App\n\n` +
      `把学校教务系统（正方 jwglxt）包装成手机 App。\n\n` +
      `- 安卓：Capacitor 8 套壳，已产出可用 APK\n` +
      `- iOS：GitHub Actions 云端构建（Windows 无法编译 iOS）\n\n` +
      `详细说明见 README.md，推送完成后本文件会被覆盖。\n`
  ).toString('base64');

  // Contents API 的 PUT 既能创建也能更新
  const res = await api('PUT', `/repos/${owner}/${repo}/contents/README.md`, {
    message: '初始化仓库',
    content,
  });

  console.log(`✓ 已创建初始提交：${res.commit.sha.slice(0, 7)}`);
  console.log('  现在可以正常推送了');
}

main().catch((e) => {
  console.error('✗ 初始化失败：', e.message);
  process.exit(1);
});
