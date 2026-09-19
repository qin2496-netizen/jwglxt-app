/**
 * 轮询 GitHub Actions 运行状态，直到完成或超时。
 *
 * 用法：node scripts/watch-run.mjs <owner> <repo> [最多等待分钟]
 */
import { request } from 'node:https';

const [, , owner, repo, maxMinutes = '15'] = process.argv;
const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) {
  console.error('需要 GH_TOKEN');
  process.exit(1);
}

function api(path) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: 'api.github.com',
        path,
        headers: {
          'User-Agent': 'watch',
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'application/vnd.github+json',
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null });
          } catch {
            resolve({ status: res.statusCode, body: d });
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const deadline = Date.now() + Number(maxMinutes) * 60 * 1000;
  let lastStatus = '';
  let runId = null;

  while (Date.now() < deadline) {
    const runs = await api(`/repos/${owner}/${repo}/actions/runs?per_page=3`);
    if (runs.status !== 200 || !runs.body?.workflow_runs?.length) {
      console.log('等待工作流出现…');
      await sleep(8000);
      continue;
    }

    const run = runs.body.workflow_runs[0];
    runId = run.id;
    const line = `${run.status} / ${run.conclusion || '-'}`;
    if (line !== lastStatus) {
      console.log(`[${new Date().toLocaleTimeString()}] ${line}`);
      lastStatus = line;
    }

    if (run.status === 'completed') {
      console.log(`\n=== 构建结束：${run.conclusion} ===`);
      console.log(`地址：${run.html_url}`);

      // 列出该次运行的 jobs 与各步骤结果
      const jobs = await api(`/repos/${owner}/${repo}/actions/runs/${runId}/jobs`);
      if (jobs.status === 200) {
        for (const job of jobs.body.jobs) {
          console.log(`\nJob: ${job.name}  →  ${job.conclusion}`);
          for (const s of job.steps || []) {
            const mark = s.conclusion === 'success' ? '✓' : s.conclusion === 'skipped' ? '·' : '✗';
            console.log(`  ${mark} ${s.name}  (${s.conclusion || '未完成'})`);
          }
        }
      }

      // 列出产物
      const arts = await api(`/repos/${owner}/${repo}/actions/runs/${runId}/artifacts`);
      if (arts.status === 200 && arts.body.artifacts.length) {
        console.log('\n=== 产物 ===');
        for (const a of arts.body.artifacts) {
          console.log(`  ${a.name}  ${(a.size_in_bytes / 1024 / 1024).toFixed(1)} MB`);
          console.log(`  下载：${a.archive_download_url}`);
        }
      } else {
        console.log('\n（没有产物）');
      }
      return;
    }

    await sleep(10000);
  }

  console.log('\n超时：构建在限定时间内未结束。');
  if (runId) console.log(`查看进度：https://github.com/${owner}/${repo}/actions/runs/${runId}`);
}

main().catch((e) => {
  console.error('出错：', e.message);
  process.exit(1);
});
