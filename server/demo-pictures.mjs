// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import { deflateSync } from 'node:zlib';

export function encodePng(width, height, pixels) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  const crc32 = bytes => { let crc = -1; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ -1) >>> 0; };
  const chunk = (name, data) => { const body = Buffer.concat([Buffer.from(name), data]), length = Buffer.alloc(4), crc = Buffer.alloc(4); length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body)); return Buffer.concat([length, body, crc]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// A small raster illustrator: matching viewpoints make before/after pairs useful
// in the file viewer. All geometry, gravel texture and plant foliage come from code.
export function yardPicture(view, after) {
  const width = 960, height = 600, pixels = Buffer.alloc(width * height * 4);
  let seed = 641 + view * 173;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / (2 ** 32); };
  const dot = (x, y, color) => { x = Math.round(x); y = Math.round(y); if (x >= 0 && x < width && y >= 0 && y < height) pixels.set([...color, 255], (y * width + x) * 4); };
  const polygon = (points, color) => {
    for (let y = Math.max(0, Math.ceil(Math.min(...points.map(p => p[1])))); y <= Math.min(height - 1, Math.max(...points.map(p => p[1]))); y++) {
      const hits = [];
      for (let i = 0; i < points.length; i++) {
        const [x1, y1] = points[i], [x2, y2] = points[(i + 1) % points.length];
        if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) hits.push(x1 + (y - y1) * (x2 - x1) / (y2 - y1));
      }
      hits.sort((a, b) => a - b);
      for (let i = 0; i < hits.length; i += 2) for (let x = Math.max(0, Math.ceil(hits[i])); x <= Math.min(width - 1, hits[i + 1]); x++) dot(x, y, color);
    }
  };
  const rect = (x, y, w, h, color) => polygon([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], color);
  const ellipse = (x, y, rx, ry, color) => {
    for (let row = -Math.ceil(ry); row <= ry; row++) {
      const span = rx * Math.sqrt(Math.max(0, 1 - row * row / (ry * ry)));
      for (let col = -Math.floor(span); col <= span; col++) dot(x + col, y + row, color);
    }
  };
  const stroke = (x1, y1, x2, y2, thickness, color) => {
    const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1));
    for (let i = 0; i <= steps; i++) ellipse(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps, thickness, thickness, color);
  };
  for (let y = 0; y < height; y++) rect(0, y, width, 1, [Math.round(155 + y / 12), Math.round(197 + y / 22), Math.round(216 + y / 30)].map(c => Math.min(c, 250)));
  ellipse(790, 75, 35, 35, [255, 237, 188]);
  polygon([[0, 216], [100, 128], [186, 190], [310, 96], [448, 208], [577, 137], [732, 222], [840, 138], [960, 216]], [169, 163, 158]);
  polygon([[0, 215], [192, 179], [315, 214], [528, 169], [710, 212], [960, 187], [960, 263], [0, 263]], [187, 178, 163]);
  rect(0, 218, 960, 149, [207, 182, 150]);
  rect(0, 213, 960, 10, [231, 207, 172]);
  for (let y = 246; y < 365; y += 31) {
    stroke(0, y, 960, y, .7, [186, 161, 133]);
    for (let x = (y % 2) * 48; x < width; x += 96) stroke(x, y - 30, x, y, .6, [186, 161, 133]);
  }
  const house = view === 1 ? 130 : 0;
  polygon([[0, 124], [130 + house, 164], [130 + house, 391], [0, 450]], [231, 210, 180]);
  polygon([[0, 113], [151 + house, 154], [141 + house, 172], [0, 132]], [139, 88, 62]);
  rect(36, 202, 60 + house / 4, 93, [115, 102, 87]);
  rect(42, 208, 48 + house / 4, 80, [115, 151, 157]);
  stroke(65, 208, 65, 288, 2, [225, 213, 192]);
  polygon([[0, 414], [160 + house, 355], [960, 355], [960, 600], [0, 600]], after ? [201, 178, 140] : [181, 152, 114]);
  // Thousands of small, shaded stones create a gravel bed rather than a flat swatch.
  for (let i = 0; i < 7200; i++) {
    const x = random() * width, y = 360 + random() * 240, scale = .5 + (y - 350) / 145;
    const shade = random() * 37;
    if (x < 160 + house && y < 414 - 59 * x / (160 + house)) continue;
    ellipse(x, y, scale * 1.6, scale, after ? [173 + shade, 153 + shade, 121 + shade] : [159 + shade, 129 + shade, 93 + shade]);
  }
  const patio = view === 2 ? 190 : 0;
  polygon([[0, 448], [220 + patio, 370], [378 + patio, 390], [545 + patio, 600], [0, 600]], [221, 204, 177]);
  stroke(220 + patio, 370, 545 + patio, 600, 5, [151, 132, 110]);
  for (let y = 420; y < 600; y += 48) stroke(0, y, 287 + patio + (y - 420) * 1.05, y, 1, [185, 166, 144]);
  for (const x of [45, 165, 280]) stroke(220 + patio, 370, x + patio, 600, 1, [185, 166, 144]);
  const plant = (x, y, size, variety) => {
    ellipse(x + 18, y + 5, size * 1.1, size * .22, [159, 143, 112]);
    if (variety === 0) {
      for (let i = 0; i < 11; i++) {
        const angle = -Math.PI + i * Math.PI / 10;
        polygon([[x - 6, y], [x + Math.cos(angle) * size, y + Math.sin(angle) * size - 12], [x + 8, y - 7]], i % 2 ? [74, 112, 93] : [99, 136, 106]);
      }
    } else {
      stroke(x, y, x, y - size * .75, 3, [113, 98, 65]);
      for (let i = 0; i < 24; i++) {
        const px = x + (random() - .5) * size * 1.4, py = y - random() * size * .65 - size * .3;
        ellipse(px, py, size * .24, size * .22, i % 2 ? [109, 139, 90] : [82, 119, 80]);
        if (variety === 2) ellipse(px + 3, py - 4, 3, 3, [184, 145, 175]);
      }
    }
  };
  plant(820, 373, 63, 1); plant(717, 402, 35, 0);
  if (after) {
    plant(480 + patio / 2, 420, 51, 2); plant(618 + patio / 2, 496, 58, 0);
    plant(831, 544, 72, 2); plant(390 + patio / 2, 373, 32, 0);
    ellipse(912, 378, 20, 7, [147, 123, 91]); rect(897, 346, 30, 30, [176, 104, 68]); plant(912, 349, 26, 0);
  } else {
    stroke(460, 420, 674, 495, 2, [66, 69, 49]); stroke(674, 495, 920, 458, 2, [66, 69, 49]);
    for (const [x, y] of [[481, 473], [602, 388], [812, 513], [905, 427], [690, 568]]) {
      for (let i = -2; i <= 2; i++) stroke(x, y, x + i * 7, y - 16 + Math.abs(i) * 3, 1, [125, 124, 70]);
    }
    ellipse(557, 543, 36, 13, [151, 131, 101]);
  }
  // Restrained paper grain gives the entire illustration a consistent drawn finish.
  for (let i = 0; i < pixels.length; i += 4) { const grain = Math.floor(random() * 7) - 3; for (let c = 0; c < 3; c++) pixels[i + c] = Math.max(0, Math.min(255, pixels[i + c] + grain)); }
  return encodePng(width, height, pixels);
}
