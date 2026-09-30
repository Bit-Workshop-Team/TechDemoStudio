'use strict';

/**
 * 生成应用图标（纯 Node，无第三方依赖）：
 *   node tools/make-icon.js
 * 输出 build/icon.png（512×512）与 build/icon.ico（256×256，PNG 压缩条目）
 * 图案：深色圆角底板 + 金色棋盘网格 + 五子连珠。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ------------------------------------------------------------------ 画布
function createCanvas(size) {
  return { size, data: new Uint8Array(size * size * 4) };
}

function blend(canvas, x, y, r, g, b, a) {
  if (a <= 0) return;
  if (x < 0 || y < 0 || x >= canvas.size || y >= canvas.size) return;
  const i = (y * canvas.size + x) * 4;
  const d = canvas.data;
  const sa = Math.min(1, a);
  const da = d[i + 3] / 255;
  const outA = sa + da * (1 - sa);
  if (outA <= 0) return;
  d[i] = Math.round((r * sa + d[i] * da * (1 - sa)) / outA);
  d[i + 1] = Math.round((g * sa + d[i + 1] * da * (1 - sa)) / outA);
  d[i + 2] = Math.round((b * sa + d[i + 2] * da * (1 - sa)) / outA);
  d[i + 3] = Math.round(outA * 255);
}

/** 在 (cx,cy) 画一个圆，color 可以是函数(nx,ny) → [r,g,b]（nx,ny 为 -1..1 归一化偏移） */
function disc(canvas, cx, cy, radius, colorFn, alpha) {
  const x0 = Math.max(0, Math.floor(cx - radius - 1));
  const x1 = Math.min(canvas.size - 1, Math.ceil(cx + radius + 1));
  const y0 = Math.max(0, Math.floor(cy - radius - 1));
  const y1 = Math.min(canvas.size - 1, Math.ceil(cy + radius + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const cover = Math.min(1, Math.max(0, radius + 0.5 - dist));
      if (cover <= 0) continue;
      const c = colorFn(dx / radius, dy / radius, dist / radius);
      blend(canvas, x, y, c[0], c[1], c[2], (alpha == null ? 1 : alpha) * cover);
    }
  }
}

function roundRectMask(canvas, x0, y0, w, h, radius, colorFn, alpha) {
  for (let y = Math.floor(y0); y < Math.ceil(y0 + h); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x0 + w); x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let inside;
      const rx = Math.min(Math.max(px, x0 + radius), x0 + w - radius);
      const ry = Math.min(Math.max(py, y0 + radius), y0 + h - radius);
      const d = Math.sqrt((px - rx) * (px - rx) + (py - ry) * (py - ry));
      inside = d <= radius + 0.5 ? Math.min(1, radius + 0.5 - d) : 0;
      if (inside <= 0) continue;
      const c = colorFn((px - x0) / w, (py - y0) / h);
      blend(canvas, x, y, c[0], c[1], c[2], (alpha == null ? 1 : alpha) * Math.min(1, inside));
    }
  }
}

function line(canvas, x1, y1, x2, y2, width, color, alpha) {
  const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1) * 2) + 1;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    disc(canvas, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, width / 2, () => color, alpha);
  }
}

// ------------------------------------------------------------------ 图案
function render(size) {
  const canvas = createCanvas(size);
  const u = size / 512; // 以 512 为设计基准

  // 底板
  roundRectMask(canvas, 12 * u, 12 * u, size - 24 * u, size - 24 * u, 92 * u, (nx, ny) => {
    const t = Math.min(1, (nx * 0.35 + ny * 0.75));
    return [
      Math.round(30 + (10 - 30) * t),
      Math.round(42 + (16 - 42) * t),
      Math.round(56 + (24 - 56) * t)
    ];
  }, 1);

  // 底板内发光
  disc(canvas, size * 0.34, size * 0.24, size * 0.62, (nx, ny, nr) => {
    const k = Math.max(0, 1 - nr);
    return [70 * k + 20, 96 * k + 30, 120 * k + 40];
  }, 0.16);

  // 棋盘网格
  const pad = 104 * u;
  const inner = size - pad * 2;
  const step = inner / 6;
  const gridColor = [216, 174, 98];
  for (let i = 0; i <= 6; i++) {
    const p = pad + step * i;
    line(canvas, pad, p, pad + inner, p, 5 * u, gridColor, 0.34);
    line(canvas, p, pad, p, pad + inner, 5 * u, gridColor, 0.34);
  }
  // 外框
  line(canvas, pad, pad, pad + inner, pad, 9 * u, gridColor, 0.62);
  line(canvas, pad, pad + inner, pad + inner, pad + inner, 9 * u, gridColor, 0.62);
  line(canvas, pad, pad, pad, pad + inner, 9 * u, gridColor, 0.62);
  line(canvas, pad + inner, pad, pad + inner, pad + inner, 9 * u, gridColor, 0.62);

  // 五子连珠（主对角线，深色底上更醒目）
  const stones = [0, 1, 2, 3, 4];
  const stoneR = step * 0.42;
  stones.forEach((i) => {
    const cx = pad + step * i;
    const cy = pad + inner - step * i;
    disc(canvas, cx + stoneR * 0.12, cy + stoneR * 0.20, stoneR * 1.02, () => [0, 0, 0], 0.42);
  });
  stones.forEach((i) => {
    const cx = pad + step * i;
    const cy = pad + inner - step * i;
    const last = i === stones.length - 1;
    disc(canvas, cx, cy, stoneR, (nx, ny, nr) => {
      const k = Math.max(0, 1 - Math.max(0, (nx + ny) * 0.5 + 0.55));
      if (last) {
        return [240 - 40 * k, 205 - 55 * k, 137 - 55 * k];
      }
      const base = 232 - 150 * (1 - k);
      return [base, base + 6, base + 14];
    }, 1);
  });

  return canvas;
}

// ------------------------------------------------------------------ PNG
let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function toPng(canvas) {
  const { size, data } = canvas;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(data.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function toIco(pngBuf, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size;
  entry[1] = size >= 256 ? 0 : size;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(pngBuf.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, pngBuf]);
}

// ------------------------------------------------------------------ 主流程
const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });

const png512 = toPng(render(512));
fs.writeFileSync(path.join(outDir, 'icon.png'), png512);

const png256 = toPng(render(256));
fs.writeFileSync(path.join(outDir, 'icon.ico'), toIco(png256, 256));
fs.writeFileSync(path.join(outDir, 'icon-256.png'), png256);

console.log('icon.png    ' + png512.length + ' bytes (512×512)');
console.log('icon.ico    ' + fs.statSync(path.join(outDir, 'icon.ico')).size + ' bytes (256×256 PNG entry)');
console.log('输出目录    ' + outDir);
