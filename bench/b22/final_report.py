# -*- coding: utf-8 -*-
"""Final Bench 2.2 report for the Namiso run.

The published dev leaderboard is the cost reference (C_ref = qwen-base), so this
script scores the Namiso run with the official scoring functions and reports S
against those published C_ref values. Two cost viewpoints are printed:

  full      C as measured for the whole dev set (all items answered)
  comparable C with retrieval and memory cost scaled to the reference sample
            size, which is how the reference's own C was produced

A = (D + L) / 2 on the double-counted severe units; S = A - 3*log2(C / C_ref),
with C floored at C_ref/4.
"""
import argparse
import json
import math
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")

HARNESS = r"D:\AI\chat-memory-benchmark\benchmark-2.2\harness"
if HARNESS not in sys.path:
    sys.path.insert(0, HARNESS)

from bench22 import scoring  # noqa: E402
from bench22.gateway import PRICES, price_cny, _priced  # noqa: E402
from bench22.release import jl, load_items, board_name  # noqa: E402

ROOT = HARNESS
CFG = scoring.CONFIG
FIN = PRICES["models"]["deepseek-v4.1-flash"]["in_per_mtok"]
PUBLISHED = r"D:\AI\chat-memory-benchmark\benchmark-2.2\results\leaderboard-dev.json"


def load_run(run, system, split):
    d = os.path.join(ROOT, "runs", "bench22", run, system, split)
    g = lambda n: jl(os.path.join(d, n)) if os.path.exists(os.path.join(d, n)) else []
    return {"dir": d, "ctx": {r["id"]: r for r in g("contexts.jsonl")},
            "ans": {r["id"]: r for r in g("answers.jsonl")},
            "jud": {r["id"]: r for r in g("judgments.jsonl")}}


def ledger_costs(run, system, persona, split, board="exam"):
    key = f"{system}:{persona}:{split}"
    path = os.path.join(ROOT, "runs", "bench22", "spend-ledger.jsonl")
    if board == "natural":
        path = os.path.join(ROOT, "runs", "bench22", "natural", "spend-ledger.jsonl")
    ing = ret = 0.0
    for r in jl(path):
        if r.get("run") == run and r.get("system") == key:
            if r["phase"] == "ingest":
                ing += price_cny(_priced(r["model"]), r.get("in_tokens", 0), r.get("out_tokens", 0))
            elif r["phase"] == "retrieve":
                ret += price_cny(_priced(r["model"]), r.get("in_tokens", 0), r.get("out_tokens", 0))
    return ing, ret


def board(items, run, system, rd, persona, split, ref_c, ref_asked):
    ids = {i["id"] for i in items if i["persona"] == persona}
    ran = {x for x in ids if x in rd["ctx"]}
    scored = [i for i in items if i["id"] in ran and i["id"] in rd["jud"]]
    units = [u for u in scoring.build_units(scored) if all(x in rd["jud"] for x in u["ids"])]
    passed = {i: v["pass"] for i, v in rd["jud"].items()}
    bs = scoring.board_scores(units, passed)
    ci = scoring.bootstrap_A(units, passed, n_boot=CFG.get("bootstrap_draws", 2000))
    ing, ret = ledger_costs(run, system, persona, split)
    nq = max(1, len([i for i in ids if i in rd["ctx"]]))
    ratio = (sum(a["mem_tokens"] for a in rd["ans"].values()) / max(1, sum(len(rd["ctx"][i]["prompt"]) for i in rd["ans"]))) if rd["ans"] else 0.7
    mem = sum(rd["ans"][i]["mem_tokens"] if i in rd["ans"] else ratio * len(rd["ctx"][i]["prompt"]) for i in ran)
    c_full = ing + ret + mem * FIN / 1e6
    share = min(1.0, ref_asked / max(1, len(ran)))
    c_cmp = ing + ret * share + mem * share * FIN / 1e6
    s_full = scoring.composite(bs["A"], c_full, ref_c)
    s_cmp = scoring.composite(bs["A"], c_cmp, ref_c)
    return {"board": board_name(persona), "n_items": len(ran), "n_units": bs["n_units"], "n_daily": bs["n_daily"],
            "n_long": bs["n_long"], "n_pairs": bs["n_pairs"], "A": bs["A"], "D": bs["D"], "L": bs["L"],
            "pass_pct": bs["pass_pct"], "A_traffic": bs["A_traffic"], "ci": ci and [ci["lo"], ci["hi"]],
            "by_type": scoring.by_type(units, passed), "C_full": c_full, "C_cmp": c_cmp,
            "C_parts": {"ingest": ing, "retrieve": ret, "memory": mem * FIN / 1e6, "memory_tokens": mem},
            "S_full": s_full, "S_cmp": s_cmp, "C_ref": ref_c, "ref_asked": ref_asked}


def natural(run, system, split, ref_c, ref_n, ours_n):
    d = os.path.join(ROOT, "runs", "bench22", run, system, f"natural-{split}")
    p = os.path.join(d, "summary.json")
    if not os.path.exists(p):
        return None
    s = json.load(open(p, encoding="utf-8"))
    m = s["metrics"]
    c = s["cost_cny"]["total_C"]
    c_cmp = c * ref_n / max(1, ours_n)
    return {"A": m["A_nat"], "A_traffic": m.get("A_nat_traffic"), "R": m.get("R_side"), "P": m.get("P_side"),
            "ci": m.get("A_nat_interval95"), "by_class": m.get("by_class"), "recall": m["recall_rate"],
            "restraint": m["restraint_rate"], "fabrication": m["fabrication_rate"], "hedge": m.get("hedge_pass_rate"),
            "naturalness": m.get("naturalness_mean"), "n_items": m["n_items"], "C_full": c, "C_cmp": c_cmp,
            "C_parts": s["cost_cny"], "S_full": scoring.composite(m["A_nat"], c, ref_c),
            "S_cmp": scoring.composite(m["A_nat"], c_cmp, ref_c), "C_ref": ref_c,
            "floor_ok": m["restraint_rate"] >= CFG["floor_restraint_pct"] and m["fabrication_rate"] <= CFG["floor_fabrication_pct"],
            "x_diagnostics": m.get("x_diagnostics"), "leaks": s.get("leak_flags"), "contam": s.get("n_contaminated")}


def f(x, n=1):
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return "—"
    return f"{x:.{n}f}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default="b22")
    ap.add_argument("--system", default="namiso")
    ap.add_argument("--split", default="dev")
    ap.add_argument("--natural-n", type=int, default=95)
    ap.add_argument("--out", default="")
    a = ap.parse_args()

    pub = json.load(open(PUBLISHED, encoding="utf-8"))
    items = [i for i in load_items(r"D:\AI\chat-memory-benchmark\benchmark-2.2\dataset") if i.get("split") == "dev"]
    rd = load_run(a.run, a.system, a.split)
    lines = [f"# Namiso · Bench 2.2 {a.split}", "",
             f"价目表 {PRICES['version']}；C_ref 取官方 dev 榜单的 qwen-base（M01 {pub['boards']['M01']['C_ref']:.4f} / "
             f"M02 {pub['boards']['M02']['C_ref']:.4f} / natural {pub['natural']['qwen-base']['C']:.4f}）。", ""]
    out = {"boards": {}, "natural": None, "composite": {}}
    for persona in ("M01", "M02"):
        published = pub["boards"][persona]
        ref_c = published["C_ref"]
        ref_asked = published["n_common_items"]
        b = board(items, a.run, a.system, rd, persona, a.split, ref_c, ref_asked)
        out["boards"][persona] = b
        lines.append(f"## {b['board']}（{persona}）")
        lines.append(f"- 题目 {b['n_items']}，计分单元 {b['n_units']}（日常 {b['n_daily']} / 长期 {b['n_long']}，成对 {b['n_pairs']}）")
        lines.append(f"- A = {f(b['A'])}（D {f(b['D'])} / L {f(b['L'])}），95% 区间 {f(b['ci'][0]) if b['ci'] else '—'}–{f(b['ci'][1]) if b['ci'] else '—'}，"
                     f"原始通过率 {f(b['pass_pct'])}%，流量加权 A {f(b['A_traffic'])}")
        lines.append(f"- C = ¥{b['C_full']:.4f}（ingest ¥{b['C_parts']['ingest']:.4f} + retrieve ¥{b['C_parts']['retrieve']:.4f} + 记忆文本 ¥{b['C_parts']['memory']:.4f}，"
                     f"{int(b['C_parts']['memory_tokens']):,} tokens）")
        lines.append(f"- S（全量口径）= {f(b['S_full'])}；S（与参照同口径，把检索/记忆按 {ref_asked}/{b['n_items']} 折算）= {f(b['S_cmp'])}")
        if b["by_type"]:
            lines.append("- 分类型通过率：" + "，".join(f"{k} {v['n']}题 {f(v['pass_pct'])}%" for k, v in b["by_type"].items()))
        lines.append("")
    ref_nat = pub["natural"]["qwen-base"]
    nat = natural(a.run, a.system, a.split, ref_nat["C"], ref_nat["n_probes_run"], a.natural_n)
    out["natural"] = nat
    if nat:
        lines.append("## 自然用记忆榜")
        lines.append(f"- A = {f(nat['A'])}，区间 {f(nat['ci'][0]) if nat['ci'] else '—'}–{f(nat['ci'][1]) if nat['ci'] else '—'}；"
                     f"R {f(nat['R'])} / P {f(nat['P'])}；{nat['n_items']} 条探针")
        lines.append(f"- 想起率 {f(nat['recall'])}%，克制率 {f(nat['restraint'])}%，编造率 {f(nat['fabrication'])}%，"
                     f"对冲合格 {f(nat['hedge'])}%，自然度 {f(nat['naturalness'])}，底线 {'达标' if nat['floor_ok'] else '不达标'}")
        lines.append(f"- 分类：{', '.join(f'{k} {f(v)}' for k, v in (nat['by_class'] or {}).items())}")
        lines.append(f"- C = ¥{nat['C_full']:.4f}；同口径（按 {ref_nat['n_probes_run']}/{nat['n_items']} 折算）¥{nat['C_cmp']:.4f}")
        lines.append(f"- S（全量）= {f(nat['S_full'])}；S（同口径）= {f(nat['S_cmp'])}")
        lines.append(f"- 泄漏 {len(nat['leaks'] or [])}，尾段污染 {nat['contam']}；X 诊断 {json.dumps(nat['x_diagnostics'], ensure_ascii=False)}")
        lines.append("")
        sh, lo = out["boards"]["M01"], out["boards"]["M02"]
        for tag, key in (("全量口径", "S_full"), ("同口径", "S_cmp")):
            comp = 0.25 * sh[key] + 0.25 * lo[key] + 0.5 * nat[key]
            out["composite"][key] = comp
            lines.append(f"## 总排名（{tag}）：{comp:.2f}")
    text = "\n".join(lines)
    print(text)
    outdir = os.path.join(ROOT, "runs", "bench22", a.run, "report")
    os.makedirs(outdir, exist_ok=True)
    json.dump(out, open(os.path.join(outdir, "namiso-summary.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1, default=str)
    if a.out:
        open(a.out, "w", encoding="utf-8").write(text + "\n")


if __name__ == "__main__":
    main()
