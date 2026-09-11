// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Exercises the parser and the radiometry of gitea-flir-seq.js outside the
// browser. The reference temperature below is a straight transcription of the
// published FLIR object-signal model, written independently of the viewer, so
// that a mistake in the viewer's pre-computed attenuation terms shows up.
//
// Usage:
//   node run.mjs                 -- the synthetic fixture, then every recording
//                                   in ./samples checked against the FLIR
//                                   Thermal Studio figures in truth.mjs
//   node run.mjs a.seq b.seq     -- those recordings instead of the bundled ones

import {basename} from 'node:path';
import {readFileSync} from 'node:fs';
import {loadFlirSeq, referenceTemp, thermimageTemp, samplePaths} from './load.mjs';
import {truthFor, displaysTheSame, CAMERA_SCALE} from './truth.mjs';
import {FIXTURE, buildFixture, toArrayBuffer, rawAt} from './fixture.mjs';

const flir = loadFlirSeq();

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail === undefined ? '' : '  ' + detail));
  if (!ok) failures++;
}
function close(a, b, eps) {
  return Math.abs(a - b) <= (eps ?? 1e-6);
}

// --- synthetic tests ------------------------------------------------------

console.log('synthetic fixture');
const geometry = {width: 8, height: 4, frames: 3};
const fixture = toArrayBuffer(buildFixture(geometry));
const parsed = flir.parseSeq(fixture);
check('three frames found', parsed.frames.length === 3, parsed.frames.length);
check('no warnings', parsed.warnings.length === 0, parsed.warnings.map((w) => w.key).join('; '));

const frame = parsed.frames[0];
check('geometry', frame.raw.width === geometry.width && frame.raw.height === geometry.height,
  frame.raw.width + 'x' + frame.raw.height);
check('camera model', frame.info.cameraModel === FIXTURE.model, frame.info.cameraModel);
check('firmware', frame.info.cameraSoftware === FIXTURE.software, frame.info.cameraSoftware);
check('serial number', frame.info.cameraSerialNumber === FIXTURE.serial, frame.info.cameraSerialNumber);
check('frame rate', frame.info.frameRate === FIXTURE.frameRate, frame.info.frameRate);
check('lens model', frame.info.lensModel === FIXTURE.lens, frame.info.lensModel);
check('humidity scaled to percent', close(frame.info.relativeHumidity, 50, 1e-4), frame.info.relativeHumidity);
check('timestamp', frame.info.dateTime.getTime() === FIXTURE.seconds * 1000 + FIXTURE.millis,
  frame.info.dateTime.toISOString());
check('frame timestamps advance',
  parsed.frames[2].info.dateTime.getTime() - parsed.frames[0].info.dateTime.getTime() === 2000);

const pixels = flir.readFramePixels(fixture, frame);
check('pixel count', pixels.length === geometry.width * geometry.height, pixels.length);
check('pixels match the fixture pattern',
  pixels.every((v, i) => v === rawAt(i % geometry.width, Math.floor(i / geometry.width), geometry.width, geometry.height, 0)));
check('second frame reads its own pixels',
  flir.readFramePixels(fixture, parsed.frames[1])[0] === rawAt(0, 0, geometry.width, geometry.height, 1));

const params = flir.paramsFromInfo(frame.info);
check('reflected temperature in Celsius', close(params.reflectedTemp, 20, 1e-4), params.reflectedTemp);
check('Planck O read as signed', params.planckO === FIXTURE.planckO, params.planckO);

const conv = flir.makeConverter(params);
check('converter usable', conv.ok, conv.reason);
check('the FLIR convention is the default', conv.model === flir.MODEL_FLIR, conv.model);
const probes = [6000, 8000, 9000, 9891, 12000, 20000];
let worst = 0;
for (const raw of probes) {
  worst = Math.max(worst, Math.abs(conv.toTemp(raw) - referenceTemp(raw, params)));
}
check('matches the reference model', worst < 1e-6, 'max deviation ' + worst.toExponential(2) + ' K');

// The Thermimage convention is kept selectable, and has to reproduce the
// implementation it is named after -- transcribed separately in load.mjs.
const thermimage = flir.makeConverter(params, flir.MODEL_THERMIMAGE);
check('the Thermimage convention is selectable', thermimage.ok && thermimage.model === flir.MODEL_THERMIMAGE,
  thermimage.model);
let worstThermimage = 0;
for (const raw of probes) {
  worstThermimage = Math.max(worstThermimage, Math.abs(thermimage.toTemp(raw) - thermimageTemp(raw, params)));
}
check('the Thermimage convention matches Thermimage', worstThermimage < 1e-6,
  'max deviation ' + worstThermimage.toExponential(2) + ' K');
check('the two conventions really differ', Math.abs(thermimage.toTemp(9891) - conv.toTemp(9891)) > 0.01,
  thermimage.toTemp(9891).toFixed(3) + ' vs ' + conv.toTemp(9891).toFixed(3));
check('Thermimage reads colder', thermimage.toTemp(9891) < conv.toTemp(9891));
check('its transmission spans half the distance',
  Math.abs(thermimage.tau - flir.makeConverter(
    Object.assign({}, params, {objectDistance: params.objectDistance / 2})).tau) < 1e-12,
  thermimage.tau.toFixed(6));
check('an unknown model falls back to FLIR',
  flir.makeConverter(params, 'nonsense').model === flir.MODEL_FLIR);
check('a supplied transmission is used by both conventions',
  flir.makeConverter(Object.assign({}, params, {atmTransmission: 0.8})).tau === 0.8 &&
  flir.makeConverter(Object.assign({}, params, {atmTransmission: 0.8}), flir.MODEL_THERMIMAGE).tau === 0.8);
check('lut agrees with toTemp', close(conv.lut[9891], conv.toTemp(9891), 1e-3), conv.lut[9891]);
check('toRaw inverts toTemp', close(conv.toRaw(conv.toTemp(9891)), 9891, 1e-3), conv.toRaw(conv.toTemp(9891)));
check('monotonic in raw', conv.toTemp(9000) < conv.toTemp(9100) && conv.toTemp(9100) < conv.toTemp(9200));

// Emissivity is the parameter users touch most. For an object hotter than its
// 20 C surroundings, attributing more of the signal to reflection (a lower
// emissivity) must raise the reported temperature -- and lower it for an
// object colder than the surroundings.
const warmRaw = Math.round(conv.toRaw(40));
const coldRaw = Math.round(conv.toRaw(0));
const lowE = flir.makeConverter(Object.assign({}, params, {emissivity: 0.5}));
check('lower emissivity raises a reading above ambient', lowE.toTemp(warmRaw) > conv.toTemp(warmRaw),
  lowE.toTemp(warmRaw).toFixed(2) + ' > ' + conv.toTemp(warmRaw).toFixed(2));
check('lower emissivity lowers a reading below ambient', lowE.toTemp(coldRaw) < conv.toTemp(coldRaw),
  lowE.toTemp(coldRaw).toFixed(2) + ' < ' + conv.toTemp(coldRaw).toFixed(2));
check('round trip through toRaw keeps 40 C', close(conv.toTemp(conv.toRaw(40)), 40, 1e-3));

const broken = flir.makeConverter(Object.assign({}, params, {planckR2: 0}));
check('missing calibration is reported, not crashed',
  !broken.ok && broken.reason === 'errNoPlanck' && isNaN(broken.toTemp(9000)), broken.reason);

// a recorded time zone shifts the timestamp and is reported with the opposite
// sign, the way ExifTool renders this field
const zoned = flir.parseSeq(toArrayBuffer(buildFixture({width: 4, height: 2, frames: 1, tz: -180})));
const zonedInfo = zoned.frames[0].info;
check('time zone shifts the timestamp',
  zonedInfo.dateTime.getTime() === (FIXTURE.seconds + 180 * 60) * 1000 + FIXTURE.millis,
  zonedInfo.dateTime.toISOString());
check('time zone offset is reported', zonedInfo.dateTimeOffsetMinutes === 180, zonedInfo.dateTimeOffsetMinutes);

// a damaged frame in the middle must cost that frame, not the rest of the file
const damaged = Buffer.from(buildFixture({width: 4, height: 2, frames: 3}));
const frameStride = damaged.length / 3;
damaged.write('XXXX', frameStride, 'latin1');
const recovered = flir.parseSeq(toArrayBuffer(damaged));
check('parser resynchronises past a damaged frame', recovered.frames.length === 2, recovered.frames.length);
check('resynchronisation is reported',
  recovered.warnings.length === 1 && recovered.warnings[0].key === 'warnResync',
  JSON.stringify(recovered.warnings));
check('the frame after the damage is intact',
  flir.readFramePixels(toArrayBuffer(damaged), recovered.frames[1])[0] === rawAt(0, 0, 4, 2, 2));

const palette = flir.buildPalette('iron');
check('palette has 256 entries', palette.length === 768);
check('palette ends white', palette[765] === 255 && palette[766] === 255 && palette[767] === 255);
check('unknown palette falls back', flir.buildPalette('nope').length === 768);

// a file that is not a FLIR sequence must come back empty instead of throwing
check('garbage input yields no frames', flir.parseSeq(toArrayBuffer(Buffer.alloc(4096, 0x42))).frames.length === 0);

// --- atmospheric transmission ---------------------------------------------

// The SDK is explicit: estAtmosphericTransmission is used as-is when it is not
// zero, and only a zero means "estimate from humidity, distance and air temp".
check('a file without a transmission estimates one', !conv.tauFromFile && conv.tau > 0 && conv.tau < 1,
  conv.tau.toFixed(4));

// The transmission must be the one for the whole object distance, applied once.
// Evaluating it at half the distance and squaring -- Thermimage's convention,
// inherited by flirpy -- is a different number and reads too cold; ../doc/format.md.
const halfDistance = flir.makeConverter(Object.assign({}, params, {objectDistance: params.objectDistance / 2}));
check('the transmission spans the whole distance, not half of it',
  Math.abs(conv.tau - halfDistance.tau * halfDistance.tau) > 1e-6 &&
  conv.tau < halfDistance.tau,
  'tau(d)=' + conv.tau.toFixed(6) + '  tau(d/2)^2=' + (halfDistance.tau * halfDistance.tau).toFixed(6));
check('estAtmTransmission is read', frame.info.estAtmTransmission === 0, frame.info.estAtmTransmission);

const supplied = flir.parseSeq(toArrayBuffer(buildFixture({width: 4, height: 2, frames: 1, estAtmTransmission: 0.75})));
const suppliedParams = flir.paramsFromInfo(supplied.frames[0].info);
const suppliedConv = flir.makeConverter(suppliedParams);
check('a transmission in the file is taken as-is',
  suppliedConv.tauFromFile && suppliedConv.tau === 0.75, suppliedConv.tau);
check('the supplied transmission changes the temperature',
  Math.abs(suppliedConv.toTemp(11000) - conv.toTemp(11000)) > 0.01,
  suppliedConv.toTemp(11000).toFixed(2) + ' vs ' + conv.toTemp(11000).toFixed(2));
check('the supplied transmission matches the reference model',
  Math.abs(suppliedConv.toTemp(11000) - referenceTemp(11000, suppliedParams)) < 1e-6);
check('humidity no longer moves the transmission once the file supplies one',
  flir.makeConverter(Object.assign({}, suppliedParams, {relativeHumidity: 95})).tau === 0.75);
check('humidity still moves an estimated transmission',
  flir.makeConverter(Object.assign({}, params, {relativeHumidity: 95})).tau !== conv.tau);

// a value outside (0, 1] cannot be a transmission, so it must not be believed
for (const bogus of [-0.5, 1.5, 0]) {
  const odd = flir.makeConverter(Object.assign({}, params, {atmTransmission: bogus}));
  check('transmission ' + bogus + ' falls back to the estimate',
    !odd.tauFromFile && Math.abs(odd.tau - conv.tau) < 1e-12, odd.tau);
}

// --- pixel value type -----------------------------------------------------

check('a counts file raises no pixel-value warning',
  !parsed.warnings.some((w) => w.key === 'warnPixelType'));
// The scale Thermal Studio opens on comes from the file, not from the pixels.
check('the recorded display scale is read',
  frame.info.rawValueMedian === FIXTURE.rawValueMedian && frame.info.rawValueRange === FIXTURE.rawValueRange,
  frame.info.rawValueMedian + ' +/- ' + frame.info.rawValueRange / 2);
const camera = flir.cameraScale(frame.info, conv);
check('it becomes a scale', camera !== null && camera.hi > camera.lo,
  camera && camera.lo.toFixed(2) + ' .. ' + camera.hi.toFixed(2));
check('it is centred on the median',
  Math.abs((camera.lo + camera.hi) / 2 - conv.toTemp(frame.info.rawValueMedian)) < 0.2);
check('its ends are the median plus and minus half the range',
  Math.abs(camera.lo - conv.toTemp(FIXTURE.rawValueMedian - FIXTURE.rawValueRange / 2)) < 1e-9 &&
  Math.abs(camera.hi - conv.toTemp(FIXTURE.rawValueMedian + FIXTURE.rawValueRange / 2)) < 1e-9);
check('a file without a recorded scale has none',
  flir.cameraScale(flir.parseSeq(toArrayBuffer(
    buildFixture({width: 4, height: 2, frames: 1, rawValueRange: 0}))).frames[0].info, conv) === null);
check('a scale needs a usable converter too',
  flir.cameraScale(frame.info, flir.makeConverter(Object.assign({}, params, {planckR2: 0}))) === null ||
  flir.cameraScale(frame.info, null) !== null);

check('pixel value type and unit are read',
  frame.info.pixelValueType === 1 && frame.info.pixelValueUnit === 0,
  frame.info.pixelValueType + '/' + frame.info.pixelValueUnit);

const oddPixels = flir.parseSeq(toArrayBuffer(
  buildFixture({width: 4, height: 2, frames: 2, pixelValueType: 2, pixelValueUnit: 3})));
const pixelWarnings = oddPixels.warnings.filter((w) => w.key === 'warnPixelType');
check('an unverified pixel value type is flagged once', pixelWarnings.length === 1,
  JSON.stringify(oddPixels.warnings));
check('the flag carries the type and the unit',
  pixelWarnings.length === 1 && pixelWarnings[0].args.join('/') === '2/3',
  pixelWarnings.length ? pixelWarnings[0].args.join('/') : '');
check('the frames still decode', flir.readFramePixels(toArrayBuffer(
  buildFixture({width: 4, height: 2, frames: 2, pixelValueType: 2})), oddPixels.frames[0]).length === 8);

// --- translations ---------------------------------------------------------

console.log('\ntranslations');
const languages = Object.keys(flir.LANGUAGES);
check('three languages are shipped', languages.length === 3, languages.join(', '));

const englishKeys = Object.keys(flir.LANGUAGES[flir.FALLBACK_LANG]).sort();
const placeholders = (text) => (text.match(/\{\d+\}/g) || []).sort().join('');
for (const lang of languages) {
  const keys = Object.keys(flir.LANGUAGES[lang]).sort();
  check(lang + ' defines exactly the English key set', keys.join() === englishKeys.join(),
    keys.length === englishKeys.length
      ? ''
      : 'missing: ' + englishKeys.filter((k) => !keys.includes(k)).join(' ') +
        ' extra: ' + keys.filter((k) => !englishKeys.includes(k)).join(' '));
  const mismatched = englishKeys.filter((k) =>
    placeholders(flir.LANGUAGES[lang][k]) !== placeholders(flir.LANGUAGES[flir.FALLBACK_LANG][k]));
  check(lang + ' keeps every placeholder', mismatched.length === 0, mismatched.join(' '));
  const empty = englishKeys.filter((k) => !String(flir.LANGUAGES[lang][k]).trim());
  check(lang + ' has no empty string', empty.length === 0, empty.join(' '));
}

// every user-visible key must be reachable: the keys the parser and the
// converter emit are the ones most easily forgotten
for (const key of ['warnResync', 'warnFrameHeader', 'errNoRawRecord', 'errRawPng',
  'errRawUnsupported', 'errNoPlanck', 'errBadEmissivity', 'errBadTau']) {
  check('key ' + key + ' is translated', englishKeys.includes(key));
}

check('resolveLang takes an exact tag', flir.resolveLang('fi-FI') === 'fi-FI');
check('resolveLang is case insensitive', flir.resolveLang('ZH-cn') === 'zh-CN');
check('resolveLang falls back to the primary subtag', flir.resolveLang('fi') === 'fi-FI');
check('resolveLang maps zh-TW onto the Chinese translation', flir.resolveLang('zh-TW') === 'zh-CN');
check('resolveLang falls back to English', flir.resolveLang('de-DE') === 'en');
check('resolveLang handles a missing tag', flir.resolveLang(null) === 'en');

const tFi = flir.makeTranslator('fi-FI');
check('translator reports its language', tFi.lang === 'fi-FI');
check('translator substitutes positionally', tFi('frameLabel', [2, 7]) === 'Ruutu 2 / 7', tFi('frameLabel', [2, 7]));
check('translator leaves an unknown key visible', flir.makeTranslator('en')('no-such-key') === 'no-such-key');
check('translator ignores extra arguments', flir.makeTranslator('en')('loadAnyway', [1, 2]) === 'Load anyway');

// --- real files -----------------------------------------------------------

let thermimageOff = 0, thermimageTotal = 0, thermimageWorst = 0;
const recordings = samplePaths(process.argv.slice(2));
if (!recordings.length) console.log('\nno recordings to check (nothing in ./samples and none given)');
for (const path of recordings) {
  console.log('\n' + basename(path));
  const truth = truthFor(path);
  const buf = readFileSync(path);
  const ab = toArrayBuffer(buf);
  const seq = flir.parseSeq(ab);
  console.log('  frames: ' + seq.frames.length + (seq.warnings.length ? '  warnings: ' + seq.warnings.join('; ') : ''));
  const f0 = seq.frames[0];
  console.log('  ' + f0.raw.width + 'x' + f0.raw.height + '  ' + f0.info.cameraModel +
    ' sn' + f0.info.cameraSerialNumber + '  lens ' + f0.info.lensModel);
  const p = flir.paramsFromInfo(f0.info);
  const c = flir.makeConverter(p);
  console.log('  e=' + p.emissivity + ' d=' + p.objectDistance + 'm rh=' + p.relativeHumidity +
    '% refl=' + p.reflectedTemp.toFixed(1) + 'C  R1=' + p.planckR1.toFixed(2) + ' R2=' +
    p.planckR2.toPrecision(6) + ' B=' + p.planckB.toFixed(2) + ' O=' + p.planckO);
  console.log('  tau=' + c.tau.toFixed(4) + (c.tauFromFile ? ' (from the file)' : ' (estimated)') +
    '  pixel values ' + f0.info.pixelValueType + '/' + f0.info.pixelValueUnit +
    (seq.warnings.length ? '  warnings: ' + seq.warnings.map((w) => w.key).join(', ') : ''));
  if (!truth) {
    console.log('  (no Thermal Studio figures on file for this recording, printing a summary only)');
  }
  for (const frame of seq.frames) {
    const px = flir.readFramePixels(ab, frame);
    let min = 0xffff, max = 0, sum = 0;
    const hist = new Float64Array(65536);
    for (let i = 0; i < px.length; i++) {
      if (px[i] < min) min = px[i];
      if (px[i] > max) max = px[i];
      sum += c.lut[px[i]];
      hist[px[i]]++;
    }
    const mine = [c.toTemp(max), c.toTemp(min), sum / px.length];
    console.log('  frame ' + (frame.index + 1) + ' @' + frame.offset +
      '  ' + frame.info.dateTime.toISOString() +
      '  max ' + mine[0].toFixed(2) + '  min ' + mine[1].toFixed(2) +
      '  avg ' + mine[2].toFixed(2) + ' C');
    const deviation = Math.abs(c.toTemp(max) - referenceTemp(max, p));
    if (deviation > 1e-6) {
      check('frame ' + (frame.index + 1) + ' matches the reference model', false, deviation);
    }
    if (frame.index === 0) {
      // the file's own scale, which is what Thermal Studio opens on
      const scale = flir.cameraScale(frame.info, c);
      console.log('  recorded scale ' + scale.lo.toFixed(2) + ' .. ' + scale.hi.toFixed(2) + ' C' +
        '  (median ' + frame.info.rawValueMedian + ' +/- ' + frame.info.rawValueRange / 2 + ')');
      if (truth) {
        check('the recorded scale matches the one Thermal Studio opens on',
          displaysTheSame(scale.lo, CAMERA_SCALE[0]) && displaysTheSame(scale.hi, CAMERA_SCALE[1]),
          scale.lo.toFixed(2) + ' .. ' + scale.hi.toFixed(2) + ' vs ' +
          CAMERA_SCALE[0].toFixed(1) + ' .. ' + CAMERA_SCALE[1].toFixed(1));
      }
    }
    const expected = truth && truth.frames[frame.index];
    if (!expected) continue;
    // Thermal Studio prints one decimal, so landing inside half a digit is the
    // most agreement that can be demonstrated from its display.
    const labels = ['max', 'min', 'avg'];
    for (let i = 0; i < 3; i++) {
      const d = mine[i] - expected[i];
      check('frame ' + (frame.index + 1) + ' ' + labels[i] + ' matches Thermal Studio',
        displaysTheSame(mine[i], expected[i]),
        mine[i].toFixed(2) + ' vs ' + expected[i].toFixed(1) + ' (' + (d >= 0 ? '+' : '') + d.toFixed(2) + ')');
    }
    // and the other convention has to be measurably worse, or the default
    // would be an arbitrary preference rather than a finding
    const tc = flir.makeConverter(p, flir.MODEL_THERMIMAGE);
    let tsum = 0;
    for (let raw = 0; raw < 65536; raw++) if (hist[raw]) tsum += tc.lut[raw] * hist[raw];
    const theirs = [tc.toTemp(max), tc.toTemp(min), tsum / px.length];
    thermimageOff += theirs.filter((v, i) => !displaysTheSame(v, expected[i])).length;
    thermimageTotal += 3;
    thermimageWorst = Math.max(thermimageWorst, ...theirs.map((v, i) => Math.abs(v - expected[i])));
  }
}

if (thermimageTotal) {
  check('the Thermimage convention would miss Thermal Studio on most of them',
    thermimageOff > thermimageTotal / 2,
    thermimageOff + ' of ' + thermimageTotal + ' outside the rounding, worst ' +
    thermimageWorst.toFixed(3) + ' K');
}

console.log(failures ? '\n' + failures + ' check(s) failed' : '\nall checks passed');
process.exit(failures ? 1 : 0);
