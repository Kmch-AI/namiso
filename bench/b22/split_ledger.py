# -*- coding: utf-8 -*-
"""Split the shared spend ledger into the exam and natural ledgers.

natural.py's cost function reads runs/bench22/natural/spend-ledger.jsonl while the
exam runner reads runs/bench22/spend-ledger.jsonl. The shim gateway that served
this run was started before per-board routing existed, so every call landed in the
exam ledger; this moves the natural rows across. Safe to run more than once: rows
already in the natural ledger are kept and duplicates are skipped.
"""
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")

HARNESS = r"D:\AI\chat-memory-benchmark\benchmark-2.2\harness"
BASE = os.path.join(HARNESS, "runs", "bench22")
EXAM = os.path.join(BASE, "spend-ledger.jsonl")
NAT = os.path.join(BASE, "natural", "spend-ledger.jsonl")


def read(path):
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def is_natural(row):
    return ":natural-" in (row.get("system") or "")


def write(path, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def main():
    rows = read(EXAM)
    known = {json.dumps(r, sort_keys=True, ensure_ascii=False) for r in read(NAT)}
    nat = list(read(NAT))
    for row in rows:
        if not is_natural(row):
            continue
        key = json.dumps(row, sort_keys=True, ensure_ascii=False)
        if key not in known:
            known.add(key)
            nat.append(row)
    exam = [row for row in rows if not is_natural(row)]
    write(EXAM, exam)
    write(NAT, sorted(nat, key=lambda r: r.get("ts") or ""))
    print(f"exam rows {len(exam)}, natural rows {len(nat)}")


if __name__ == "__main__":
    main()
