// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Builds synthetic FLIR "FFF" sequences so the tests do not need a real
// camera file (they are large, and a repository is the wrong place for a few
// megabytes of thermal data). The layout mirrors what an A655sc writes: a
// big-endian container header and index, little-endian records.

export const FIXTURE = {
  emissivity: 0.95,
  objectDistance: 2.5,
  reflectedTempK: 293.15,
  atmosphericTempK: 291.15,
  irWindowTempK: 293.15,
  irWindowTransmission: 1,
  relativeHumidity: 0.5, // stored as a fraction, like the real cameras
  planckR1: 14772.65,
  planckR2: 0.0137111,
  planckB: 1393.8,
  planckF: 1,
  planckO: -3735,
  alpha1: 0.006569,
  alpha2: 0.01262,
  beta1: -0.002276,
  beta2: -0.00667,
  x: 1.9,
  model: 'FLIR TEST-CAM',
  partNumber: '55001-0303',
  serial: '12345678',
  software: '16.0.0',
  lens: 'FOL13',
  fieldOfView: 45.0103,
  frameRate: 6,
  seconds: 1697907575,
  millis: 920,
};

/** Sensor count of one pixel: a diagonal ramp plus a hot disc, per frame. */
export function rawAt(x, y, width, height, frame) {
  const rampX = width > 1 ? Math.round((x / (width - 1)) * 1200) : 0;
  const rampY = height > 1 ? Math.round((y / (height - 1)) * 300) : 0;
  const dx = x - Math.round(width * 0.7);
  const dy = y - Math.round(height * 0.35);
  const radius = Math.min(width, height) * 0.12;
  const hot = dx * dx + dy * dy <= radius * radius ? 2500 : 0;
  return 8200 + rampX + rampY + hot + frame * 40;
}

export function buildFixture({width = 8, height = 4, frames = 3, tz = 0} = {}) {
  const infoSize = 0x470;
  const pixelCount = width * height;
  const rawSize = 32 + pixelCount * 2;
  const infoOff = 0x80;
  const rawOff = infoOff + infoSize;
  const frameSize = rawOff + rawSize;
  const buf = Buffer.alloc(frameSize * frames);

  for (let f = 0; f < frames; f++) {
    const b = frameSize * f;
    buf.write('FFF\0', b, 'latin1');
    buf.write('CSPLEORACAM', b + 4, 'latin1');
    buf.writeUInt32BE(100, b + 0x14);
    buf.writeUInt32BE(0x40, b + 0x18); // index offset
    buf.writeUInt32BE(2, b + 0x1c); // index entry count

    // index entry 0: CameraInfo, entry 1: RawData
    buf.writeUInt16BE(32, b + 0x40);
    buf.writeUInt32BE(106, b + 0x44);
    buf.writeUInt32BE(infoOff, b + 0x4c);
    buf.writeUInt32BE(infoSize, b + 0x50);
    buf.writeUInt16BE(1, b + 0x60);
    buf.writeUInt16BE(2, b + 0x62);
    buf.writeUInt32BE(rawOff, b + 0x6c);
    buf.writeUInt32BE(rawSize, b + 0x70);

    const i = b + infoOff;
    buf.writeUInt16LE(2, i);
    buf.writeUInt16LE(width, i + 2);
    buf.writeUInt16LE(height, i + 4);
    buf.writeFloatLE(FIXTURE.emissivity, i + 0x20);
    buf.writeFloatLE(FIXTURE.objectDistance, i + 0x24);
    buf.writeFloatLE(FIXTURE.reflectedTempK, i + 0x28);
    buf.writeFloatLE(FIXTURE.atmosphericTempK, i + 0x2c);
    buf.writeFloatLE(FIXTURE.irWindowTempK, i + 0x30);
    buf.writeFloatLE(FIXTURE.irWindowTransmission, i + 0x34);
    buf.writeFloatLE(FIXTURE.relativeHumidity, i + 0x3c);
    buf.writeFloatLE(FIXTURE.planckR1, i + 0x58);
    buf.writeFloatLE(FIXTURE.planckB, i + 0x5c);
    buf.writeFloatLE(FIXTURE.planckF, i + 0x60);
    buf.writeFloatLE(FIXTURE.alpha1, i + 0x70);
    buf.writeFloatLE(FIXTURE.alpha2, i + 0x74);
    buf.writeFloatLE(FIXTURE.beta1, i + 0x78);
    buf.writeFloatLE(FIXTURE.beta2, i + 0x7c);
    buf.writeFloatLE(FIXTURE.x, i + 0x80);
    buf.writeFloatLE(423.15, i + 0x90);
    buf.writeFloatLE(233.15, i + 0x94);
    buf.write(FIXTURE.model, i + 0xd4, 'latin1');
    buf.write(FIXTURE.partNumber, i + 0xf4, 'latin1');
    buf.write(FIXTURE.serial, i + 0x104, 'latin1');
    buf.write(FIXTURE.software, i + 0x114, 'latin1');
    buf.write(FIXTURE.lens, i + 0x170, 'latin1');
    buf.writeFloatLE(FIXTURE.fieldOfView, i + 0x1b4);
    buf.writeInt32LE(FIXTURE.planckO, i + 0x308);
    buf.writeFloatLE(FIXTURE.planckR2, i + 0x30c);
    buf.writeUInt32LE(FIXTURE.seconds + f, i + 0x384);
    buf.writeUInt32LE(FIXTURE.millis, i + 0x388);
    buf.writeInt16LE(tz, i + 0x38c);
    buf.writeUInt16LE(FIXTURE.frameRate, i + 0x464);

    const r = b + rawOff;
    buf.writeUInt16LE(2, r);
    buf.writeUInt16LE(width, r + 2);
    buf.writeUInt16LE(height, r + 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        buf.writeUInt16LE(rawAt(x, y, width, height, f), r + 32 + (y * width + x) * 2);
      }
    }
  }
  return buf;
}

export function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
