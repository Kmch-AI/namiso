# -*- coding: utf-8 -*-
"""Smoke-test the bridge + shim gateway with a tiny history slice.

Checks: ingest/retrieve round trip, mark/begin_tail/rewind semantics (tail never
persisted), and that the shim writes both ledgers with the expected phases.
"""
import json
import os
import sys
import time
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")

BRIDGE = "http://127.0.0.1:18902"
HARNESS = r"D:\AI\chat-memory-benchmark\benchmark-2.2\harness"
HIST = r"D:\AI\chat-memory-benchmark\benchmark-2.2\dataset\histories\M01.jsonl"
ROOT = os.path.join(HARNESS, "runs", "bench22")


def post(path, payload, timeout=1800):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(BRIDGE + path, data=data, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        print(path, "HTTP", error.code, error.read().decode("utf-8", "replace")[:1200])
        raise


def get(path):
    with urllib.request.urlopen(BRIDGE + path, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


sid = "smoke-%d" % int(time.time())
scope = {"run": "smoke", "system": "namiso:M01:dev", "board": "exam", "split": "dev"}

turns = []
with open(HIST, encoding="utf-8") as handle:
    for line in handle:
        row = json.loads(line)
        turns.append({
            "turn": row["轮次"],
            "time": row["逻辑时间"],
            "user": row["用户消息"],
            "assistant": row["助手回复"],
        })
        if len(turns) >= 40:
            break

started = time.time()
for turn in turns[:36]:
    post("/ingest", {"sid": sid, "turn": turn})
print("ingested 36 turns in %.1fs" % (time.time() - started))

started = time.time()
mark = post("/mark", {"sid": sid})["token"]
print("mark", mark, "%.2fs" % (time.time() - started))

started = time.time()
out = post("/retrieve", {
    "sid": sid,
    "question": turns[35]["user"][:40],
    "now": turns[35]["time"],
    "scope": scope,
    "persona": "M01",
})
print("retrieve %.1fs meta=%s" % (time.time() - started, json.dumps(out["meta"], ensure_ascii=False)))
print("prompt head:", out["prompt"][:200].replace("\n", " | "))
print("prompt chars", len(out["prompt"]))

# tail semantics: 4 extra turns must never reach the database
post("/begin_tail", {"sid": sid})
for turn in turns[36:40]:
    post("/ingest", {"sid": sid, "turn": turn})
out2 = post("/retrieve", {
    "sid": sid,
    "question": "我上次说的那个补休是哪天？",
    "now": turns[39]["time"],
    "scope": scope,
    "persona": "M01",
})
print("tail retrieve meta", json.dumps(out2["meta"], ensure_ascii=False))
print("tail rendered:", [line for line in out2["prompt"].split("\n") if line.startswith("[")][-6:])
post("/rewind", {"sid": sid, "token": mark})
print("after rewind mark", post("/mark", {"sid": sid})["token"])
print("bridge health", json.dumps(get("/health"), ensure_ascii=False)[:400])

for name in ("spend-ledger.jsonl", "detail/smoke/exam-calls.jsonl"):
    path = os.path.join(ROOT, name)
    rows = [json.loads(line) for line in open(path, encoding="utf-8")] if os.path.exists(path) else []
    mine = [r for r in rows if r.get("run") == "smoke"]
    phases = {}
    for row in mine:
        phases.setdefault(row.get("phase"), []).append(row)
    print("==", name, len(mine), "rows")
    for phase, items in phases.items():
        tin = sum(i.get("in_tokens", i.get("prompt_tokens", 0)) for i in items)
        tout = sum(i.get("out_tokens", i.get("completion_tokens", 0)) for i in items)
        hit = sum(i.get("cache_hit_tokens", 0) for i in items)
        print("   ", phase, len(items), "calls in=%d out=%d hit=%d" % (tin, tout, hit))
