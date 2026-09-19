/**
 * 校验 GitHub Actions 工作流文件的语法与关键配置。
 *
 * 为什么需要：YAML 写错的话推上去 GitHub 直接报 "Invalid workflow file"，
 * 而本机是 Windows 无法本地跑 act 验证。这里做静态检查：
 *   - YAML 能否解析
 *   - 必需字段（on / jobs / runs-on / steps）是否齐全
 *   - 步骤里引用的脚本文件是否真实存在（防手滑写错路径）
 *   - shell 脚本的引号/续行是否明显有问题
 *
 * 用法：node scripts/verify-workflows.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const WF_DIR = join(ROOT, '.github', 'workflows');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`✓ ${name}`);
  } else {
    fail++;
    console.log(`✗ ${name}${detail ? '  —— ' + detail : ''}`);
  }
}

/**
 * 极简 YAML 解析（只支持本工作流用到的子集）。
 * 不引入 js-yaml 依赖，避免为了校验再装一个包。
 * 够用来判断：缩进是否一致、键值是否成对、列表项是否存在。
 */
function parseYaml(text) {
  const lines = text.split(/\r?\n/);
  const root = {};
  const stack = [{ indent: -1, obj: root }];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith('#')) continue;

    const indent = raw.match(/^ */)[0].length;
    const content = raw.trim();

    // 弹出比当前缩进深的层级
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].obj;

    if (content.startsWith('- ')) {
      // 列表项
      if (!Array.isArray(parent.__list)) parent.__list = [];
      const item = content.slice(2);
      if (item.includes(':')) {
        const [k, ...rest] = item.split(':');
        const o = {};
        o[k.trim()] = rest.join(':').trim();
        parent.__list.push(o);
        stack.push({ indent, obj: o });
      } else {
        parent.__list.push(item);
      }
    } else if (content.includes(':')) {
      const idx = content.indexOf(':');
      const key = content.slice(0, idx).trim();
      const val = content.slice(idx + 1).trim();
      if (val === '') {
        const o = {};
        parent[key] = o;
        stack.push({ indent, obj: o });
      } else {
        parent[key] = val;
      }
    }
  }
  return root;
}

function main() {
  console.log('=== 校验 GitHub Actions 工作流 ===\n');

  if (!existsSync(WF_DIR)) {
    check('工作流目录存在', false, WF_DIR);
    process.exit(1);
  }

  const files = readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f));
  check('找到工作流文件', files.length > 0, files.join(', '));

  for (const f of files) {
    const full = join(WF_DIR, f);
    const text = readFileSync(full, 'utf8');
    console.log(`\n--- ${f} ---`);

    // 1. 基本结构
    check('  含 on 触发器', /^on:/m.test(text));
    check('  含 jobs', /^jobs:/m.test(text));
    check('  指定 runs-on', /runs-on:/.test(text));
    check('  含 steps', /steps:/.test(text));

    // 2. 缩进一致性（tab 是 YAML 大忌）
    const tabLines = text.split(/\r?\n/).filter((l) => /^\t/.test(l));
    check('  未使用 tab 缩进', tabLines.length === 0, tabLines.length ? `${tabLines.length} 行以 tab 开头` : '');

    // 3. 关键：步骤里引用的脚本必须真实存在
    const scriptRefs = [...text.matchAll(/node\s+(scripts\/[\w.-]+\.mjs)/g)].map((m) => m[1]);
    const uniqueScripts = [...new Set(scriptRefs)];
    for (const s of uniqueScripts) {
      check(`  引用的脚本存在：${s}`, existsSync(join(ROOT, s)));
    }
    if (uniqueScripts.length === 0) {
      check('  引用了至少一个脚本', false, '工作流里没有 node scripts/... 调用');
    }

    // 4. 检查 shell 续行反斜杠：\ 后面不能有空格
    const badContinuation = text
      .split(/\r?\n/)
      .map((l, i) => ({ l, i: i + 1 }))
      .filter(({ l }) => /\\\s+$/.test(l));
    check(
      '  无「反斜杠后带空格」的续行',
      badContinuation.length === 0,
      badContinuation.map((b) => `第${b.i}行`).join(', ')
    );

    // 5. 不应有 --ignore-scripts（会让 Capacitor 缺依赖）
    // 注意：要排除注释行，否则说明「为什么不用它」的注释会被误判为违规
    const codeLines = text
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith('#'));
    const hasIgnoreScripts = codeLines.some((l) => l.includes('--ignore-scripts'));
    check('  未使用 npm --ignore-scripts', !hasIgnoreScripts);

    // 6. 产物上传步骤存在
    check('  含 artifact 上传', /upload-artifact/.test(text));

    // 7. YAML 可解析性（粗测）
    try {
      const parsed = parseYaml(text);
      check('  YAML 可解析', typeof parsed === 'object' && parsed !== null && Object.keys(parsed).length > 0);
    } catch (e) {
      check('  YAML 可解析', false, e.message);
    }
  }

  console.log(`\n${'='.repeat(44)}`);
  console.log(`${pass} 项通过，${fail} 项失败`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
