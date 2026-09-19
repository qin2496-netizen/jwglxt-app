/**
 * 拉取 GitHub Actions job 日志（处理 302 重定向到对象存储的情况）。
 *
 * 之前的实现失败原因：GitHub 的 /actions/jobs/{id}/logs 会 302 跳到
 * 一个临时签名 URL，且**跳转后不能带 Authorization 头**（带了会 401）。
 * 这里修正为：跟随重定向时去掉认证头。
 *
 * 用法：node scripts/get-logs.mjs <owner> <repo> <runId>
 */
import { request } from 'node:https';

const [, , owner, repo, runId] = process.argv;
const TOKEN = process.env.GH_TOKEN;

/** 简单请求，可选是否带认证 */
function req(urlStr, { auth = true, maxRedirect = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const headers = { 'User-Agent': 'logs' };
    if (auth && TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

    const r = request(
      { hostname: u.hostname, path: u.pathname + u.search, headers },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirect > 0) {
          res.resume();
          const next = new URL(res.headers.location, urlStr).toString();
          // 关键：跳到对象存储后必须去掉认证头，否则 401
          return resolve(req(next, { auth: false, maxRedirect: maxRedirect - 1 }));
        }
        const c = [];
        res.on('data', (x) => c.push(x));
        res.on('end', () =>
          resolve({ status: res.statusCode, text: Buffer.concat(c).toString('utf8') })
        );
      }
    );
    r.on('error', reject);
    r.end();
  });
}

function clean(text) {
  return text
    .split('\n')
    .map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, ''))
    .join('\n');
}

async function main() {
  const jobsRes = await req(`https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/jobs`);
  const jobs = JSON.parse(jobsRes.text).jobs || [];

  for (const job of jobs) {
    const failed = (job.steps || []).filter((s) => s.conclusion === 'failure');
    if (!failed.length) continue;

    console.log(`Job「${job.name}」失败于：${failed.map((s) => s.name).join(', ')}\n`);

    const logRes = await req(`https://api.github.com/repos/${owner}/${repo}/actions/jobs/${job.id}/logs`);
    if (logRes.status !== 200) {
      console.log(`日志获取失败：HTTP ${logRes.status}`);
      console.log(logRes.text.slice(0, 200));
      continue;
    }

    const text = clean(logRes.text);
    const lines = text.split('\n');

    for (const step of failed) {
      // 定位失败步骤的起始行
      const startIdx = lines.findIndex((l) => l.includes(`Run ${step.name}`) || l.includes(step.name));
      if (startIdx === -1) {
        console.log('未能定位步骤，输出日志末尾 150 行：\n');
        console.log(lines.slice(-150).join('\n'));
        continue;
      }

      // 从该处打印到下一个步骤标记或末尾，最多 200 行
      let end = lines.length;
      for (let i = startIdx + 1; i < lines.length; i++) {
        if (/^##\[group\]/.test(lines[i]) || /^Post job cleanup/.test(lines[i])) {
          end = i;
          break;
        }
      }
      const seg = lines.slice(startIdx, Math.min(end, startIdx + 200));

      console.log('='.repeat(72));
      console.log(`失败步骤：${step.name}`);
      console.log('='.repeat(72));
      console.log(seg.join('\n'));
    }
  }
}

main().catch((e) => {
  console.error('出错：', e.message);
  process.exit(1);
});
