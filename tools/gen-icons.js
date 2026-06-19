/*
 * gen-icons.js — 외부 의존성 없이(zlib만) PWA용 PNG 아이콘을 생성한다.
 *   node tools/gen-icons.js
 * icon.svg 의 디자인(둥근 배경 + 3라인 + 양 본진 + DL 모노그램)을 슈퍼샘플링으로
 * 매끄럽게 래스터화해 레포 루트에 PNG로 출력한다.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT = path.join(__dirname, "..");

// ---------- 색 유틸 ----------
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
const BG0 = hex("#16203a"), BG1 = hex("#0b0e14");
const INK = [hex("#4aa3ff"), hex("#b07cff"), hex("#ff5b52")];
const LANE = hex("#222b3a"), BASE_L = hex("#1d4e80"), BASE_R = hex("#7d241f");

function inkAt(x) { // x: 디자인좌표(512) → 좌→우 파랑→보라→빨강
  let t = Math.max(0, Math.min(1, (x - 96) / 320));
  return t < 0.5 ? mix(INK[0], INK[1], t * 2) : mix(INK[1], INK[2], (t - 0.5) * 2);
}
function bgAt(x, y) { return mix(BG0, BG1, Math.max(0, Math.min(1, (x + y) / 1024))); }

// ---------- 디자인(512 좌표계) 도형 판정 ----------
function nearLine(x, y, ly) { return y >= ly - 5 && y <= ly + 5 && x >= 96 && x <= 416; }
function inRect(x, y, rx, ry, rw, rh) { return x >= rx && x <= rx + rw && y >= ry && y <= ry + rh; }
// D: 스템 + 상/하 바 + 우측 반원 고리
function inD(x, y) {
  const bx = 133, by = 181, bh = 150, t = 30, rout = bh / 2, rin = rout - t, px = bx + 120 - rout, cy = by + bh / 2;
  if (inRect(x, y, bx, by, t, bh)) return true;            // 스템
  if (inRect(x, y, bx, by, px - bx, t)) return true;        // 상단 바
  if (inRect(x, y, bx, by + bh - t, px - bx, t)) return true; // 하단 바
  if (x >= px) { const d = Math.hypot(x - px, y - cy); if (d >= rin && d <= rout) return true; } // 고리
  return false;
}
function inL(x, y) {
  const lx = 269, ly = 181, lw = 110, lh = 150, t = 30;
  if (inRect(x, y, lx, ly, t, lh)) return true;             // 스템
  if (inRect(x, y, lx, ly + lh - t, lw, t)) return true;     // 하단 바
  return false;
}
// 둥근 사각형 내부(코너 라운드)
function inRounded(x, y, r) {
  if (x < 0 || x > 512 || y < 0 || y > 512) return false;
  const cx = Math.min(Math.max(x, r), 512 - r), cy = Math.min(Math.max(y, r), 512 - r);
  return Math.hypot(x - cx, y - cy) <= r;
}

// 전경 도형 색(없으면 null=배경). 우선순위: 글자 > 본진 > 라인
function designFg(x, y) {
  if (inD(x, y) || inL(x, y)) return inkAt(x);
  if (inRect(x, y, 78, 150, 40, 212)) return BASE_L;
  if (inRect(x, y, 394, 150, 40, 212)) return BASE_R;
  if (nearLine(x, y, 180) || nearLine(x, y, 256) || nearLine(x, y, 332)) return LANE;
  return null;
}
// 한 디자인좌표 샘플의 색(불투명 RGB) — 전경이 없으면 배경
function designColor(x, y) { return designFg(x, y) || bgAt(x, y); }

// ---------- 렌더링(슈퍼샘플링) ----------
// maskable: 전체를 배경으로 채우고 내용을 안전영역(중앙 ~64%)으로 축소. 일반: 둥근 코너 투명.
function render(size, { maskable = false } = {}) {
  const SS = 4, S = size * SS, r = (96 / 512) * S;
  const buf = Buffer.alloc(size * size * 4);
  const pad = maskable ? 0.18 : 0;             // maskable 안전영역 패딩
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let R = 0, G = 0, B = 0, A = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const X = px * SS + sx + 0.5, Y = py * SS + sy + 0.5; // 출력 픽셀좌표
        let a = 255, col;
        if (maskable) {
          // 배경은 전체를 하나의 연속 그라데이션으로, 전경만 안전영역 안에서
          const innerLo = pad * S, inner = S - 2 * pad * S;
          const dx = (X - innerLo) / inner * 512, dy = (Y - innerLo) / inner * 512;
          col = bgAt(X / S * 512, Y / S * 512);
          if (dx >= 0 && dx <= 512 && dy >= 0 && dy <= 512) { const fg = designFg(dx, dy); if (fg) col = fg; }
        } else {
          if (!inRounded(X / S * 512, Y / S * 512, r / S * 512)) a = 0;
          col = designColor(X / S * 512, Y / S * 512);
        }
        R += col[0] * (a / 255); G += col[1] * (a / 255); B += col[2] * (a / 255); A += a;
      }
      const n = SS * SS, i = (py * size + px) * 4;
      const aAvg = A / n;
      // 프리멀티 해제(투명 가장자리 색 정확도)
      const cov = aAvg > 0 ? (A / 255) : 1;
      buf[i] = Math.round(R / cov); buf[i + 1] = Math.round(G / cov); buf[i + 2] = Math.round(B / cov);
      buf[i + 3] = Math.round(aAvg);
    }
  }
  return buf;
}

// apple-touch용: 투명 없이(검은 배경에 합성된 것처럼) 풀블리드
function renderOpaque(size) {
  const buf = render(size, { maskable: true });
  for (let i = 0; i < buf.length; i += 4) buf[i + 3] = 255;
  return buf;
}

// ---------- PNG 인코딩 ----------
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit, RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}
function write(name, size, mode) {
  const rgba = mode === "maskable" ? render(size, { maskable: true }) : mode === "opaque" ? renderOpaque(size) : render(size);
  fs.writeFileSync(path.join(OUT, name), encodePNG(rgba, size));
  console.log("  ✓", name, `(${size}x${size})`);
}

console.log("PNG 아이콘 생성:");
write("icon-192.png", 192);
write("icon-512.png", 512);
write("icon-maskable-512.png", 512, "maskable");
write("apple-touch-icon-180.png", 180, "opaque");
console.log("완료.");
