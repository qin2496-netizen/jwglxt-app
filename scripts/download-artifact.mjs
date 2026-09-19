/**
 * 下载 GitHub Actions 的 artifact 到本地。
 *
 * 用法：node scripts/download-artifact.mjs <owner> <repo> <artifactId> <输出路径>
 */
import { request } from 'node:https';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const [, , owner, repo, artifactId, outPath] = process.argv;
const TOKEN = process.env.GH_TOKEN;

/** 跟随重定向下载（跳转到对象存储后必须去掉认证头） */
function download(urlStr, { auth = true, redirects = 6 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const headers = { 'User-Agent': 'dl' };
    if (auth && TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

    const r = request(
      { hostname: u.hostname, path: u.pathname + u.search, headers, method: 'GET' },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
          res.resume();
          const next = new URL(res.headers.location, urlStr).toString();
          return resolve(download(next, { auth: false, redirects: redirects - 1 }));
        }
        if (res.statusCode !== 200) {
          const c = [];
          res.on('data', (x) => c.push(x));
          res.on('end', () =>
            reject(new Error(`HTTP ${res.statusCode}: ${Buffer.concat(c).toString('utf8').slice(0, 200)}`))
          );
          return;
        }
        resolve(res);
      }
    );
    r.on('error', reject);
    r.end();
  });
}

async function main() {
  mkdirSync(dirname(outPath), { recursive: true });
  console.log(`下载 artifact ${artifactId} …`);

  const res = await download(
    `https://api.github.com/repos/${owner}/${repo}/actions/artifacts/${artifactId}/zip`
  );

  const ws = createWriteStream(outPath);
  let bytes = 0;
  res.on('data', (c) => (bytes += c.length));
  res.pipe(ws);

  await new Promise((resolve, reject) => {
    ws.on('finish', resolve);
    ws.on('error', reject);
  });

  console.log(`✓ 已保存：${outPath}`);
  console.log(`  大小：${(bytes / 1024 / 1024).toFixed(2)} MB`);
}

main().catch((e) => {
  console.error('下载失败：', e.message);
  process.exit(1);
});
