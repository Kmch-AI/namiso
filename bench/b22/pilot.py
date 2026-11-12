# -*- coding: utf-8 -*-
"""Cheap end-to-end pilot: lowest-cutoff exam points, official runner path.

Feeds only as far as the smallest cutoffs, then runs the real
run_persona -> answer_and_judge -> summarize chain so the score pipeline is
exercised before the full dev run.
"""
import json
import os
import sys
import types

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
HARNESS = r"D:\AI\chat-memory-benchmark\benchmark-2.2\harness"
for path in (HARNESS, HERE):
    if path not in sys.path:
        sys.path.insert(0, path)

from bench22 import systems  # noqa: E402
from namiso_system import NamisoSystem  # noqa: E402

systems.REGISTRY["namiso"] = NamisoSystem

from bench22 import runner  # noqa: E402
from bench22.release import load_histories, load_items  # noqa: E402
from bench22.systems import Gateway  # noqa: E402

RUN = os.environ.get("PILOT_RUN", "pilot1")
PER_PERSONA = int(os.environ.get("PILOT_N", "3"))
RELEASE = r"D:\AI\chat-memory-benchmark\benchmark-2.2\dataset"
GATEWAY = os.environ.get("SHIM_GATEWAY", "http://127.0.0.1:18901/v1")

args = types.SimpleNamespace(
    system="namiso",
    split="dev",
    run=RUN,
    gateway=GATEWAY,
    sample=0,
    seed=20261109,
    only_new=False,
    limit=0,
    sentinel=False,
    leaky=False,
    sentinel_n=12,
    persona="both",
    workers=3,
)

items_all = [i for i in load_items(RELEASE) if i.get("split") == "dev"]
picked = []
for persona in ("M01", "M02"):
    pool = sorted([i for i in items_all if i["persona"] == persona], key=lambda x: x["cutoff_turn"])
    picked += pool[:PER_PERSONA]
print("pilot items", [(i["id"], i["persona"], i["cutoff_turn"]) for i in picked])

hist = load_histories(RELEASE)
outdir = os.path.join(HARNESS, "runs", "bench22", RUN, "namiso", "dev")
os.makedirs(outdir, exist_ok=True)

leaks = []
for persona in ("M01", "M02"):
    gw = Gateway(GATEWAY, RUN, f"namiso:{persona}:dev")
    leaks += runner.run_persona(args, RELEASE, hist, persona, picked, outdir, gw, None)
print("leaks", leaks)

runner.answer_and_judge(args, picked, outdir, Gateway(GATEWAY, RUN, "namiso"), None)
out = runner.summarize(args, picked, outdir, RELEASE, RUN, None, picked)
print(json.dumps(out["boards"], ensure_ascii=False, indent=1)[:3000])
