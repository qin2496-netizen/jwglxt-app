/**
 * 获取 GitHub Actions 某次运行中失败步骤的日志。
 *
 * 为什么不用 /runs/{id}/logs：
 *   那个接口会 302 跳到一个临时对象存储地址，且返回的是 zip，
 *   处理起来容易出错（实测 400）。
 *   改为先用 /runs/{id}/jobs 拿到 job_id，再请求
 *   /actions/jobs/{job_id}/logs —— 这个直接返回纯文本，最省事。
 *
 * 用法：node scripts/fetch-run-logs.mjs <owner> <repo> <runId>
 */
import { request } from 'node:https';

const [, , owner, repo, runId] = process.argv;
const TOKEN = process.env.GH_TOKEN;

function apiRaw(path) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: 'api.github.com',
        path,
        headers: {
          'User-Agent': 'logs',
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'application/vnd.github+json',
        },
      },
      (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          const u = new URL(res.headers.location);
          return resolve(
            new Promise((rs, rj) => {
              const r2 = request(
                {
                  hostname: u.hostname,
                  path: u.pathname + u.search,
                  headers: { 'User-Agent': 'logs', Authorization: `Bearer ${TOKEN}` },
                },
                (r) => {
                  const c = [];
                  r.on('data', (x) => c.push(x));
                  r.on('end', () => rs({ status: r.statusCode, text: Buffer.concat(c).toString('utf8') }));
                }
              );
              r2.on('error', rj);
              r2.end();
            })
          );
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/** 去掉 GitHub 日志的时间戳前缀，输出更好读 */
function clean(text) {
  return text
    .split('\n')
    .map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, ''))
    .join('\n');
}

async function main() {
  console.log(`=== 运行 ${runId} 的失败详情 ===\n`);

  const jobsRes = await apiRaw(`/repos/${owner}/${repo}/actions/runs/${runId}/jobs`);
  const jobs = JSON.parse(jobsRes.text).jobs || [];

  for (const job of jobs) {
    const failedSteps = (job.steps || []).filter((s) => s.conclusion === 'failure');
    if (!failedSteps.length) continue;

    console.log(`Job「${job.name}」失败步骤：${failedSteps.map((s) => s.name).join(', ')}\n`);

    const logRes = await apiRaw(`/repos/${owner}/${repo}/actions/jobs/${job.id}/logs`);
    if (logRes.status !== 200) {
      console.log(`（日志拉取失败，状态 ${logRes.status}）\n`);
      continue;
    }

    const text = clean(logRes.text);

    // 只输出失败步骤附近的片段，避免刷屏
    for (const step of failedSteps) {
      const idx = text.indexOf(step.name);
      if (idx === -1) {
        console.log(`--- ${step.name}：日志中未定位到该步骤名，输出末尾 120 行 ---`);
        console.log(text.split('\n').slice(-120).join('\n'));
        continue;
      }
      const segment = text.slice(idx);
      const lines = segment.split('\n');
      // 找到该步骤结束（下一个 ##[group] 或步骤标记）
      let end = lines.findIndex((l, i) => i > 3 && /^##\[(endgroup|group)\]/.test(l) === false && /^✓|^✗/.test(l));
      if (end < 0 || end > 200) end = Math.min(lines.length, 200);

      console.log('='.repeat(70));
      console.log(`步骤：${step.name}`);
      console.log('='.repeat(70));
      console.log(lines.slice(0, end).join('\n'));
      console.log('');
    }
  }
}

main().catch((e) => {
  console.error('出错：', e.message);
  process.exit(1);
});
