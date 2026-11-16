# -*- coding: utf-8 -*-
"""Post-run steps: split the ledger, judge+summarize the natural board, print the report.

Run after both `launch_runner.py` (exam) and `launch_natural.py run` have finished.
"""
import os
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable
RUN = os.environ.get("B22_RUN", "b22")
RELEASE = r"D:\AI\chat-memory-benchmark\benchmark-2.2\dataset"
NATURAL = os.path.join(RELEASE, "natural")
GATEWAY = os.environ.get("SHIM_GATEWAY", "http://127.0.0.1:18901/v1")


def run(*args):
    print("\n$", " ".join(args), flush=True)
    env = dict(os.environ, PYTHONIOENCODING="utf-8", NAMISO_BRIDGE=os.environ.get("NAMISO_BRIDGE", "http://127.0.0.1:18902"))
    code = subprocess.call(args, env=env)
    print("  exit", code, flush=True)
    return code


def main():
    run(PY, os.path.join(HERE, "split_ledger.py"))
    for cmd in ("judge", "summarize"):
        run(PY, os.path.join(HERE, "launch_natural.py"), cmd, "--release", RELEASE, "--natural", NATURAL,
            "--system", "namiso", "--split", "dev", "--run", RUN, "--gateway", GATEWAY, "--workers", "6")
    out = os.path.join(HERE, "..", "out")
    os.makedirs(out, exist_ok=True)
    score_md = os.path.join(out, f"{RUN}-score.md")
    bill_md = os.path.join(out, f"{RUN}-bill.md")
    run(PY, os.path.join(HERE, "final_report.py"), "--run", RUN, "--out", score_md)
    run(PY, os.path.join(HERE, "bill.py"), "--run", RUN, "--detail-run", RUN, "--out", bill_md)
    combined = os.path.join(out, f"{RUN}-report.md")
    with open(combined, "w", encoding="utf-8") as handle:
        for path in (score_md, bill_md):
            if os.path.exists(path):
                handle.write(open(path, encoding="utf-8").read().rstrip() + "\n\n")
    print("\ncombined report:", combined, flush=True)


if __name__ == "__main__":
    main()
