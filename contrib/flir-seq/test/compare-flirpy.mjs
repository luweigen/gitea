// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Cross-checks against flirpy, an independent Python implementation, on the two
// things it can still settle:
//
//   * the container parsing -- frame boundaries, record offsets and the sensor
//     counts themselves, compared pixel by pixel with flirpy's own FFF reader;
//   * the shared algebra -- flirpy implements Thermimage's convention, in which
//     the atmospheric transmission is evaluated over half the object distance
//     and applied twice, so it is compared against thermimageTemp() rather than
//     against the viewer.
//
// The viewer no longer uses that convention: measured against FLIR Thermal
// Studio it reads about 0.1 K too cold (see ../doc/format.md and truth.mjs), so
// the atmosphere is now evaluated over the whole distance and removed once. The
// gap between the two conventions is reported below rather than asserted away.
//
//   pip install flirpy
//   node compare-flirpy.mjs                    parameter grid
//   node compare-flirpy.mjs real.seq           also every pixel of a real file
//   FLIRPY_PYTHON=/path/to/venv/bin/python node compare-flirpy.mjs
//
// flirpy has no equivalent of estAtmosphericTransmission, so every case here
// leaves it at 0 (the transmission is estimated). That branch is covered by
// run.mjs instead.

import {execFileSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadFlirSeq, thermimageTemp, referenceTemp} from './load.mjs';
import {toArrayBuffer} from './fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const python = process.env.FLIRPY_PYTHON || 'python3';
const flir = loadFlirSeq();
const TOLERANCE = 1e-9; // Kelvin

// The A655sc calibration the samples carry, as the baseline every case varies.
const base = flir.paramsFromInfo({
  emissivity: 0.95, objectDistance: 1, reflectedTempK: 293.15, atmosphericTempK: 293.15,
  irWindowTempK: 293.15, irWindowTransmission: 1, relativeHumidity: 50,
  planckR1: 14772.65, planckR2: 0.0137111, planckB: 1393.8, planckF: 1, planckO: -3735,
  atmTransAlpha1: 0.006569, atmTransAlpha2: 0.01262,
  atmTransBeta1: -0.002276, atmTransBeta2: -0.00667, atmTransX: 1.9,
});

const variations = [
  ['A655sc, as recorded', {}],
  ['low emissivity', {emissivity: 0.3}],
  ['high emissivity', {emissivity: 1}],
  ['hot reflected background', {reflectedTemp: 80}],
  ['cold reflected background', {reflectedTemp: -40}],
  ['long distance', {objectDistance: 250}],
  ['very long distance', {objectDistance: 1000}],
  ['dry air', {relativeHumidity: 5}],
  ['saturated air', {relativeHumidity: 100}],
  ['hot air', {objectDistance: 100, atmosphericTemp: 45}],
  ['freezing air', {objectDistance: 100, atmosphericTemp: -30}],
  ['IR window in the path', {irWindowTransmission: 0.7, irWindowTemp: 35}],
  ['everything at once', {
    emissivity: 0.62, objectDistance: 42, relativeHumidity: 88,
    reflectedTemp: 12, atmosphericTemp: 31, irWindowTemp: 26, irWindowTransmission: 0.85,
  }],
  ['a different camera calibration', {
    planckR1: 17096.453, planckR2: 0.04351538, planckB: 1428.0, planckF: 1, planckO: -7340,
  }],
];

// raw counts spanning what the samples hold, plus the extremes of the domain
const raws = [4000, 7459, 8500, 9891, 10500, 11674, 14000, 20000, 40000];

const cases = variations.map(([name, override]) => ({
  name,
  params: Object.assign({}, base, override),
  raw: raws,
}));

const work = mkdtempSync(join(tmpdir(), 'flir-seq-flirpy-'));
let theirs;
try {
  const casePath = join(work, 'cases.json');
  const outPath = join(work, 'out.json');
  writeFileSync(casePath, JSON.stringify(cases));
  try {
    execFileSync(python, [join(here, 'compare_flirpy.py'), casePath, outPath], {stdio: ['ignore', 'inherit', 'inherit']});
  } catch (e) {
    console.error('could not run flirpy through "' + python + '": ' + e.message);
    console.error('install it with:  pip install flirpy   (or set FLIRPY_PYTHON)');
    process.exit(2);
  }
  theirs = JSON.parse(readFileSync(outPath, 'utf8'));
} finally {
  rmSync(work, {recursive: true, force: true});
}

let worst = 0;
let worstCase = '';
let conventionGap = 0;
const fmt = (v) => (Number.isFinite(v) ? v.toFixed(6) : 'out of domain').padStart(13);
console.log('case                     raw   thermimage form        flirpy          |Δ|');
for (let i = 0; i < cases.length; i++) {
  const conv = flir.makeConverter(cases[i].params);
  if (!conv.ok) throw new Error('case ' + cases[i].name + ' has no usable calibration: ' + conv.reason);
  let caseWorst = 0, at = raws[0], mine = thermimageTemp(raws[0], cases[i].params);
  let other = theirs[i][0] === null ? NaN : theirs[i][0];
  for (let j = 0; j < raws.length; j++) {
    const a = thermimageTemp(raws[j], cases[i].params);
    const shipped = conv.toTemp(raws[j]);
    if (Number.isFinite(shipped) && Number.isFinite(a)) {
      conventionGap = Math.max(conventionGap, Math.abs(shipped - a));
    }
    // null is flirpy's NaN: a raw value the model cannot invert. Both sides
    // refusing is agreement; one side inventing a number is not.
    const b = theirs[i][j] === null ? NaN : theirs[i][j];
    const bothOutOfDomain = !Number.isFinite(a) && !Number.isFinite(b);
    const d = bothOutOfDomain ? 0 : (Number.isFinite(a) && Number.isFinite(b) ? Math.abs(a - b) : Infinity);
    if (d > caseWorst) {
      caseWorst = d;
      at = raws[j];
      mine = a;
      other = b;
    }
  }
  console.log(cases[i].name.padEnd(29) + String(at).padStart(5) + '  ' +
    fmt(mine) + '  ' + fmt(other) + '  ' + caseWorst.toExponential(2));
  if (caseWorst > worst) {
    worst = caseWorst;
    worstCase = cases[i].name;
  }
}

console.log('\nflirpy ' + execFileSync(python,
  ['-c', 'import importlib.metadata as m; print(m.version("flirpy"))'], {encoding: 'utf8'}).trim() +
  ', ' + cases.length + ' parameter sets × ' + raws.length + ' raw values');
let ok = worst <= TOLERANCE;
console.log((ok ? 'agrees' : 'DISAGREES') + ' with flirpy in its own convention: largest deviation ' +
  worst.toExponential(2) + ' K (' + worstCase + '), tolerance ' + TOLERANCE.toExponential(0) + ' K');
console.log('the shipped full-path convention differs from it by up to ' +
  conventionGap.toFixed(3) + ' K over these cases -- that difference is the point, see truth.mjs');

// --- whole files, pixel by pixel ------------------------------------------
//
// This puts flirpy's own FFF reader against ours, so the record offsets are
// compared as well as the arithmetic.
for (const path of process.argv.slice(2)) {
  console.log('\n' + path);
  const dir = mkdtempSync(join(tmpdir(), 'flir-seq-flirpy-'));
  let decoded;
  try {
    const outPath = join(dir, 'frames.json');
    execFileSync(python, [join(here, 'compare_flirpy.py'), '--frames', path, outPath],
      {stdio: ['ignore', 'inherit', 'inherit']});
    decoded = JSON.parse(readFileSync(outPath, 'utf8'));
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }

  const buffer = toArrayBuffer(readFileSync(path));
  const parsed = flir.parseSeq(buffer);
  const agree = (label, condition, detail) => {
    console.log((condition ? '  ok   ' : '  FAIL ') + label + (detail === undefined ? '' : '  ' + detail));
    if (!condition) ok = false;
  };
  agree('same frame count', parsed.frames.length === decoded.length,
    parsed.frames.length + ' vs ' + decoded.length);

  for (let i = 0; i < Math.min(parsed.frames.length, decoded.length); i++) {
    const frame = parsed.frames[i];
    const theirFrame = decoded[i];
    // flirpy's FFF reader converts Kelvin to Celsius with 273.14 (fff.py's
    // get_float_kelvin) while everything else in it uses 273.15, so its object
    // parameters land 0.01 K high. Comparing twice separates that from a real
    // disagreement: once with flirpy's own numbers fed to our converter, once
    // with each side's own parsing.
    // the sensor counts themselves must match: that is the parsing check
    let rawMismatch = 0;
    const ourPixels = flir.readFramePixels(buffer, frame);
    for (let j = 0; j < ourPixels.length; j++) {
      if (ourPixels[j] !== theirFrame.raw[j]) rawMismatch++;
    }
    agree('frame ' + (i + 1) + ': ' + ourPixels.length + ' sensor counts are identical',
      rawMismatch === 0, rawMismatch + ' differ');

    const ours = flir.paramsFromInfo(frame.info);
    const sameInputs = Object.assign({}, ours, {
      reflectedTemp: theirFrame.meta['Reflected Apparent Temperature'],
      atmosphericTemp: theirFrame.meta['Atmospheric Temperature'],
      irWindowTemp: theirFrame.meta['IR Window Temperature'],
    });
    const convOurs = flir.makeConverter(ours);
    const pixels = ourPixels;
    let frameWorst = 0, asShipped = 0, mismatched = 0;
    for (let j = 0; j < pixels.length; j++) {
      const a = thermimageTemp(pixels[j], sameInputs);
      const b = theirFrame.temps[j] === null ? NaN : theirFrame.temps[j];
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        if (Number.isFinite(a) !== Number.isFinite(b)) mismatched++;
        continue;
      }
      const d = Math.abs(a - b);
      if (d > frameWorst) frameWorst = d;
      const dp = Math.abs(convOurs.toTemp(pixels[j]) - b);
      if (dp > asShipped) asShipped = dp;
    }
    void referenceTemp;
    agree('frame ' + (i + 1) + ': same offset and geometry',
      frame.offset === theirFrame.offset && frame.raw.width === theirFrame.width &&
      frame.raw.height === theirFrame.height,
      frame.offset + ' ' + frame.raw.width + 'x' + frame.raw.height);
    agree('frame ' + (i + 1) + ': ' + pixels.length + ' pixels agree in flirpy\'s convention',
      frameWorst <= TOLERANCE && mismatched === 0,
      'largest deviation ' + frameWorst.toExponential(2) + ' K; the shipped viewer reads up to ' +
      asShipped.toFixed(3) + ' K warmer, which is what matches Thermal Studio' +
      (mismatched ? ', ' + mismatched + ' disagree on being out of domain' : ''));
    if (frameWorst > worst) worst = frameWorst;
  }
}

process.exit(ok ? 0 : 1);
