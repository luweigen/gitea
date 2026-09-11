// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Ground truth: per-frame statistics as FLIR Thermal Studio 2.0.84 reports
// them for two FLIR A655sc sequences, contributed by the recordings' owner.
//
// This is the only reference here that does not descend from the ExifTool
// forum's reverse engineering, so it is what decides the model rather than
// merely cross-checking an implementation of it. It is what showed that
// evaluating the atmospheric transmission at half the distance and applying it
// twice -- what Thermimage does, and flirpy after it -- reads about 0.1 K too
// cold; see ../doc/format.md.
//
// The recordings are not in this repository: a few megabytes of thermal data do
// not belong in Gitea's tree. run.mjs applies these expectations when it is
// handed a file whose name matches a key below, and says so when it is not.

/** Thermal Studio prints one decimal, so anything closer than this agrees. */
export const DISPLAY_ROUNDING = 0.05;

/**
 * The colour scale Thermal Studio opens both recordings on, as [low, high].
 * It is identical for the two because it comes out of the file rather than the
 * pixels: RawValueMedian +/- RawValueRange/2, which both recordings carry as
 * 9734 +/- 262.
 */
export const CAMERA_SCALE = [-9.1, -4.2];

export const TRUTH = {
  // key: the distinctive part of the file name, matched as a substring
  '185820659': {
    camera: 'FLIR A655sc',
    file: 'joensuu2023-10-21T185820659.seq',
    // [max, min, avg] in degrees Celsius, per frame, in file order
    frames: [
      [9.7, -31.4, -7.8],
      [6.8, -26.8, -7.4],
      [11.3, -20.8, -7.3],
    ],
  },
  '190131749': {
    camera: 'FLIR A655sc',
    file: 'joensuu2023-10-21T190131749.seq',
    frames: [
      [5.3, -17.3, -6.7],
      [5.1, -18.1, -6.9],
      [6.0, -30.9, -7.4],
      [8.4, -30.6, -7.9],
    ],
  },
};

/** The ground truth for a path, or null when the file is not one we know. */
export function truthFor(path) {
  const key = Object.keys(TRUTH).find((k) => path.includes(k));
  return key ? TRUTH[key] : null;
}
