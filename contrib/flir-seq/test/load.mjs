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

/** The published FLIR object-signal model, transcribed independently of the
 *  viewer so that a mistake in its pre-computed terms shows up as a mismatch. */
export function referenceTemp(raw, p) {
  const K = 273.15;
  const h2o = (p.relativeHumidity / 100) * Math.exp(
    1.5587 + 0.06939 * p.atmosphericTemp - 0.00027816 * p.atmosphericTemp ** 2 +
    0.00000068455 * p.atmosphericTemp ** 3);
  const d = Math.sqrt(p.objectDistance / 2);
  const tau = p.atmTransX * Math.exp(-d * (p.atmTransAlpha1 + p.atmTransBeta1 * Math.sqrt(h2o))) +
    (1 - p.atmTransX) * Math.exp(-d * (p.atmTransAlpha2 + p.atmTransBeta2 * Math.sqrt(h2o)));
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
