/**
 * 测试各 Gradle 镜像的可达性与下载速度（只取前 N KB，不整包下载）。
 * 用法: node scripts/test-mirrors.mjs
 */
import { get } from 'node:https';

const urls = [
  'https://mirrors.cloud.tencent.com/gradle/gradle-8.13-bin.zip',
  'https://mirrors.aliyun.com/gradle/gradle-8.13-bin.zip',
  'https://mirrors.huaweicloud.com/gradle/gradle-8.13-bin.zip',
  'https://repo.huaweicloud.com/gradle/gradle-8.13-bin.zip',
  'https://mirrors.nju.edu.cn/gradle/gradle-8.13-bin.zip',
  'https://services.gradle.org/distributions/gradle-8.13-bin.zip',
];

function probe(url, redirects = 0) {
  return new Promise((resolve) => {
    if (redirects > 6) return resolve({ url, status: 'redirect-loop' });
    const started = Date.now();
    const req = get(
      url,
      { headers: { Range: 'bytes=0-262143', 'User-Agent': 'node' }, timeout: 25000 },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          const loc = new URL(res.headers.location, url).toString();
          return resolve(probe(loc, redirects + 1));
        }
        let got = 0;
        res.on('data', (c) => {
          got += c.length;
          if (got >= 262144) res.destroy();
        });
        const done = () =>
          resolve({
            url,
            status: res.statusCode,
            total: Number(res.headers['content-length'] || 0) + 262143,
            bytes: got,
            ms: Date.now() - started,
            kbps: Math.round(got / 1024 / ((Date.now() - started) / 1000)),
          });
        res.on('end', done);
        res.on('close', done);
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ url, status: 'timeout' });
    });
    req.on('error', (e) => resolve({ url, status: 'error', msg: e.message }));
    req.end();
  });
}

for (const u of urls) {
  const r = await probe(u);
  if (r.status === 200 || r.status === 206) {
    console.log(`✓ ${r.status}  ${r.kbps} KB/s  总大小≈${(r.total / 1024 / 1024).toFixed(1)}MB  ${u}`);
  } else {
    console.log(`✗ ${r.status} ${r.msg || ''}  ${u}`);
  }
}
