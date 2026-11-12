"""Finish the exam board after a crash: judge whatever is still missing, then summarize.

runner.answer_and_judge already skips ids present in answers.jsonl / judgments.jsonl,
so this only redoes the gaps. runner.summarize then writes summary.json exactly as
the official runner does.
"""

import argparse
import os
import sys

HARNESS = r"D:\AI\chat-memory-benchmark\benchmark-2.2\harness"
sys.path.insert(0, HARNESS)

from bench22 import runner  # noqa: E402
from bench22.release import load_items  # noqa: E402
from bench22.systems import Gateway  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--release", required=True)
    ap.add_argument("--system", default="namiso")
    ap.add_argument("--split", default="dev")
    ap.add_argument("--run", default="b22")
    ap.add_argument("--gateway", default="http://127.0.0.1:18901/v1")
    ap.add_argument("--workers", type=int, default=6)
    a = ap.parse_args()

    items = [i for i in load_items(a.release) if i.get("split") == "dev"]
    outdir = os.path.join(runner.ROOT, "runs", "bench22", a.run, a.system, a.split)
    gw = Gateway(a.gateway, run=a.run, system=a.system)

    runner.answer_and_judge(a, items, outdir, gw, None)
    out = runner.summarize(a, items, outdir, a.release, a.run, None, items)
    runner.log({p: {k: b[k] for k in ("A", "D_daily", "L_long", "A_interval95", "cost_cny")}
                for p, b in out["boards"].items()})


if __name__ == "__main__":
    main()
