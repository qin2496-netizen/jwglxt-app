/**
 * 生成 Android + iOS 全套 App 图标。
 *
 * 为什么不直接用站点 favicon：
 *   实测该 favicon 是单个 32x32 的 BMP 位图，放大到 192/1024 会非常模糊。
 *   因此这里改为用 SVG 自绘矢量图标（深蓝底 + 白色学士帽），
 *   任意尺寸都清晰，观感也更像正规 App。
 *
 * 设计：
 *   - 底色：教务系统登录页主色调深蓝 #1E5EB8 → 渐变到 #154C99
 *   - 主体：白色学士帽（毕业帽）轮廓，象征教务/学业
 *
 * 用法：node scripts/make-icons.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const RES = join(ROOT, 'android', 'app', 'src', 'main', 'res');

const BRAND_DARK = '#154C99';
const BRAND = '#1E5EB8';

/** Android mipmap 密度 → 图标边长(px) */
const DENSITIES = {
  mdpi: 48,
  hdpi: 72,
  xhdpi: 96,
  xxhdpi: 144,
  xxxhdpi: 192,
};

/**
 * 绘制学士帽路径。
 * @param {number} size 画布边长
 * @param {number} scale 图形占画布的比例（自适应图标前景层要小一些）
 * @param {boolean} withBg 是否绘制背景渐变
 */
function svgIcon(size, scale = 1, withBg = true) {
  const s = size;
  const c = s / 2;
  const u = (s * scale) / 100; // 1 单位 = 画布 1%

  // 学士帽：帽顶菱形 + 帽檐 + 下方流苏，坐标以画布中心为基准
  const bg = withBg
    ? `<defs>
         <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
           <stop offset="0%" stop-color="${BRAND}"/>
           <stop offset="100%" stop-color="${BRAND_DARK}"/>
         </linearGradient>
       </defs>
       <rect width="${s}" height="${s}" fill="url(#g)"/>`
    : '';

  // 所有坐标用 u 缩放，保证不同尺寸下比例一致
  const P = (v) => (c + v * u).toFixed(2);

  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  ${bg}
  <g fill="#ffffff">
    <!-- 帽顶菱形（学士帽主体） -->
    <path d="M ${P(-30)} ${P(-8)}
             L ${P(0)}   ${P(-22)}
             L ${P(30)}  ${P(-8)}
             L ${P(0)}   ${P(6)} Z"/>
    <!-- 帽子下方帽身（梯形） -->
    <path d="M ${P(-15)} ${P(-1)}
             L ${P(0)}   ${P(6)}
             L ${P(15)}  ${P(-1)}
             L ${P(15)}  ${P(12)}
             Q ${P(0)}   ${P(22)} ${P(-15)} ${P(12)} Z"/>
  </g>
  <!-- 流苏 -->
  <g stroke="#FFD24D" stroke-width="${(5 * u).toFixed(2)}" fill="none" stroke-linecap="round">
    <path d="M ${P(26)} ${P(-5)} L ${P(28)} ${P(14)}"/>
  </g>
  <circle cx="${P(28)}" cy="${P(17)}" r="${(5 * u).toFixed(2)}" fill="#FFD24D"/>
</svg>`);
}

/** 圆形图标：在方形基础上挖圆形蒙版 */
async function makeRound(size) {
  const square = await sharp(svgIcon(size)).png().toBuffer();
  const r = size / 2;
  const mask = Buffer.from(
    `<svg width="${size}" height="${size}"><circle cx="${r}" cy="${r}" r="${r}" fill="#fff"/></svg>`
  );
  return sharp(square).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
}

/**
 * 自适应图标前景层：Android 会把前景放在约 66% 的安全区内，
 * 所以图形要缩小(scale=0.62)，四周透明，避免被系统裁掉。
 */
async function makeForeground(size) {
  return sharp(svgIcon(size, 0.62, false)).png().toBuffer();
}

async function main() {
  const written = [];

  for (const [density, size] of Object.entries(DENSITIES)) {
    const dir = join(RES, `mipmap-${density}`);
    mkdirSync(dir, { recursive: true });

    writeFileSync(join(dir, 'ic_launcher.png'), await sharp(svgIcon(size)).png().toBuffer());
    writeFileSync(join(dir, 'ic_launcher_round.png'), await makeRound(size));
    writeFileSync(join(dir, 'ic_launcher_foreground.png'), await makeForeground(size));
    written.push(`mipmap-${density}/ (3 files)`);
  }

  // 自适应图标背景色 = 品牌色（纯色层，渐变由前景层承担不了，用品牌主色即可）
  writeFileSync(
    join(RES, 'values', 'ic_launcher_background.xml'),
    `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#1E5EB8</color>
</resources>
`
  );

  // iOS 1024 图标（App Store / Xcode 用）
  const iosDir = join(ROOT, 'assets', 'ios');
  mkdirSync(iosDir, { recursive: true });
  writeFileSync(join(iosDir, 'AppIcon-1024.png'), await sharp(svgIcon(1024)).png().toBuffer());
  written.push('assets/ios/AppIcon-1024.png');

  // 预览图，方便肉眼检查
  writeFileSync(join(ROOT, 'assets', 'icon-preview.png'), await sharp(svgIcon(512)).png().toBuffer());
  written.push('assets/icon-preview.png');

  console.log('已生成图标：');
  for (const w of written) console.log('  ' + w);
}

main().catch((e) => {
  console.error('生成图标失败：', e);
  process.exit(1);
});
