# -*- coding: utf-8 -*-
"""Token + cost accounting for the local Bench 2.2 run.

Reads the detail ledgers written by bench/b22/gateway.py and reports, per stage:
calls, prompt tokens, cache-hit tokens, cache-miss tokens, output tokens,
reasoning tokens, seconds.

Two prices are reported for the same token counts:
  list  = harness prices.json (the challenge's own price list, CNY/Mtok)
  offpeak = DeepSeek off-peak list price in USD converted at 7.2 CNY/USD, which
            charges cache hits and cache misses at different input prices.
"""
import argparse
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")

HARNESS = r"D:\AI\chat-memory-benchmark\benchmark-2.2\harness"
PRICES = json.load(open(os.path.join(HARNESS, "bench22", "prices.json"), encoding="utf-8"))
USD_CNY = PRICES["usd_cny"]

# DeepSeek V4.1 Flash list price, USD per 1M tokens.
PEAK = {"hit": 0.006, "miss": 0.30, "output": 1.20}
OFFPEAK = {"hit": 0.003, "miss": 0.15, "output": 0.60}

STAGES = ["ingest", "retrieve", "answer", "judge"]


def load(path, run, board=None):
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as handle:
        rows = [json.loads(line) for line in handle if line.strip()]
    out = []
    for row in rows:
        if row.get("run") != run:
            continue
        is_natural = ":natural-" in (row.get("system") or "")
        if board == "exam" and is_natural:
            continue
        if board == "natural" and not is_natural:
            continue
        out.append(row)
    return out


def price_list(route, tin, tout):
    key = {"chat": "deepseek-v4.1-flash", "embed": "qwen3.7-text-embedding", "rerank": "qwen3.7-text-rerank"}[route]
    spec = PRICES["models"][key]
    return (tin * spec["in_per_mtok"] + tout * spec.get("out_per_mtok", 0)) / 1e6


def price_offpeak(route, hit, miss, out):
    if route != "chat":
        return 0.0
    return (hit * OFFPEAK["hit"] + miss * OFFPEAK["miss"] + out * OFFPEAK["output"]) / 1e6 * USD_CNY


def price_peak(route, hit, miss, out):
    if route != "chat":
        return 0.0
    return (hit * PEAK["hit"] + miss * PEAK["miss"] + out * PEAK["output"]) / 1e6 * USD_CNY


def summarize(rows):
    buckets = {}
    for row in rows:
        key = (row["phase"], row["route"])
        b = buckets.setdefault(key, {"calls": 0, "in": 0, "hit": 0, "miss": 0, "out": 0, "rsn": 0, "sec": 0.0,
                                     "list": 0.0, "offpeak": 0.0, "peak": 0.0})
        b["calls"] += 1
        b["in"] += row["prompt_tokens"]
        b["hit"] += row["cache_hit_tokens"]
        b["miss"] += row["cache_miss_tokens"]
        b["out"] += row["completion_tokens"]
        b["rsn"] += row.get("reasoning_tokens") or 0
        b["sec"] += row.get("seconds") or 0
        b["list"] += price_list(row["route"], row["prompt_tokens"], row["completion_tokens"])
        b["offpeak"] += price_offpeak(row["route"], row["cache_hit_tokens"], row["cache_miss_tokens"], row["completion_tokens"])
        b["peak"] += price_peak(row["route"], row["cache_hit_tokens"], row["cache_miss_tokens"], row["completion_tokens"])
    return buckets


def report(title, rows, sink):
    if not rows:
        sink.append(f"\n## {title}: no calls")
        return None
    buckets = summarize(rows)
    sink.append(f"\n## {title}")
    sink.append("| stage | route | calls | prompt | cache hit | cache miss | output | reasoning | 秒 | 挑战价 ¥ | 谷价 ¥ | 峰价 ¥ |")
    sink.append("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    order = {s: n for n, s in enumerate(STAGES)}
    total = {"calls": 0, "in": 0, "hit": 0, "miss": 0, "out": 0, "rsn": 0, "sec": 0.0, "list": 0.0, "offpeak": 0.0, "peak": 0.0}
    for key in sorted(buckets, key=lambda k: (order.get(k[0], 9), k[1])):
        b = buckets[key]
        sink.append(f"| {key[0]} | {key[1]} | {b['calls']:,} | {b['in']:,} | {b['hit']:,} | {b['miss']:,} | {b['out']:,} | {b['rsn']:,} | {b['sec']:.0f} | "
                    f"{b['list']:.4f} | {b['offpeak']:.4f} | {b['peak']:.4f} |")
        for name in total:
            total[name] += b[name]
    sink.append(f"| **合计** | | {total['calls']:,} | {total['in']:,} | {total['hit']:,} | {total['miss']:,} | {total['out']:,} | {total['rsn']:,} | "
                f"{total['sec']:.0f} | **{total['list']:.4f}** | **{total['offpeak']:.4f}** | **{total['peak']:.4f}** |")
    return total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default="b22", help="run name to bill (rows are filtered on it)")
    ap.add_argument("--detail-run", default="b22", help="detail ledger directory (gateway --run), defaults to b22")
    ap.add_argument("--out", default="", help="also write the report to this markdown file")
    a = ap.parse_args()
    base = os.path.join(HARNESS, "runs", "bench22", "detail", a.detail_run)
    exam = load(os.path.join(base, "exam-calls.jsonl"), a.run, "exam")
    natural = load(os.path.join(base, "natural-calls.jsonl"), a.run, "natural") + load(
        os.path.join(base, "exam-calls.jsonl"), a.run, "natural"
    )
    sink = [f"# Bench 2.2 本地 run `{a.run}` — token 用量与计费",
            f"\n价目：挑战价 = harness prices.json ({PRICES['version']})，嵌入/重排按 qwen3.7 单价计；"
            f"谷价 = DeepSeek V4.1 Flash 闲时价（命中 ${OFFPEAK['hit']}/M、未命中 ${OFFPEAK['miss']}/M、输出 ${OFFPEAK['output']}/M）"
            f"× {USD_CNY} 汇率；本地嵌入/重排无 API 费用，谷价里按 0 计。"]
    t1 = report("考试榜（exam）", exam, sink)
    t2 = report("自然用记忆榜（natural）", natural, sink)
    if t1 and t2:
        sink.append("\n## 全量合计")
        for name, label in (("calls", "调用次数"), ("in", "prompt tokens"), ("hit", "命中缓存"), ("miss", "未命中缓存"),
                            ("out", "输出 tokens"), ("rsn", "其中思考 tokens")):
            sink.append(f"- {label}: {t1[name] + t2[name]:,}")
        sink.append(f"- 挑战价 ¥{t1['list'] + t2['list']:.4f}")
        sink.append(f"- 谷价 ¥{t1['offpeak'] + t2['offpeak']:.4f}")
        sink.append(f"- 峰价 ¥{t1['peak'] + t2['peak']:.4f}")
    text = "\n".join(sink)
    print(text)
    if a.out:
        open(a.out, "w", encoding="utf-8").write(text + "\n")


if __name__ == "__main__":
    main()
