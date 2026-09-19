/**
 * 稳健下载大文件。
 *
 * 背景：本机网络对大文件下载不稳定，PowerShell 的 Invoke-WebRequest 与
 * curl(schannel) 都在几十 MB 处中断（报 "接收时发生错误" / SEC_E_NO_CREDENTIALS）。
 * 这里用 Node 的 https 实现分块下载 + 断点续传重试，逐段拉取后拼接。
 *
 * 用法：node scripts/download.mjs <url> <输出路径>
 */
import { createWriteStream, existsSync, statSync, unlinkSync } from 'node:fs';
import { get } from 'node:https';
import { get as httpGet } from 'node:http';

const [, , url, outPath] = process.argv;
if (!url || !outPath) {
  console.error('用法: node scripts/download.mjs <url> <输出路径>');
  process.exit(1);
}

const MAX_RETRIES = 60;
const CHUNK_TIMEOUT_MS = 60000;

function fetchRange(targetUrl, start, end, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('重定向过多'));

    const mod = targetUrl.startsWith('https:') ? get : httpGet;
    const req = mod(
      targetUrl,
      {
        headers: { Range: `bytes=${start}-${end}`, 'User-Agent': 'node-downloader' },
        timeout: CHUNK_TIMEOUT_MS,
      },
      (res) => {
        // 处理重定向
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          const loc = new URL(res.headers.location, targetUrl).toString();
          return resolve(fetchRange(loc, start, end, redirects + 1));
        }

        if (res.statusCode !== 206 && res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }

        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('请求超时'));
    });
    req.on('error', reject);
    req.end();
  });
}

/** 探测文件总大小与是否支持 Range */
function probe(targetUrl, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('重定向过多'));
    const mod = targetUrl.startsWith('https:') ? get : httpGet;
    const req = mod(targetUrl, { method: 'HEAD', timeout: 30000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        const loc = new URL(res.headers.location, targetUrl).toString();
        return resolve(probe(loc, redirects + 1));
      }
      resolve({
        size: Number(res.headers['content-length'] || 0),
        acceptRanges: (res.headers['accept-ranges'] || '').includes('bytes'),
      });
      res.resume();
    });
    req.on('timeout', () => req.destroy(new Error('HEAD 超时')));
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  console.log(`探测: ${url}`);
  const info = await probe(url);
  console.log(`  大小: ${(info.size / 1024 / 1024).toFixed(1)} MB，支持断点: ${info.acceptRanges}`);

  const CHUNK = 4 * 1024 * 1024; // 每段 4MB，失败只重下这一段
  const fd = createWriteStream(outPath);
  let offset = info.size > 0 ? Math.min(statSync0(outPath), info.size) : 0;

  if (offset > 0) console.log(`  从 ${(offset / 1024 / 1024).toFixed(1)} MB 处续传`);
  if (offset === 0 && existsSync(outPath)) unlinkSync(outPath);

  const ws = createWriteStream(outPath, { flags: offset > 0 ? 'r+' : 'w', start: offset });
  void fd;

  let pos = offset;
  while (info.size === 0 || pos < info.size) {
    const end = info.size ? Math.min(pos + CHUNK - 1, info.size - 1) : pos + CHUNK - 1;
    let buf = null;
    let lastErr = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        buf = await fetchRange(url, pos, end);
        if (buf.length === 0) throw new Error('收到空数据');
        break;
      } catch (e) {
        lastErr = e;
        if (attempt % 5 === 0 || attempt === 1) {
          console.log(`  段 ${pos} 第 ${attempt} 次失败（${e.message}），重试…`);
        }
        await new Promise((r) => setTimeout(r, 1200));
      }
    }

    if (!buf) {
      ws.end();
      console.error(`\n✗ 下载失败：段 ${pos} 重试 ${MAX_RETRIES} 次仍失败。最后错误：${lastErr?.message}`);
      process.exit(1);
    }

    await new Promise((resolve) => ws.write(buf, resolve));
    pos += buf.length;

    if (info.size) {
      const pct = ((pos / info.size) * 100).toFixed(1);
      if (Math.floor(pos / CHUNK) % 8 === 0) {
        console.log(`  进度 ${pct}%  (${(pos / 1024 / 1024).toFixed(1)} MB)`);
      }
    }
    if (!info.size && buf.length < CHUNK) break;
  }

  await new Promise((resolve) => ws.end(resolve));
  const finalSize = statSync(outPath).size;
  console.log(`\n✓ 下载完成：${outPath}  ${(finalSize / 1024 / 1024).toFixed(1)} MB`);
  if (info.size && finalSize !== info.size) {
    console.error(`✗ 大小不符：期望 ${info.size}，实际 ${finalSize}`);
    process.exit(1);
  }
}

function statSync0(p) {
  try {
    return existsSync(p) ? statSync(p).size : 0;
  } catch {
    return 0;
  }
}

main().catch((e) => {
  console.error('下载异常：', e);
  process.exit(1);
});
