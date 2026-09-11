# Copyright 2026 The Gitea Authors. All rights reserved.
# SPDX-License-Identifier: MIT
#
# Helper for compare-flirpy.mjs: reads the case file it writes, runs each case
# through flirpy's raw2temp() and writes the temperatures back as JSON.
#
#   python3 compare_flirpy.py cases.json out.json
#   python3 compare_flirpy.py --frames real.seq out.json
#
# flirpy takes its parameters the way its own FFF reader produces them:
# temperatures in Celsius and the relative humidity as a fraction, which is
# what the camera stores at 0x3c.

import json
import math
import sys

import numpy as np
from flirpy.util.raw import raw2temp


def main(case_path, out_path):
    cases = json.load(open(case_path))
    results = []
    for case in cases:
        # flirpy's from_string_or_float() accepts a str or a float but not an
        # int, so every number has to arrive as a float.
        p = {k: (float(v) if isinstance(v, (int, float)) else v) for k, v in case["params"].items()}
        meta = {
            "Emissivity": p["emissivity"],
            "Object Distance": p["objectDistance"],
            "Reflected Apparent Temperature": p["reflectedTemp"],
            "Atmospheric Temperature": p["atmosphericTemp"],
            "IR Window Temperature": p["irWindowTemp"],
            "IR Window Transmission": p["irWindowTransmission"],
            # flirpy's own FFF reader hands this on as the fraction from 0x3c
            "Relative Humidity": p["relativeHumidity"] / 100.0,
            "Planck R1": p["planckR1"],
            "Planck R2": p["planckR2"],
            "Planck B": p["planckB"],
            "Planck F": p["planckF"],
            "Planck O": p["planckO"],
            "Atmospheric Trans Alpha 1": p["atmTransAlpha1"],
            "Atmospheric Trans Alpha 2": p["atmTransAlpha2"],
            "Atmospheric Trans Beta 1": p["atmTransBeta1"],
            "Atmospheric Trans Beta 2": p["atmTransBeta2"],
            "Atmospheric Trans X": p["atmTransX"],
        }
        temps = raw2temp(np.array(case["raw"], dtype=np.float64), meta)
        # NaN is not valid JSON; a raw value outside the model's domain comes
        # back as null and has to be NaN on the other side too.
        results.append([float(t) if math.isfinite(t) else None for t in temps])
    json.dump(results, open(out_path, "w"))


def frames(seq_path, out_path):
    """Decode a real .seq end to end with flirpy's own FFF reader.

    A .seq is a concatenation of FFF frames, and flirpy only reads one, so the
    frames are split on the magic first and handed over one at a time. This
    exercises flirpy's parser as well as its radiometry, which is the point:
    the comparison then covers the offsets too, not just the formula.
    """
    from flirpy.io.fff import Fff

    data = open(seq_path, "rb").read()
    magic = b"FFF\x00"
    starts = []
    at = data.find(magic)
    while at != -1:
        starts.append(at)
        at = data.find(magic, at + 1)
    starts.append(len(data))

    out = []
    for i in range(len(starts) - 1):
        fff = Fff(data[starts[i]:starts[i + 1]])
        image = fff.get_radiometric_image()
        out.append({
            "offset": starts[i],
            "width": int(fff.width),
            "height": int(fff.height),
            # flirpy's own parse of the sensor counts, to compare the record
            # offsets independently of any radiometry
            "raw": [int(v) for v in fff.get_image().reshape(-1).tolist()],
            "meta": {k: (v if isinstance(v, (int, float)) else str(v)) for k, v in fff.meta.items()
                     if isinstance(v, (int, float, bytes, str))},
            "temps": [float(t) if math.isfinite(t) else None for t in image.reshape(-1).tolist()],
        })
    json.dump(out, open(out_path, "w"))


if __name__ == "__main__":
    if sys.argv[1] == "--frames":
        frames(sys.argv[2], sys.argv[3])
    else:
        main(sys.argv[1], sys.argv[2])
