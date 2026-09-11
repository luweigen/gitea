// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// contrib/flir-seq: view FLIR radiometric sequences (.seq / .fff) in Gitea's
// file view and read the temperature of any picked point.
//
// This file is a plain script -- no bundler, no dependency, no network access
// beyond the raw file it is asked to display. It is also loadable from Node
// (module.exports below) so that contrib/flir-seq/test can exercise the
// parser and the radiometry without a browser.

'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) {
    root.GiteaFlirSeq = api;
    if (root.document) api.init(root.document);
  }
})(typeof window === 'undefined' ? null : window, function () {
  // ------------------------------------------------------------------
  // configuration
  // ------------------------------------------------------------------

  const DEFAULTS = {
    // file extensions that get a viewer, lower case, with the dot
    extensions: ['.seq', '.fff'],
    // files larger than this are only loaded after an explicit click, because
    // the whole file is pulled into memory
    maxAutoLoadBytes: 64 * 1024 * 1024,
    // hard stop: never load more than this
    maxLoadBytes: 1024 * 1024 * 1024,
    // 'iron' | 'rainbow' | 'white-hot' | 'black-hot' | 'arctic'
    defaultPalette: 'iron',
    // 'frame' (auto-scale each frame) | 'sequence' | 'manual'
    defaultRangeMode: 'frame',
    // playback speed for multi-frame sequences
    playbackFps: 6,
    // digits after the decimal point in every temperature readout
    decimals: 1,
    // viewer height cap, as a fraction of the viewport height
    maxHeightVh: 0.72,
  };

  function config() {
    const user = (typeof window !== 'undefined' && window.giteaFlirSeqConfig) || {};
    return Object.assign({}, DEFAULTS, user);
  }

  // ------------------------------------------------------------------
  // FFF container parsing
  //
  // A .seq file is a bare concatenation of FLIR "FFF" frames. Every frame
  // starts with a 0x40 byte header holding the offset and the length of a
  // record index; each 32 byte index entry points at a record inside the same
  // frame. Only two record types matter here:
  //
  //   type 1  (RawData)    32 byte header + width*height uint16 sensor counts
  //   type 32 (CameraInfo) the calibration block, see CAMERA_INFO_FIELDS
  //
  // The container header is big-endian on the cameras seen so far while the
  // records themselves are little-endian, so byte order is decided separately
  // for each of them instead of being assumed.
  // ------------------------------------------------------------------

  const REC_RAW_DATA = 1;
  const REC_CAMERA_INFO = 32;
  const FRAME_HEADER_SIZE = 0x40;
  const INDEX_ENTRY_SIZE = 32;
  const RAW_HEADER_SIZE = 32;

  function hasMagic(bytes, off) {
    if (off + 4 > bytes.length) return false;
    // "FFF\0" for camera files, "AFF\0" for the ATS variant
    return (bytes[off] === 0x46 || bytes[off] === 0x41) &&
      bytes[off + 1] === 0x46 && bytes[off + 2] === 0x46 && bytes[off + 3] === 0x00;
  }

  function findMagic(bytes, from) {
    for (let i = from; i + 4 <= bytes.length; i++) {
      if (hasMagic(bytes, i)) return i;
    }
    return -1;
  }

  function readString(dv, off, len) {
    let out = '';
    for (let i = 0; i < len; i++) {
      if (off + i >= dv.byteLength) break;
      const c = dv.getUint8(off + i);
      if (c === 0) break;
      out += String.fromCharCode(c);
    }
    return out.trim();
  }

  // Offsets are relative to the start of the CameraInfo record. They come from
  // ExifTool's FLIR::CameraInfo table, which is the only public description of
  // this block; every offset below was re-checked against real A655sc frames.
  const CAMERA_INFO_FIELDS = {
    emissivity: [0x20, 'f'],
    objectDistance: [0x24, 'f'],
    reflectedTempK: [0x28, 'f'],
    atmosphericTempK: [0x2c, 'f'],
    irWindowTempK: [0x30, 'f'],
    irWindowTransmission: [0x34, 'f'],
    relativeHumidity: [0x3c, 'f'],
    planckR1: [0x58, 'f'],
    planckB: [0x5c, 'f'],
    planckF: [0x60, 'f'],
    atmTransAlpha1: [0x70, 'f'],
    atmTransAlpha2: [0x74, 'f'],
    atmTransBeta1: [0x78, 'f'],
    atmTransBeta2: [0x7c, 'f'],
    atmTransX: [0x80, 'f'],
    cameraTempRangeMaxK: [0x90, 'f'],
    cameraTempRangeMinK: [0x94, 'f'],
    cameraModel: [0xd4, 's', 32],
    cameraPartNumber: [0xf4, 's', 16],
    cameraSerialNumber: [0x104, 's', 16],
    cameraSoftware: [0x114, 's', 16],
    lensModel: [0x170, 's', 32],
    lensPartNumber: [0x190, 's', 16],
    lensSerialNumber: [0x1a0, 's', 16],
    fieldOfView: [0x1b4, 'f'],
    filterModel: [0x1ec, 's', 16],
    planckO: [0x308, 'i'],
    planckR2: [0x30c, 'f'],
    rawValueMedian: [0x338, 'i'],
    rawValueRange: [0x33c, 'i'],
    dateTimeSeconds: [0x384, 'u'],
    dateTimeSubSec: [0x388, 'u'],
    dateTimeTZ: [0x38c, 'h'],
    focusStepCount: [0x390, 'w'],
    focusDistance: [0x45c, 'f'],
    frameRate: [0x464, 'w'],
  };

  function parseCameraInfo(dv, base, size) {
    // The record opens with the same 32 byte image header as RawData, whose
    // first uint16 is 2. That is what tells us the byte order of the block.
    let le = true;
    if (base + 2 <= dv.byteLength && dv.getUint16(base, true) !== 2 && dv.getUint16(base, false) === 2) le = false;

    const info = {byteOrderLE: le};
    for (const name of Object.keys(CAMERA_INFO_FIELDS)) {
      const spec = CAMERA_INFO_FIELDS[name];
      const off = base + spec[0];
      const need = spec[1] === 's' ? spec[2] : (spec[1] === 'w' || spec[1] === 'h' ? 2 : 4);
      if (spec[0] + need > size || off + need > dv.byteLength) continue;
      switch (spec[1]) {
        case 'f': info[name] = dv.getFloat32(off, le); break;
        case 'i': info[name] = dv.getInt32(off, le); break;
        case 'u': info[name] = dv.getUint32(off, le); break;
        case 'h': info[name] = dv.getInt16(off, le); break;
        case 'w': info[name] = dv.getUint16(off, le); break;
        case 's': info[name] = readString(dv, off, spec[2]); break;
      }
    }

    // The camera stores a fraction on some models and whole percent on others.
    if (typeof info.relativeHumidity === 'number' && info.relativeHumidity <= 1.5) {
      info.relativeHumidity *= 100;
    }
    if (typeof info.dateTimeSeconds === 'number' && info.dateTimeSeconds > 0) {
      // The sub-second count lives in the low 16 bits. The time zone is stored
      // in minutes and, following ExifTool, the timestamp is shifted by it
      // while the offset is reported with the opposite sign.
      const ms = (info.dateTimeSubSec || 0) & 0xffff;
      const tz = info.dateTimeTZ || 0;
      info.dateTime = new Date((info.dateTimeSeconds - tz * 60) * 1000 + ms);
      info.dateTimeOffsetMinutes = -tz;
    }
    return info;
  }

  function parseFrameHeader(dv, bytes, base) {
    // Try big-endian first: that is what every FFF file seen so far uses, and
    // a wrong guess is caught by the plausibility check below.
    for (const le of [false, true]) {
      const indexOff = dv.getUint32(base + 0x18, le);
      const indexCount = dv.getUint32(base + 0x1c, le);
      if (indexOff < FRAME_HEADER_SIZE || indexCount === 0 || indexCount > 4096) continue;
      const indexEnd = base + indexOff + indexCount * INDEX_ENTRY_SIZE;
      if (indexEnd > bytes.length) continue;

      const records = [];
      let frameEnd = indexOff + indexCount * INDEX_ENTRY_SIZE;
      let sane = true;
      for (let i = 0; i < indexCount; i++) {
        const p = base + indexOff + i * INDEX_ENTRY_SIZE;
        const rec = {
          type: dv.getUint16(p, le),
          subtype: dv.getUint16(p + 2, le),
          version: dv.getUint32(p + 4, le),
          id: dv.getUint32(p + 8, le),
          offset: dv.getUint32(p + 12, le),
          length: dv.getUint32(p + 16, le),
        };
        if (rec.type === 0 && rec.length === 0) continue; // unused slot
        if (rec.offset < FRAME_HEADER_SIZE || base + rec.offset + rec.length > bytes.length) {
          sane = false;
          break;
        }
        records.push(rec);
        frameEnd = Math.max(frameEnd, rec.offset + rec.length);
      }
      if (!sane || !records.length) continue;
      return {headerLE: le, format: readString(dv, base + 4, 16), records, frameEnd};
    }
    return null;
  }

  function parseRawHeader(dv, base, length) {
    if (length < RAW_HEADER_SIZE) return null;
    for (const le of [true, false]) {
      if (dv.getUint16(base, le) !== 2) continue;
      const width = dv.getUint16(base + 2, le);
      const height = dv.getUint16(base + 4, le);
      if (width > 0 && height > 0 && RAW_HEADER_SIZE + width * height * 2 <= length) {
        return {le, width, height, pixelOffset: base + RAW_HEADER_SIZE};
      }
    }
    return null;
  }

  /**
   * Parse a .seq / .fff buffer into a list of frames. Pixel data is *not*
   * decoded here: a frame only remembers where its samples are, so a multi
   * gigabyte sequence costs no more than the buffer itself.
   */
  function parseSeq(buffer) {
    const bytes = new Uint8Array(buffer);
    const dv = new DataView(buffer);
    const frames = [];
    const warnings = [];
    let off = 0;

    while (off + FRAME_HEADER_SIZE <= bytes.length) {
      if (!hasMagic(bytes, off)) {
        // Some recorders pad frames; resynchronise on the next magic instead
        // of giving up on the rest of the file.
        const next = findMagic(bytes, off + 1);
        if (next < 0) break;
        if (frames.length) warnings.push('在偏移 ' + off + ' 处重新同步到下一帧');
        off = next;
        continue;
      }

      const head = parseFrameHeader(dv, bytes, off);
      if (!head) {
        warnings.push('偏移 ' + off + ' 处的帧头无法解析，已停止');
        break;
      }

      const rawRec = head.records.find((r) => r.type === REC_RAW_DATA);
      const infoRec = head.records.find((r) => r.type === REC_CAMERA_INFO);
      const frame = {
        index: frames.length,
        offset: off,
        format: head.format,
        records: head.records,
        info: infoRec ? parseCameraInfo(dv, off + infoRec.offset, infoRec.length) : null,
        raw: null,
        error: null,
      };

      if (!rawRec) {
        frame.error = '该帧没有 RawData 记录';
      } else {
        const raw = parseRawHeader(dv, off + rawRec.offset, rawRec.length);
        if (!raw) {
          const magic = dv.getUint32(off + rawRec.offset + RAW_HEADER_SIZE, false);
          frame.error = magic === 0x89504e47
            ? '该帧的原始数据是 PNG 压缩格式，暂不支持'
            : '该帧的 RawData 记录不是未压缩的 16 位数据';
        } else {
          frame.raw = raw;
        }
      }

      frames.push(frame);

      const next = off + head.frameEnd;
      if (next <= off) break;
      off = next;
    }

    return {frames, warnings};
  }

  /** Decode one frame's sensor counts into a Uint16Array of width*height. */
  function readFramePixels(buffer, frame) {
    if (!frame.raw) return null;
    const {le, width, height, pixelOffset} = frame.raw;
    const count = width * height;
    const platformLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
    if (le === platformLE && pixelOffset % 2 === 0) {
      return new Uint16Array(buffer, pixelOffset, count);
    }
    const dv = new DataView(buffer);
    const out = new Uint16Array(count);
    for (let i = 0; i < count; i++) out[i] = dv.getUint16(pixelOffset + i * 2, le);
    return out;
  }

  // ------------------------------------------------------------------
  // radiometry
  //
  // The FLIR object-signal model, as published by FLIR and reproduced in
  // Thermimage's raw2temp(): strip the reflected, atmospheric and window
  // contributions off the measured signal, then invert Planck's law.
  // ------------------------------------------------------------------

  const K0 = 273.15;

  /** Calibration + object parameters of a frame, as editable numbers (deg C). */
  function paramsFromInfo(info) {
    const i = info || {};
    return {
      emissivity: num(i.emissivity, 0.95),
      objectDistance: num(i.objectDistance, 1),
      reflectedTemp: num(i.reflectedTempK, 293.15) - K0,
      atmosphericTemp: num(i.atmosphericTempK, 293.15) - K0,
      irWindowTemp: num(i.irWindowTempK, 293.15) - K0,
      irWindowTransmission: num(i.irWindowTransmission, 1),
      relativeHumidity: num(i.relativeHumidity, 50),
      planckR1: num(i.planckR1, 0),
      planckR2: num(i.planckR2, 0),
      planckB: num(i.planckB, 1400),
      planckF: num(i.planckF, 1),
      planckO: num(i.planckO, 0),
      atmTransAlpha1: num(i.atmTransAlpha1, 0.006569),
      atmTransAlpha2: num(i.atmTransAlpha2, 0.01262),
      atmTransBeta1: num(i.atmTransBeta1, -0.002276),
      atmTransBeta2: num(i.atmTransBeta2, -0.00667),
      atmTransX: num(i.atmTransX, 1.9),
    };
  }

  function num(v, fallback) {
    return typeof v === 'number' && isFinite(v) ? v : fallback;
  }

  /** Signal of a black body at t degrees Celsius, in sensor counts. */
  function planckRaw(p, t) {
    return p.planckR1 / (p.planckR2 * (Math.exp(p.planckB / (t + K0)) - p.planckF)) - p.planckO;
  }

  function atmosphericTransmission(p) {
    const rh = p.relativeHumidity / 100;
    const at = p.atmosphericTemp;
    // water vapour pressure, FLIR's polynomial fit
    const h2o = rh * Math.exp(1.5587 + 0.06939 * at - 0.00027816 * at * at + 0.00000068455 * at * at * at);
    const d = Math.sqrt(Math.max(p.objectDistance, 0) / 2);
    const root = Math.sqrt(Math.max(h2o, 0));
    return p.atmTransX * Math.exp(-d * (p.atmTransAlpha1 + p.atmTransBeta1 * root)) +
      (1 - p.atmTransX) * Math.exp(-d * (p.atmTransAlpha2 + p.atmTransBeta2 * root));
  }

  /**
   * Build the raw-count -> degrees Celsius conversion for one parameter set.
   * Returns {ok, reason, toTemp(raw), toRaw(tempC), lut}. The lookup table
   * covers the whole uint16 domain so per-pixel conversion is a single index.
   */
  function makeConverter(p) {
    const invalid = (reason) => ({
      ok: false, reason,
      toTemp: () => NaN,
      toRaw: () => NaN,
      lut: null,
    });

    if (!(p.planckR1 > 0) || !(p.planckR2 > 0) || !(p.planckB > 0)) {
      return invalid('该文件缺少 Planck 标定常数（R1/R2/B），无法换算温度');
    }
    const e = p.emissivity;
    const irt = p.irWindowTransmission;
    if (!(e > 0) || !(irt > 0)) return invalid('发射率与红外窗口透过率必须大于 0');

    const tau = atmosphericTransmission(p);
    if (!(tau > 0)) return invalid('大气透过率计算结果无效，请检查距离/湿度/大气温度');

    const emissWindow = 1 - irt;
    const rawRefl = planckRaw(p, p.reflectedTemp);
    const rawAtm = planckRaw(p, p.atmosphericTemp);
    const rawWind = planckRaw(p, p.irWindowTemp);

    // attenuation terms, all constant for a given parameter set
    const attnRefl = (1 - e) / e * rawRefl;
    const attnAtm1 = (1 - tau) / e / tau * rawAtm;
    const attnAtm2 = (1 - tau) / e / tau / irt / tau * rawAtm;
    const attnWind = emissWindow / e / irt / tau * rawWind;
    const gain = 1 / e / tau / irt / tau;
    const offset = -(attnAtm1 + attnAtm2 + attnWind + attnRefl);

    const toTemp = (raw) => {
      const objectSignal = raw * gain + offset;
      const v = p.planckR1 / (p.planckR2 * (objectSignal + p.planckO)) + p.planckF;
      if (!(v > 0)) return NaN;
      const t = p.planckB / Math.log(v) - K0;
      return isFinite(t) ? t : NaN;
    };

    // inverse, used to turn a manual temperature range back into raw counts
    const toRaw = (t) => (planckRaw(p, t) - offset) / gain;

    const lut = new Float32Array(65536);
    for (let raw = 0; raw < 65536; raw++) lut[raw] = toTemp(raw);

    return {ok: true, reason: '', toTemp, toRaw, lut, tau};
  }

  // ------------------------------------------------------------------
  // palettes
  // ------------------------------------------------------------------

  const PALETTE_STOPS = {
    'iron': [[0, 0, 0, 0], [0.13, 26, 0, 79], [0.28, 89, 0, 130], [0.42, 155, 15, 120],
      [0.55, 208, 47, 74], [0.68, 238, 105, 19], [0.82, 252, 176, 0], [0.93, 255, 230, 92], [1, 255, 255, 255]],
    'rainbow': [[0, 0, 0, 60], [0.15, 0, 0, 200], [0.3, 0, 180, 220], [0.45, 0, 190, 80],
      [0.6, 200, 220, 0], [0.75, 255, 140, 0], [0.9, 230, 20, 20], [1, 255, 255, 255]],
    'white-hot': [[0, 0, 0, 0], [1, 255, 255, 255]],
    'black-hot': [[0, 255, 255, 255], [1, 0, 0, 0]],
    'arctic': [[0, 0, 0, 40], [0.25, 0, 70, 160], [0.5, 90, 175, 215], [0.7, 225, 225, 225],
      [0.85, 255, 190, 60], [1, 255, 90, 0]],
  };

  const PALETTE_LABELS = {
    'iron': '铁红 Iron',
    'rainbow': '彩虹 Rainbow',
    'white-hot': '白热 White hot',
    'black-hot': '黑热 Black hot',
    'arctic': '极地 Arctic',
  };

  function buildPalette(name) {
    const stops = PALETTE_STOPS[name] || PALETTE_STOPS.iron;
    const out = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let a = stops[0], b = stops[stops.length - 1];
      for (let s = 0; s < stops.length - 1; s++) {
        if (t >= stops[s][0] && t <= stops[s + 1][0]) {
          a = stops[s];
          b = stops[s + 1];
          break;
        }
      }
      const span = b[0] - a[0];
      const k = span > 0 ? (t - a[0]) / span : 0;
      out[i * 3] = Math.round(a[1] + (b[1] - a[1]) * k);
      out[i * 3 + 1] = Math.round(a[2] + (b[2] - a[2]) * k);
      out[i * 3 + 2] = Math.round(a[3] + (b[3] - a[3]) * k);
    }
    return out;
  }

  // ------------------------------------------------------------------
  // small DOM helpers
  // ------------------------------------------------------------------

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const child of [].concat(children || [])) {
      if (child === null || child === undefined || child === false) continue;
      node.append(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  function option(value, label, selected) {
    return el('option', {value, selected: selected ? true : null, text: label});
  }

  function labelled(text, control) {
    return el('label', {class: 'flir-seq-field'}, [el('span', {text}), control]);
  }

  function formatBytes(n) {
    if (!(n > 0)) return '未知大小';
    const units = ['B', 'KiB', 'MiB', 'GiB'];
    let i = 0, v = n;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return (i === 0 ? v : v.toFixed(1)) + ' ' + units[i];
  }

  function formatDate(d, tzMinutes) {
    if (!d || isNaN(d.getTime())) return '';
    const p = (n, w) => String(n).padStart(w || 2, '0');
    const s = d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' +
      p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) +
      '.' + p(d.getUTCMilliseconds(), 3);
    if (!tzMinutes) return s + ' UTC';
    const sign = tzMinutes < 0 ? '-' : '+';
    const abs = Math.abs(tzMinutes);
    return s + ' UTC' + sign + p(Math.floor(abs / 60)) + ':' + p(abs % 60);
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = el('a', {href: url, download: name});
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // ------------------------------------------------------------------
  // the viewer
  // ------------------------------------------------------------------

  function Viewer(mount, rawLink, fileName) {
    this.cfg = config();
    this.mount = mount;
    this.rawLink = rawLink;
    this.fileName = fileName;
    this.frameIndex = 0;
    this.spots = [];
    this.spotSeq = 0;
    this.paletteName = PALETTE_STOPS[this.cfg.defaultPalette] ? this.cfg.defaultPalette : 'iron';
    this.palette = buildPalette(this.paletteName);
    this.rangeMode = this.cfg.defaultRangeMode;
    this.manualLo = null;
    this.manualHi = null;
    this.view = {scale: 1, tx: 0, ty: 0, fit: 1};
    this.hover = null;
    this.playing = false;
    this.sequenceRawRange = null;
    this.showExtremes = true;
    this.pixelCache = {index: -1, pixels: null, stats: null};
  }

  Viewer.prototype.mountUI = function () {
    this.root = el('div', {class: 'flir-seq'});
    this.status = el('div', {class: 'flir-seq-status'});
    this.root.append(this.status);
    this.mount.replaceChildren(this.root);
  };

  Viewer.prototype.setStatus = function (text, kind) {
    this.status.className = 'flir-seq-status' + (kind ? ' flir-seq-status-' + kind : '');
    this.status.textContent = text;
    this.status.hidden = !text;
  };

  Viewer.prototype.load = async function () {
    this.mountUI();
    let size = 0;
    try {
      const head = await fetch(this.rawLink, {method: 'HEAD', credentials: 'same-origin'});
      if (head.ok) size = parseInt(head.headers.get('content-length') || '0', 10) || 0;
    } catch (e) {
      // HEAD is only used for the size guard; a failure here is not fatal
    }

    if (size > this.cfg.maxLoadBytes) {
      this.setStatus('文件过大（' + formatBytes(size) + '），超过 maxLoadBytes 限制，不予加载。', 'error');
      return;
    }
    if (size > this.cfg.maxAutoLoadBytes) {
      await this.confirmLoad(size);
      return;
    }
    await this.fetchAndRender();
  };

  Viewer.prototype.confirmLoad = function (size) {
    return new Promise((resolve) => {
      const button = el('button', {class: 'ui tiny primary button', type: 'button', text: '仍然加载'});
      this.setStatus('这是一个 ' + formatBytes(size) + ' 的热成像序列，需要整体读入内存。');
      this.root.append(el('div', {class: 'flir-seq-confirm'}, [button]));
      button.addEventListener('click', async () => {
        button.parentElement.remove();
        await this.fetchAndRender();
        resolve();
      });
    });
  };

  Viewer.prototype.fetchAndRender = async function () {
    this.setStatus('正在下载 ' + this.fileName + ' …');
    let buffer;
    try {
      const resp = await fetch(this.rawLink, {credentials: 'same-origin'});
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      buffer = await resp.arrayBuffer();
    } catch (e) {
      this.setStatus('下载失败：' + e.message, 'error');
      return;
    }

    this.setStatus('正在解析 FLIR 序列 …');
    let parsed;
    try {
      parsed = parseSeq(buffer);
    } catch (e) {
      this.setStatus('解析失败：' + e.message, 'error');
      return;
    }
    if (!parsed.frames.length) {
      this.setStatus('文件中没有找到 FLIR FFF 帧，可能不是 FLIR 热成像序列。', 'error');
      return;
    }

    this.buffer = buffer;
    this.frames = parsed.frames;
    this.warnings = parsed.warnings;
    this.frameIndex = 0;
    this.params = paramsFromInfo(this.frames[0].info);
    this.originalParams = Object.assign({}, this.params);
    this.converter = makeConverter(this.params);

    this.buildUI();
    this.selectFrame(0, true);
  };

  // ---------------- UI construction ----------------

  Viewer.prototype.buildUI = function () {
    const self = this;
    const multi = this.frames.length > 1;

    this.imgCanvas = document.createElement('canvas');
    this.viewCanvas = el('canvas', {class: 'flir-seq-canvas'});
    this.barCanvas = el('canvas', {class: 'flir-seq-colorbar-canvas', width: 16, height: 256});

    // --- toolbar -------------------------------------------------
    this.paletteSelect = el('select', {class: 'flir-seq-select'},
      Object.keys(PALETTE_STOPS).map((k) => option(k, PALETTE_LABELS[k], k === this.paletteName)));
    this.paletteSelect.addEventListener('change', () => {
      self.paletteName = self.paletteSelect.value;
      self.palette = buildPalette(self.paletteName);
      self.paint();
    });

    this.rangeSelect = el('select', {class: 'flir-seq-select'}, [
      option('frame', '本帧自动', this.rangeMode === 'frame'),
      option('sequence', '全序列自动', this.rangeMode === 'sequence'),
      option('manual', '手动', this.rangeMode === 'manual'),
    ]);
    this.rangeSelect.addEventListener('change', () => {
      self.rangeMode = self.rangeSelect.value;
      if (self.rangeMode === 'manual' && self.manualLo === null) {
        self.manualLo = self.rangeLo;
        self.manualHi = self.rangeHi;
        self.manualLoInput.value = self.manualLo.toFixed(self.cfg.decimals);
        self.manualHiInput.value = self.manualHi.toFixed(self.cfg.decimals);
      }
      self.syncRangeInputs();
      self.paint();
    });

    const onManual = () => {
      const lo = parseFloat(self.manualLoInput.value);
      const hi = parseFloat(self.manualHiInput.value);
      if (isFinite(lo) && isFinite(hi) && hi > lo) {
        self.manualLo = lo;
        self.manualHi = hi;
        self.paint();
      }
    };
    this.manualLoInput = el('input', {class: 'flir-seq-number', type: 'number', step: '0.1'});
    this.manualHiInput = el('input', {class: 'flir-seq-number', type: 'number', step: '0.1'});
    this.manualLoInput.addEventListener('change', onManual);
    this.manualHiInput.addEventListener('change', onManual);
    this.manualFields = el('span', {class: 'flir-seq-manual'}, [
      labelled('下限', this.manualLoInput), labelled('上限', this.manualHiInput),
    ]);

    this.extremesToggle = el('input', {type: 'checkbox', checked: this.showExtremes ? true : null});
    this.extremesToggle.addEventListener('change', () => {
      self.showExtremes = self.extremesToggle.checked;
      self.paintView();
    });

    const zoomOut = el('button', {class: 'flir-seq-btn', type: 'button', title: '缩小', text: '−'});
    const zoomIn = el('button', {class: 'flir-seq-btn', type: 'button', title: '放大', text: '+'});
    const zoomReset = el('button', {class: 'flir-seq-btn', type: 'button', title: '适应窗口', text: '⤢'});
    zoomOut.addEventListener('click', () => self.zoomBy(1 / 1.4));
    zoomIn.addEventListener('click', () => self.zoomBy(1.4));
    zoomReset.addEventListener('click', () => {
      self.fitView();
      self.paintView();
    });

    this.toolbar = el('div', {class: 'flir-seq-toolbar'}, [
      labelled('调色板', this.paletteSelect),
      labelled('温标', this.rangeSelect),
      this.manualFields,
      labelled('最高/最低点', this.extremesToggle),
      el('span', {class: 'flir-seq-spacer'}),
      el('span', {class: 'flir-seq-zoom'}, [zoomOut, zoomIn, zoomReset]),
    ]);

    // --- canvas + colour bar ------------------------------------
    this.canvasWrap = el('div', {class: 'flir-seq-canvas-wrap'}, [this.viewCanvas]);
    this.barHi = el('span', {class: 'flir-seq-colorbar-label'});
    this.barLo = el('span', {class: 'flir-seq-colorbar-label'});
    this.colorbar = el('div', {class: 'flir-seq-colorbar'}, [this.barHi, this.barCanvas, this.barLo]);
    this.stage = el('div', {class: 'flir-seq-stage'}, [this.canvasWrap, this.colorbar]);

    // --- readout -------------------------------------------------
    this.readout = el('div', {class: 'flir-seq-readout'});

    // --- frame controls -----------------------------------------
    this.frameSlider = el('input', {
      class: 'flir-seq-slider', type: 'range', min: 0, max: this.frames.length - 1, value: 0, step: 1,
    });
    this.frameSlider.addEventListener('input', () => {
      self.stop();
      self.selectFrame(parseInt(self.frameSlider.value, 10));
    });
    this.playButton = el('button', {class: 'flir-seq-btn', type: 'button', text: '▶ 播放'});
    this.playButton.addEventListener('click', () => (self.playing ? self.stop() : self.play()));
    const prev = el('button', {class: 'flir-seq-btn', type: 'button', text: '◀'});
    const next = el('button', {class: 'flir-seq-btn', type: 'button', text: '▶'});
    prev.addEventListener('click', () => {
      self.stop();
      self.selectFrame(self.frameIndex - 1);
    });
    next.addEventListener('click', () => {
      self.stop();
      self.selectFrame(self.frameIndex + 1);
    });
    this.frameLabel = el('span', {class: 'flir-seq-frame-label'});
    this.frameBar = el('div', {class: 'flir-seq-frames'}, multi
      ? [prev, this.playButton, next, this.frameSlider, this.frameLabel]
      : [this.frameLabel]);

    // --- panels ---------------------------------------------------
    this.spotBody = el('tbody');
    const clearSpots = el('button', {class: 'flir-seq-btn', type: 'button', text: '清除全部'});
    clearSpots.addEventListener('click', () => {
      self.spots = [];
      self.refreshSpots();
      self.paintView();
    });
    this.spotPanel = el('details', {class: 'flir-seq-panel', open: true}, [
      el('summary', {text: '测温点'}),
      el('div', {class: 'flir-seq-panel-body'}, [
        el('p', {class: 'flir-seq-hint', text: '在图像上单击可添加测温点，拖动可平移，滚轮可缩放。'}),
        el('table', {class: 'flir-seq-table'}, [
          el('thead', null, el('tr', null, [
            el('th', {text: '#'}), el('th', {text: 'X'}), el('th', {text: 'Y'}),
            el('th', {text: '原始值'}), el('th', {text: '温度'}), el('th', {text: ''}),
          ])),
          this.spotBody,
        ]),
        el('div', {class: 'flir-seq-panel-actions'}, [clearSpots]),
      ]),
    ]);

    this.paramPanel = this.buildParamPanel();
    this.metaPanel = el('details', {class: 'flir-seq-panel'}, [
      el('summary', {text: '文件信息'}),
      el('div', {class: 'flir-seq-panel-body'}, [(this.metaBody = el('div', {class: 'flir-seq-meta'}))]),
    ]);

    const exportPng = el('button', {class: 'flir-seq-btn', type: 'button', text: '导出 PNG'});
    const exportCsv = el('button', {class: 'flir-seq-btn', type: 'button', text: '导出温度 CSV'});
    exportPng.addEventListener('click', () => self.exportPng());
    exportCsv.addEventListener('click', () => self.exportCsv());
    this.actions = el('div', {class: 'flir-seq-actions'}, [exportPng, exportCsv]);

    this.root.append(this.toolbar, this.stage, this.readout, this.frameBar,
      el('div', {class: 'flir-seq-panels'}, [this.spotPanel, this.paramPanel, this.metaPanel]), this.actions);

    this.bindCanvas();
    this.updateReadout(null);
    this.syncRangeInputs();
    this.fillMeta();
    this.observeResize();

  };

  Viewer.prototype.buildParamPanel = function () {
    const self = this;
    const fields = [
      ['emissivity', '发射率 ε', 0.01, 0.01, 1],
      ['reflectedTemp', '反射表观温度 (°C)', 0.1],
      ['objectDistance', '目标距离 (m)', 0.1, 0],
      ['relativeHumidity', '相对湿度 (%)', 1, 0, 100],
      ['atmosphericTemp', '大气温度 (°C)', 0.1],
      ['irWindowTemp', '红外窗口温度 (°C)', 0.1],
      ['irWindowTransmission', '窗口透过率', 0.01, 0.01, 1],
    ];
    this.paramInputs = {};
    const controls = fields.map((f) => {
      const input = el('input', {
        class: 'flir-seq-number', type: 'number', step: f[2],
        min: f[3] === undefined ? null : f[3], max: f[4] === undefined ? null : f[4],
      });
      input.addEventListener('change', () => {
        const v = parseFloat(input.value);
        if (!isFinite(v)) {
          input.value = self.params[f[0]];
          return;
        }
        self.params[f[0]] = v;
        self.applyParams();
      });
      this.paramInputs[f[0]] = input;
      return labelled(f[1], input);
    });

    const reset = el('button', {class: 'flir-seq-btn', type: 'button', text: '恢复相机设定'});
    reset.addEventListener('click', () => {
      self.params = Object.assign({}, self.originalParams);
      self.applyParams();
    });

    this.paramNote = el('p', {class: 'flir-seq-hint'});
    return el('details', {class: 'flir-seq-panel'}, [
      el('summary', {text: '测温参数'}),
      el('div', {class: 'flir-seq-panel-body'}, [
        el('div', {class: 'flir-seq-form'}, controls),
        this.paramNote,
        el('div', {class: 'flir-seq-panel-actions'}, [reset]),
      ]),
    ]);
  };

  Viewer.prototype.applyParams = function () {
    // Only the conversion changes here. The cached raw counts and their
    // extremes are properties of the sensor data, so they stay valid.
    this.converter = makeConverter(this.params);
    this.syncParamInputs();
    this.paint();
  };

  Viewer.prototype.syncParamInputs = function () {
    for (const key of Object.keys(this.paramInputs)) {
      const v = this.params[key];
      this.paramInputs[key].value = Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    }
    this.paramNote.textContent = this.converter.ok
      ? 'Planck 常数：R1=' + this.params.planckR1.toFixed(2) + '，R2=' + this.params.planckR2.toPrecision(6) +
        '，B=' + this.params.planckB.toFixed(2) + '，F=' + this.params.planckF + '，O=' + this.params.planckO +
        '（来自文件，不可编辑）'
      : this.converter.reason;
  };

  Viewer.prototype.syncRangeInputs = function () {
    this.manualFields.hidden = this.rangeMode !== 'manual';
  };

  // ---------------- frames ----------------

  Viewer.prototype.selectFrame = function (index, force) {
    const clamped = Math.max(0, Math.min(this.frames.length - 1, index));
    if (clamped === this.frameIndex && !force) return;
    this.frameIndex = clamped;
    this.frameSlider.value = String(clamped);
    this.paint();
  };

  Viewer.prototype.play = function () {
    if (this.frames.length < 2) return;
    this.playing = true;
    this.playButton.textContent = '⏸ 暂停';
    const period = 1000 / Math.max(1, this.cfg.playbackFps);
    this.timer = setInterval(() => {
      this.selectFrame((this.frameIndex + 1) % this.frames.length, true);
    }, period);
  };

  Viewer.prototype.stop = function () {
    this.playing = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.playButton) this.playButton.textContent = '▶ 播放';
  };

  Viewer.prototype.currentFrame = function () {
    return this.frames[this.frameIndex];
  };

  Viewer.prototype.decode = function () {
    const frame = this.currentFrame();
    if (this.pixelCache.index === this.frameIndex && this.pixelCache.pixels && this.pixelCache.stats) {
      return this.pixelCache;
    }
    const pixels = readFramePixels(this.buffer, frame);
    let stats = null;
    if (pixels) {
      let min = 0xffff, max = 0, minAt = 0, maxAt = 0;
      for (let i = 0; i < pixels.length; i++) {
        const v = pixels[i];
        if (v < min) {
          min = v;
          minAt = i;
        }
        if (v > max) {
          max = v;
          maxAt = i;
        }
      }
      stats = {min, max, minAt, maxAt};
    }
    this.pixelCache = {index: this.frameIndex, pixels, stats};
    return this.pixelCache;
  };

  /** Raw counts covering the whole sequence, scanned once and cached. */
  Viewer.prototype.sequenceRange = function () {
    if (this.sequenceRawRange) return this.sequenceRawRange;
    let min = 0xffff, max = 0;
    for (const frame of this.frames) {
      const pixels = readFramePixels(this.buffer, frame);
      if (!pixels) continue;
      for (let i = 0; i < pixels.length; i++) {
        const v = pixels[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    this.sequenceRawRange = max >= min ? {min, max} : {min: 0, max: 65535};
    return this.sequenceRawRange;
  };

  // ---------------- values and painting ----------------

  Viewer.prototype.value = function (raw) {
    return this.converter.ok ? this.converter.lut[raw] : raw;
  };

  Viewer.prototype.formatValue = function (raw) {
    const v = this.value(raw);
    if (!isFinite(v)) return '—';
    return this.converter.ok ? v.toFixed(this.cfg.decimals) + ' °C' : String(v) + ' 计数';
  };

  Viewer.prototype.computeRange = function () {
    const stats = this.decode().stats;
    if (!stats) return {lo: 0, hi: 1};
    let lo, hi;
    if (this.rangeMode === 'manual' && this.manualLo !== null) {
      lo = this.manualLo;
      hi = this.manualHi;
    } else if (this.rangeMode === 'sequence') {
      const r = this.sequenceRange();
      lo = this.value(r.min);
      hi = this.value(r.max);
    } else {
      lo = this.value(stats.min);
      hi = this.value(stats.max);
    }
    if (!isFinite(lo) || !isFinite(hi)) {
      lo = stats.min;
      hi = stats.max;
    }
    if (!(hi > lo)) hi = lo + 0.001;
    return {lo, hi};
  };

  Viewer.prototype.paint = function () {
    const frame = this.currentFrame();
    const cache = this.decode();

    this.frameLabel.textContent = this.frames.length > 1
      ? '第 ' + (this.frameIndex + 1) + ' / ' + this.frames.length + ' 帧' + this.frameTime(frame)
      : '单帧' + this.frameTime(frame);

    if (!cache.pixels) {
      this.setStatus(frame.error || '该帧无法解码', 'error');
      return;
    }
    // clears an error left behind by a broken frame the user has moved off
    this.setStatus(this.warnings.length ? this.warnings.join('；') : '',
      this.warnings.length ? 'warn' : '');

    const range = this.computeRange();
    this.rangeLo = range.lo;
    this.rangeHi = range.hi;

    // raw count -> palette index, rebuilt whenever the range or parameters change
    const idx = new Uint8Array(65536);
    const span = range.hi - range.lo;
    for (let raw = 0; raw < 65536; raw++) {
      const v = this.value(raw);
      if (!isFinite(v)) {
        idx[raw] = 0;
        continue;
      }
      const k = Math.round((v - range.lo) / span * 255);
      idx[raw] = k < 0 ? 0 : (k > 255 ? 255 : k);
    }

    const {width, height} = frame.raw;
    this.imgCanvas.width = width;
    this.imgCanvas.height = height;
    const ctx = this.imgCanvas.getContext('2d');
    const image = ctx.createImageData(width, height);
    const data = image.data;
    const pal = this.palette;
    const pixels = cache.pixels;
    for (let i = 0, o = 0; i < pixels.length; i++, o += 4) {
      const c = idx[pixels[i]] * 3;
      data[o] = pal[c];
      data[o + 1] = pal[c + 1];
      data[o + 2] = pal[c + 2];
      data[o + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);

    this.layout();
    this.paintColorbar();
    this.paintView();
    this.refreshSpots();
  };

  Viewer.prototype.frameTime = function (frame) {
    const info = frame.info;
    if (!info || !info.dateTime) return '';
    return ' · ' + formatDate(info.dateTime, info.dateTimeOffsetMinutes);
  };

  Viewer.prototype.paintColorbar = function () {
    const ctx = this.barCanvas.getContext('2d');
    const image = ctx.createImageData(1, 256);
    for (let y = 0; y < 256; y++) {
      const c = (255 - y) * 3;
      const o = y * 4;
      image.data[o] = this.palette[c];
      image.data[o + 1] = this.palette[c + 1];
      image.data[o + 2] = this.palette[c + 2];
      image.data[o + 3] = 255;
    }
    const tmp = document.createElement('canvas');
    tmp.width = 1;
    tmp.height = 256;
    tmp.getContext('2d').putImageData(image, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, 16, 256);
    ctx.drawImage(tmp, 0, 0, 16, 256);
    const fmt = (v) => (this.converter.ok ? v.toFixed(this.cfg.decimals) + '°C' : String(Math.round(v)));
    this.barHi.textContent = fmt(this.rangeHi);
    this.barLo.textContent = fmt(this.rangeLo);
  };

  Viewer.prototype.layout = function () {
    const frame = this.currentFrame();
    if (!frame.raw) return;
    const w = Math.max(120, this.canvasWrap.clientWidth || 640);
    const aspect = frame.raw.height / frame.raw.width;
    const maxH = (typeof window !== 'undefined' ? window.innerHeight : 900) * this.cfg.maxHeightVh;
    const h = Math.max(160, Math.min(w * aspect, maxH));
    this.canvasWrap.style.height = h + 'px';
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    this.viewW = w;
    this.viewH = h;
    this.dpr = dpr;
    this.viewCanvas.width = Math.round(w * dpr);
    this.viewCanvas.height = Math.round(h * dpr);
    this.viewCanvas.style.width = w + 'px';
    this.viewCanvas.style.height = h + 'px';
    const fit = Math.min(w / frame.raw.width, h / frame.raw.height);
    const refit = !this.view.fit || Math.abs(this.view.scale - this.view.fit) < 1e-6;
    this.view.fit = fit;
    if (refit) this.fitView();
    else this.clampView();
  };

  Viewer.prototype.fitView = function () {
    const frame = this.currentFrame();
    if (!frame.raw) return;
    this.view.scale = this.view.fit;
    this.view.tx = (this.viewW - frame.raw.width * this.view.fit) / 2;
    this.view.ty = (this.viewH - frame.raw.height * this.view.fit) / 2;
  };

  Viewer.prototype.clampView = function () {
    const frame = this.currentFrame();
    if (!frame.raw) return;
    const w = frame.raw.width * this.view.scale;
    const h = frame.raw.height * this.view.scale;
    this.view.tx = w <= this.viewW ? (this.viewW - w) / 2 : Math.min(0, Math.max(this.viewW - w, this.view.tx));
    this.view.ty = h <= this.viewH ? (this.viewH - h) / 2 : Math.min(0, Math.max(this.viewH - h, this.view.ty));
  };

  Viewer.prototype.zoomBy = function (factor, cx, cy) {
    const frame = this.currentFrame();
    if (!frame.raw) return;
    const before = this.view.scale;
    const next = Math.max(this.view.fit, Math.min(this.view.fit * 40, before * factor));
    if (next === before) return;
    const px = cx === undefined ? this.viewW / 2 : cx;
    const py = cy === undefined ? this.viewH / 2 : cy;
    // keep the point under the cursor fixed
    this.view.tx = px - (px - this.view.tx) * (next / before);
    this.view.ty = py - (py - this.view.ty) * (next / before);
    this.view.scale = next;
    this.clampView();
    this.paintView();
  };

  Viewer.prototype.toImage = function (vx, vy) {
    return {
      x: (vx - this.view.tx) / this.view.scale,
      y: (vy - this.view.ty) / this.view.scale,
    };
  };

  Viewer.prototype.toView = function (ix, iy) {
    return {
      x: ix * this.view.scale + this.view.tx,
      y: iy * this.view.scale + this.view.ty,
    };
  };

  Viewer.prototype.rawAt = function (x, y) {
    const frame = this.currentFrame();
    const cache = this.pixelCache;
    if (!frame.raw || !cache.pixels) return null;
    if (x < 0 || y < 0 || x >= frame.raw.width || y >= frame.raw.height) return null;
    return cache.pixels[y * frame.raw.width + x];
  };

  Viewer.prototype.paintView = function () {
    const frame = this.currentFrame();
    if (!frame.raw || !this.viewW) return;
    const ctx = this.viewCanvas.getContext('2d');
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.viewW, this.viewH);
    ctx.imageSmoothingEnabled = this.view.scale < 1;
    ctx.drawImage(this.imgCanvas, this.view.tx, this.view.ty,
      frame.raw.width * this.view.scale, frame.raw.height * this.view.scale);

    if (this.showExtremes && this.pixelCache.stats) {
      const {min, max, minAt, maxAt} = this.pixelCache.stats;
      const w = frame.raw.width;
      this.drawMarker(ctx, (maxAt % w) + 0.5, Math.floor(maxAt / w) + 0.5, '#ff2d2d',
        '最高 ' + this.formatValue(max));
      this.drawMarker(ctx, (minAt % w) + 0.5, Math.floor(minAt / w) + 0.5, '#3da5ff',
        '最低 ' + this.formatValue(min));
    }

    this.spots.forEach((spot, i) => {
      const raw = this.rawAt(spot.x, spot.y);
      this.drawMarker(ctx, spot.x + 0.5, spot.y + 0.5, '#ffffff',
        '#' + (i + 1) + ' ' + (raw === null ? '—' : this.formatValue(raw)));
    });

    if (this.hover) {
      const p = this.toView(this.hover.x + 0.5, this.hover.y + 0.5);
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p.x, Math.max(0, p.y - 12));
      ctx.lineTo(p.x, Math.min(this.viewH, p.y + 12));
      ctx.moveTo(Math.max(0, p.x - 12), p.y);
      ctx.lineTo(Math.min(this.viewW, p.x + 12), p.y);
      ctx.stroke();
      ctx.restore();
    }
  };

  Viewer.prototype.drawMarker = function (ctx, ix, iy, colour, label) {
    const p = this.toView(ix, iy);
    if (p.x < -20 || p.y < -20 || p.x > this.viewW + 20 || p.y > this.viewH + 20) return;
    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = colour;
    ctx.beginPath();
    ctx.moveTo(p.x - 7, p.y);
    ctx.lineTo(p.x + 7, p.y);
    ctx.moveTo(p.x, p.y - 7);
    ctx.lineTo(p.x, p.y + 7);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
    ctx.stroke();
    if (label) {
      ctx.font = '11px system-ui, sans-serif';
      const width = ctx.measureText(label).width + 6;
      let lx = p.x + 10;
      if (lx + width > this.viewW) lx = p.x - 10 - width;
      const ly = Math.max(12, Math.min(this.viewH - 4, p.y - 8));
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillRect(lx, ly - 11, width, 14);
      ctx.fillStyle = colour;
      ctx.fillText(label, lx + 3, ly);
    }
    ctx.restore();
  };

  // ---------------- interaction ----------------

  Viewer.prototype.bindCanvas = function () {
    const self = this;
    const canvas = this.viewCanvas;
    let pointerId = null, dragging = false, moved = 0, lastX = 0, lastY = 0;

    const local = (ev) => {
      const rect = canvas.getBoundingClientRect();
      return {x: ev.clientX - rect.left, y: ev.clientY - rect.top};
    };

    canvas.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      pointerId = ev.pointerId;
      dragging = true;
      moved = 0;
      const p = local(ev);
      lastX = p.x;
      lastY = p.y;
      canvas.setPointerCapture(pointerId);
    });

    canvas.addEventListener('pointermove', (ev) => {
      const p = local(ev);
      if (dragging && ev.pointerId === pointerId) {
        moved += Math.abs(p.x - lastX) + Math.abs(p.y - lastY);
        self.view.tx += p.x - lastX;
        self.view.ty += p.y - lastY;
        lastX = p.x;
        lastY = p.y;
        self.clampView();
        self.paintView();
        return;
      }
      self.updateHover(p.x, p.y);
    });

    const endDrag = (ev) => {
      if (ev.pointerId !== pointerId) return;
      const p = local(ev);
      if (moved < 4) self.addSpotAt(p.x, p.y);
      dragging = false;
      pointerId = null;
      try {
        canvas.releasePointerCapture(ev.pointerId);
      } catch (e) {
        // the capture is already gone, nothing to release
      }
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', (ev) => {
      dragging = false;
      pointerId = null;
      void ev;
    });

    canvas.addEventListener('pointerleave', () => {
      self.hover = null;
      self.updateReadout(null);
      self.paintView();
    });

    canvas.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const p = local(ev);
      self.zoomBy(ev.deltaY < 0 ? 1.2 : 1 / 1.2, p.x, p.y);
      self.updateHover(p.x, p.y);
    }, {passive: false});

    canvas.addEventListener('dblclick', () => {
      self.fitView();
      self.paintView();
    });
  };

  Viewer.prototype.updateHover = function (vx, vy) {
    const img = this.toImage(vx, vy);
    const x = Math.floor(img.x);
    const y = Math.floor(img.y);
    const raw = this.rawAt(x, y);
    this.hover = raw === null ? null : {x, y};
    this.updateReadout(raw === null ? null : {x, y, raw});
    this.paintView();
  };

  Viewer.prototype.addSpotAt = function (vx, vy) {
    const img = this.toImage(vx, vy);
    const x = Math.floor(img.x);
    const y = Math.floor(img.y);
    if (this.rawAt(x, y) === null) return;
    this.spots.push({x, y, id: ++this.spotSeq});
    this.refreshSpots();
    this.paintView();
  };

  Viewer.prototype.updateReadout = function (hit) {
    if (!hit) {
      this.readout.textContent = '把鼠标移到图像上即可读取该点温度。';
      this.readout.classList.remove('flir-seq-readout-live');
      return;
    }
    this.readout.classList.add('flir-seq-readout-live');
    this.readout.textContent = '(' + hit.x + ', ' + hit.y + ')　' + this.formatValue(hit.raw) +
      '　原始值 ' + hit.raw;
  };

  Viewer.prototype.refreshSpots = function () {
    const self = this;
    this.spotBody.replaceChildren();
    if (!this.spots.length) {
      this.spotBody.append(el('tr', null, el('td', {colspan: 6, class: 'flir-seq-empty', text: '还没有测温点'})));
      return;
    }
    this.spots.forEach((spot, i) => {
      const raw = this.rawAt(spot.x, spot.y);
      const remove = el('button', {class: 'flir-seq-btn flir-seq-btn-mini', type: 'button', text: '删除'});
      remove.addEventListener('click', () => {
        self.spots.splice(i, 1);
        self.refreshSpots();
        self.paintView();
      });
      this.spotBody.append(el('tr', null, [
        el('td', {text: '#' + (i + 1)}),
        el('td', {text: String(spot.x)}),
        el('td', {text: String(spot.y)}),
        el('td', {text: raw === null ? '—' : String(raw)}),
        el('td', {class: 'flir-seq-temp', text: raw === null ? '—' : this.formatValue(raw)}),
        el('td', null, remove),
      ]));
    });
  };

  Viewer.prototype.fillMeta = function () {
    const info = this.frames[0].info || {};
    const frame = this.frames[0];
    const rows = [
      ['文件', this.fileName],
      ['帧数', String(this.frames.length)],
      ['分辨率', frame.raw ? frame.raw.width + ' × ' + frame.raw.height : '未知'],
      ['相机', [info.cameraModel, info.cameraPartNumber, info.cameraSerialNumber].filter(Boolean).join(' / ')],
      ['固件', info.cameraSoftware],
      ['镜头', [info.lensModel, info.lensPartNumber].filter(Boolean).join(' / ')],
      ['视场角', isFinite(info.fieldOfView) ? info.fieldOfView.toFixed(2) + '°' : ''],
      ['采集时间', formatDate(info.dateTime, info.dateTimeOffsetMinutes)],
      ['帧率', info.frameRate ? info.frameRate + ' Hz' : ''],
      ['量程', isFinite(info.cameraTempRangeMinK) && isFinite(info.cameraTempRangeMaxK)
        ? (info.cameraTempRangeMinK - K0).toFixed(1) + ' … ' + (info.cameraTempRangeMaxK - K0).toFixed(1) + ' °C' : ''],
      ['容器格式', frame.format],
    ];
    this.metaBody.replaceChildren();
    for (const [k, v] of rows) {
      if (!v) continue;
      this.metaBody.append(el('div', {class: 'flir-seq-meta-row'}, [
        el('span', {class: 'flir-seq-meta-key', text: k}),
        el('span', {class: 'flir-seq-meta-value', text: v}),
      ]));
    }
  };

  Viewer.prototype.observeResize = function () {
    if (typeof ResizeObserver === 'undefined') return;
    let width = 0;
    this.resizeObserver = new ResizeObserver(() => {
      const w = this.canvasWrap.clientWidth;
      if (!w || w === width) return;
      width = w;
      this.layout();
      this.paintView();
    });
    this.resizeObserver.observe(this.canvasWrap);
  };

  // ---------------- export ----------------

  Viewer.prototype.baseName = function () {
    return this.fileName.replace(/\.[^.]+$/, '') + '-frame' + (this.frameIndex + 1);
  };

  Viewer.prototype.exportPng = function () {
    const frame = this.currentFrame();
    if (!frame.raw) return;
    const out = document.createElement('canvas');
    out.width = frame.raw.width;
    out.height = frame.raw.height;
    const ctx = out.getContext('2d');
    ctx.drawImage(this.imgCanvas, 0, 0);

    // markers are drawn through the same helper, at scale 1 and no pan
    const saved = this.view;
    const savedW = this.viewW, savedH = this.viewH;
    this.view = {scale: 1, tx: 0, ty: 0, fit: 1};
    this.viewW = out.width;
    this.viewH = out.height;
    if (this.showExtremes && this.pixelCache.stats) {
      const {min, max, minAt, maxAt} = this.pixelCache.stats;
      const w = frame.raw.width;
      this.drawMarker(ctx, (maxAt % w) + 0.5, Math.floor(maxAt / w) + 0.5, '#ff2d2d', '最高 ' + this.formatValue(max));
      this.drawMarker(ctx, (minAt % w) + 0.5, Math.floor(minAt / w) + 0.5, '#3da5ff', '最低 ' + this.formatValue(min));
    }
    this.spots.forEach((spot, i) => {
      const raw = this.rawAt(spot.x, spot.y);
      this.drawMarker(ctx, spot.x + 0.5, spot.y + 0.5, '#ffffff',
        '#' + (i + 1) + ' ' + (raw === null ? '—' : this.formatValue(raw)));
    });
    this.view = saved;
    this.viewW = savedW;
    this.viewH = savedH;

    out.toBlob((blob) => blob && download(blob, this.baseName() + '.png'), 'image/png');
  };

  Viewer.prototype.exportCsv = function () {
    const frame = this.currentFrame();
    const pixels = this.pixelCache.pixels;
    if (!frame.raw || !pixels) return;
    const {width, height} = frame.raw;
    const lines = new Array(height);
    const decimals = this.cfg.decimals;
    for (let y = 0; y < height; y++) {
      const row = new Array(width);
      for (let x = 0; x < width; x++) {
        const v = this.value(pixels[y * width + x]);
        row[x] = isFinite(v) ? (this.converter.ok ? v.toFixed(decimals) : String(v)) : '';
      }
      lines[y] = row.join(',');
    }
    const header = '# ' + this.fileName + ' frame ' + (this.frameIndex + 1) + '/' + this.frames.length +
      ', unit=' + (this.converter.ok ? 'degC' : 'raw') +
      ', emissivity=' + this.params.emissivity +
      ', reflected=' + this.params.reflectedTemp +
      ', distance=' + this.params.objectDistance +
      ', humidity=' + this.params.relativeHumidity + '\n';
    download(new Blob([header + lines.join('\n') + '\n'], {type: 'text/csv;charset=utf-8'}),
      this.baseName() + '.csv');
  };

  // ------------------------------------------------------------------
  // wiring into Gitea's file view
  // ------------------------------------------------------------------

  function fileNameOf(rawLink) {
    try {
      const path = new URL(rawLink, 'http://localhost').pathname;
      return decodeURIComponent(path.substring(path.lastIndexOf('/') + 1));
    } catch (e) {
      return rawLink.substring(rawLink.lastIndexOf('/') + 1);
    }
  }

  function isSupported(name) {
    const lower = name.toLowerCase();
    return config().extensions.some((ext) => lower.endsWith(ext));
  }

  function attach(elFileView) {
    if (elFileView.hasAttribute('data-flir-seq')) return;
    const rawLink = elFileView.getAttribute('data-raw-file-link');
    if (!rawLink) return;
    const name = fileNameOf(rawLink);
    if (!isSupported(name)) return;
    elFileView.setAttribute('data-flir-seq', '1');

    let mount = elFileView.querySelector('.file-view-render-container');
    if (!mount) {
      const fileView = elFileView.querySelector('.file-view');
      if (!fileView) return;
      mount = el('div', {class: 'file-view-render-container'});
      fileView.append(mount);
    }
    mount.classList.add('flir-seq-mount');
    const viewer = new Viewer(mount, rawLink, name);
    // exposed on purpose: contrib/flir-seq/test drives the viewer through it,
    // and it is the handle to reach for when debugging a page in the console
    mount.giteaFlirSeqViewer = viewer;
    viewer.load();
  }

  function scan(root) {
    const nodes = root.querySelectorAll ? root.querySelectorAll('.non-diff-file-content[data-raw-file-link]') : [];
    for (const node of nodes) attach(node);
    if (root.matches && root.matches('.non-diff-file-content[data-raw-file-link]')) attach(root);
  }

  function init(doc) {
    const start = () => {
      scan(doc);
      // Gitea 1.24+ swaps the file view in place when the file tree is used,
      // so a one-shot scan on load is not enough.
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node.nodeType === 1) scan(node);
          }
        }
      });
      observer.observe(doc.body, {childList: true, subtree: true});
    };
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
    else start();
  }

  return {
    init,
    parseSeq,
    readFramePixels,
    paramsFromInfo,
    makeConverter,
    planckRaw,
    atmosphericTransmission,
    buildPalette,
    DEFAULTS,
  };
});
