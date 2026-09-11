// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

export const assetDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'custom', 'public', 'assets');
export const scriptPath = join(assetDir, 'js', 'gitea-flir-seq.js');

/**
 * The asset is a classic browser script, and Gitea's package.json marks plain
 * .js as ESM, so it cannot simply be require()d. Evaluate it the way a browser
 * would instead, handing it a CommonJS "module" to export through and no
 * "window" at all.
 */
export function loadFlirSeq() {
  const shim = {exports: {}};
  new Function('module', 'window', readFileSync(scriptPath, 'utf8'))(shim, undefined);
  return shim.exports;
}

/**
 * The FLIR object-signal model, transcribed independently of the viewer so
 * that a mistake in its pre-computed gain/offset terms shows up as a mismatch.
 * The atmosphere is evaluated over the whole object distance and removed once,
 * which is the form that reproduces FLIR Thermal Studio -- see
 * ../doc/format.md and truth.mjs.
 */
export function referenceTemp(raw, p) {
  const K = 273.15;
  const tau = atmosphericTau(p, p.objectDistance);
  const planck = (t) => p.planckR1 / (p.planckR2 * (Math.exp(p.planckB / (t + K)) - p.planckF)) - p.planckO;
  const e = p.emissivity;
  const irt = p.irWindowTransmission;
  const obj = raw / (e * tau * irt)
    - (1 - e) / e * planck(p.reflectedTemp)
    - (1 - tau) / (e * tau) * planck(p.atmosphericTemp)
    - (1 - irt) / (e * tau * irt) * planck(p.irWindowTemp);
  return p.planckB / Math.log(p.planckR1 / (p.planckR2 * (obj + p.planckO)) + p.planckF) - K;
}

/**
 * The same model as Thermimage's raw2temp() and, through it, flirpy: the
 * transmission is evaluated over half the distance and applied twice, on the
 * assumption of an IR window halfway along the path. Kept here only so that
 * compare-flirpy.mjs can check flirpy against the convention flirpy actually
 * implements; it reads about 0.1 K colder than FLIR's own software at the
 * temperatures in the samples.
 */
export function thermimageTemp(raw, p) {
  const K = 273.15;
  const tau = atmosphericTau(p, p.objectDistance / 2);
  const planck = (t) => p.planckR1 / (p.planckR2 * (Math.exp(p.planckB / (t + K)) - p.planckF)) - p.planckO;
  const e = p.emissivity;
  const irt = p.irWindowTransmission;
  const obj = raw / e / tau / irt / tau
    - (1 - e) / e * planck(p.reflectedTemp)
    - (1 - tau) / e / tau * planck(p.atmosphericTemp)
    - (1 - tau) / e / tau / irt / tau * planck(p.atmosphericTemp)
    - (1 - irt) / e / irt / tau * planck(p.irWindowTemp);
  return p.planckB / Math.log(p.planckR1 / (p.planckR2 * (obj + p.planckO)) + p.planckF) - K;
}

/** Two-term FLIR fit for the transmission of a path of "distance" metres. */
function atmosphericTau(p, distance) {
  if (p.atmTransmission > 0 && p.atmTransmission <= 1) return p.atmTransmission;
  const h2o = (p.relativeHumidity / 100) * Math.exp(
    1.5587 + 0.06939 * p.atmosphericTemp - 0.00027816 * p.atmosphericTemp ** 2 +
    0.00000068455 * p.atmosphericTemp ** 3);
  const d = Math.sqrt(distance);
  const r = Math.sqrt(h2o);
  return p.atmTransX * Math.exp(-d * (p.atmTransAlpha1 + p.atmTransBeta1 * r)) +
    (1 - p.atmTransX) * Math.exp(-d * (p.atmTransAlpha2 + p.atmTransBeta2 * r));
}
