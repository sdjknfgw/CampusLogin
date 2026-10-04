// 生成托盘与应用图标（纯 Node，零依赖）：圆形底 + 闪电，赛博霓虹配色
// 用法: node gen-icon.js
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- PNG 编码 ----------
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgba) {
  // rgba: Buffer of w*h*4
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- 绘制 ----------
// 超采样抗锯齿：4x4 采样
const SS = 4;
function pointInPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function drawIcon(size, state) {
  const rgba = Buffer.alloc(size * size * 4);
  // 配色（赛博霓虹）
  const colors = {
    offline: { ring: [140, 148, 160], fill: [58, 64, 78] },
    online:  { ring: [160, 255, 210], fill: [0, 210, 128] },
    busy:    { ring: [255, 235, 170], fill: [240, 185, 40] },
    error:   { ring: [255, 170, 190], fill: [235, 60, 90] },
    app:     { ring: [160, 255, 210], fill: [0, 210, 128] }
  };
  const c = colors[state];
  const dark = [22, 24, 32];           // 深色底盘
  const margin = size * 0.04;          // 外边距
  const ringW = size * 0.085;          // 圆环宽度
  const cx = size / 2, cy = size / 2;
  const R = size / 2 - margin;         // 外圆半径
  const Rin = R - ringW;               // 内圆（填充区）半径

  // 闪电多边形（相对中心，比例坐标）
  const flash = [
    [0.12, -0.34], [-0.18, 0.05], [-0.02, 0.05], [-0.12, 0.36],
    [0.18, -0.05], [0.02, -0.05]
  ].map(([x, y]) => [cx + x * size, cy + y * size]);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      // 4x4 超采样
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
          const d = Math.hypot(px - cx, py - cy);
          let col = null;
          if (d <= Rin) {
            // 闪电优先
            col = size >= 24 && pointInPolygon(px, py, flash) ? [255, 255, 255] : c.fill;
          } else if (d <= R) {
            col = c.ring;
          }
          if (col) { r += col[0]; g += col[1]; b += col[2]; a += 255; }
        }
      }
      const n = SS * SS, i = (y * size + x) * 4;
      rgba[i] = Math.round(r / n); rgba[i + 1] = Math.round(g / n);
      rgba[i + 2] = Math.round(b / n); rgba[i + 3] = Math.round(a / n);
    }
  }
  return encodePNG(size, size, rgba);
}

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
const files = [];
for (const st of ['offline', 'online', 'busy', 'error']) {
  for (const sz of [16, 32]) {
    const p = path.join(outDir, `tray-${st}-${sz}.png`);
    fs.writeFileSync(p, drawIcon(sz, st));
    files.push(`${st}-${sz}`);
  }
}
fs.writeFileSync(path.join(outDir, 'icon.png'), drawIcon(256, 'app'));
console.log('generated:', files.join(', '), '+ icon.png(256)');
