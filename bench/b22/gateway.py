# -*- coding: utf-8 -*-
"""Bench 2.2 metering shim for the local Namiso run.

Routes
  /v1/chat/completions -> local model gateway (3425), eval key from D:\\AI\\Namiso\\.env
  /v1/embeddings       -> llama-server Qwen3-Embedding-0.6B Q8_0  (127.0.0.1:8081)
  /v1/rerank           -> llama-server Qwen3-Reranker-0.6B Q4_K_M (127.0.0.1:8082)

Reasoning policy requested by the user
  ingest (extraction): thinking disabled and reasoning_effort=none, forced here so the
    policy does not depend on the upstream provider. B22_EXTRACT_THINKING_BUDGET can
    re-enable a capped thinking budget for experiments.
  answer / judge / gen: thinking disabled and reasoning_effort=none. max_tokens is
    raised as a safety cap so a stray reasoning budget cannot eat the answer.

Ledgers
  official line format -> harness/runs/bench22[/natural]/spend-ledger.jsonl, priced with
    prices.json exactly like the evaluator gateway (chat at flash, embed/rerank at the
    qwen3.7 prices the reference system was billed)
  detail line format   -> harness/runs/bench22/detail/<run>/<board>-calls.jsonl with
    prompt / cache-hit / cache-miss / output / reasoning tokens for the off-peak bill
"""
import argparse
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HARNESS = r"D:\AI\chat-memory-benchmark\benchmark-2.2\harness"
NAMISO_ENV = r"D:\AI\Namiso\.env"
with open(os.path.join(HARNESS, "bench22", "prices.json"), encoding="utf-8") as _f:
    PRICES = json.load(_f)

CHAT_URL = os.environ.get("B22_CHAT_URL", "http://127.0.0.1:3425/v1/chat/completions")
EMBED_URL = os.environ.get("B22_EMBED_URL", "http://127.0.0.1:8081/v1/embeddings")
RERANK_URL = os.environ.get("B22_RERANK_URL", "http://127.0.0.1:8082/v1/rerank")

FLASH_MODEL = "workbuddy2api/cn:deepseek-v4.1-flash"
PRICE_CHAT = "deepseek-v4.1-flash"
PRICE_EMBED = "qwen3.7-text-embedding"
PRICE_RERANK = "qwen3.7-text-rerank"
REASONING_PHASES = ("answer", "judge", "gen", "review", "ingest")
DEFAULT_REASONING_MAX_TOKENS = int(os.environ.get("B22_REASONING_MAX_TOKENS", "8192"))
REASONING_MAX_CAP = 16384
EXTRACT_THINKING_BUDGET = int(os.environ.get("B22_EXTRACT_THINKING_BUDGET", "0"))


def read_env_key():
    with open(NAMISO_ENV, encoding="utf-8") as handle:
        for line in handle:
            if line.startswith("NAMISO_EXTRACTION_API_KEY="):
                return line.split("=", 1)[1].strip()
    raise RuntimeError("NAMISO_EXTRACTION_API_KEY missing from .env")


CHAT_KEY = read_env_key()


def price_cny(model, tin, tout):
    spec = PRICES["models"][model]
    return (tin * spec["in_per_mtok"] + tout * spec.get("out_per_mtok", 0)) / 1e6


def upstream(url, body, headers=None, timeout=900):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    hdr = {"Content-Type": "application/json"}
    hdr.update(headers or {})
    last = None
    for attempt in range(6):
        try:
            req = urllib.request.Request(url, data=data, headers=hdr, method="POST")
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")[:300]
            last = "HTTP %s: %s" % (error.code, detail)
            if error.code in (400, 401, 402, 403, 404, 422):
                raise RuntimeError(last)
        except Exception as error:  # noqa: BLE001
            last = "%s: %s" % (type(error).__name__, str(error)[:200])
        time.sleep(min(30, 2 ** attempt))
    raise RuntimeError("upstream failed: " + str(last))


def usage_fields(usage):
    usage = usage or {}
    details = usage.get("completion_tokens_details") or {}
    prompt = usage.get("prompt_tokens") or 0
    hit = usage.get("prompt_cache_hit_tokens")
    if hit is None:
        hit = (usage.get("prompt_tokens_details") or {}).get("cached_tokens") or 0
    miss = usage.get("prompt_cache_miss_tokens")
    if miss is None:
        miss = max(0, prompt - hit)
    return {
        "prompt_tokens": prompt,
        "cache_hit_tokens": int(hit),
        "cache_miss_tokens": int(miss),
        "completion_tokens": usage.get("completion_tokens") or 0,
        "reasoning_tokens": details.get("reasoning_tokens") or 0,
    }


class Ledger:
    def __init__(self, official_path, detail_path):
        self.official_path = official_path
        self.detail_path = detail_path
        for path in (official_path, detail_path):
            os.makedirs(os.path.dirname(path), exist_ok=True)
        self.lock = threading.Lock()

    def add(self, official, detail):
        official_line = json.dumps(official, ensure_ascii=False) + "\n"
        detail_line = json.dumps(detail, ensure_ascii=False) + "\n"
        with self.lock:
            with open(self.official_path, "a", encoding="utf-8") as handle:
                handle.write(official_line)
            with open(self.detail_path, "a", encoding="utf-8") as handle:
                handle.write(detail_line)


class State:
    exam_ledger = None
    natural_ledger = None
    stats = {"chat": 0, "embed": 0, "rerank": 0, "budget_raised": 0}

    @classmethod
    def ledger_for(cls, system):
        if ":natural-" in (system or ""):
            return cls.natural_ledger
        return cls.exam_ledger


def meta_from(headers, query):
    def pick(header, name, default=""):
        return headers.get(header) or query.get(name) or default

    return {
        "run": pick("X-Bench-Run", "run"),
        "system": pick("X-Bench-System", "system"),
        "phase": pick("X-Bench-Phase", "phase", "unknown"),
        "tag": pick("X-Bench-Tag", "tag"),
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        return

    def send_json(self, code, payload):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path.startswith("/v1/usage"):
            return self.send_json(200, {"stats": State.stats})
        self.send_json(404, {"error": "not found"})

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        query = {k.lower(): v for k, v in urllib.parse.parse_qsl(parsed.query)}
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except ValueError:
            return self.send_json(400, {"error": "bad json"})
        meta = meta_from(self.headers, query)
        started = time.time()
        try:
            if parsed.path == "/v1/chat/completions":
                out, fields, extra = self.chat(body, meta)
            elif parsed.path == "/v1/embeddings":
                out, fields, extra = self.embed(body)
            elif parsed.path == "/v1/rerank":
                out, fields, extra = self.rerank(body)
            else:
                return self.send_json(404, {"error": "unknown route"})
        except Exception as error:  # noqa: BLE001
            return self.send_json(502, {"error": str(error)[:400]})
        seconds = time.time() - started
        cost = price_cny(extra["price_model"], fields["prompt_tokens"], fields["completion_tokens"])
        official = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
            **meta,
            "entry": meta["phase"] in ("ingest", "retrieve"),
            "route": extra["route"],
            "model": extra["price_model"],
            "in_tokens": fields["prompt_tokens"],
            "out_tokens": fields["completion_tokens"],
            "cost_cny": round(cost, 8),
            "real_cny": round(cost, 8),
            "cached": False,
            "seconds": round(seconds, 3),
        }
        detail = {
            "ts": official["ts"],
            **meta,
            "route": extra["route"],
            "served_model": extra["served_model"],
            **fields,
            "cost_list_cny": round(cost, 8),
            "seconds": round(seconds, 3),
            "reasoning_forced_none": extra.get("reasoning_forced_none", False),
            "max_tokens": extra.get("max_tokens"),
        }
        State.ledger_for(meta["system"]).add(official, detail)
        State.stats[extra["route"]] += 1
        self.send_json(200, out)

    def chat(self, body, meta):
        payload = dict(body)
        payload["model"] = FLASH_MODEL
        forced_none = False
        if meta["phase"] in REASONING_PHASES:
            if meta["phase"] == "ingest" and EXTRACT_THINKING_BUDGET > 0:
                payload["thinking"] = {
                    "type": "enabled",
                    "budget_tokens": EXTRACT_THINKING_BUDGET,
                }
                payload.pop("reasoning_effort", None)
            else:
                payload["thinking"] = {"type": "disabled"}
                payload["reasoning_effort"] = "none"
            current = payload.get("max_tokens")
            if current is None or current < DEFAULT_REASONING_MAX_TOKENS:
                payload["max_tokens"] = DEFAULT_REASONING_MAX_TOKENS
                State.stats["budget_raised"] += 1
            forced_none = True
        out = upstream(CHAT_URL, payload, {"Authorization": "Bearer " + CHAT_KEY})
        used = [out.get("usage")]
        if forced_none:
            for _ in range(2):
                msg = (out.get("choices") or [{}])[0].get("message") or {}
                if (msg.get("content") or "").strip():
                    break
                if (out.get("choices") or [{}])[0].get("finish_reason") != "length":
                    break
                budget = min(REASONING_MAX_CAP, int(payload.get("max_tokens") or DEFAULT_REASONING_MAX_TOKENS) * 2)
                if budget <= int(payload.get("max_tokens") or 0):
                    break
                payload["max_tokens"] = budget
                State.stats["empty_reply_retry"] = State.stats.get("empty_reply_retry", 0) + 1
                out = upstream(CHAT_URL, payload, {"Authorization": "Bearer " + CHAT_KEY})
                used.append(out.get("usage"))
        fields = usage_fields(None)
        for u in used:
            f = usage_fields(u)
            for k, v in f.items():
                fields[k] += v
        extra = {
            "route": "chat",
            "served_model": FLASH_MODEL,
            "price_model": PRICE_CHAT,
            "reasoning_forced_none": forced_none,
            "max_tokens": payload.get("max_tokens"),
        }
        return out, fields, extra

    def embed(self, body):
        payload = {"model": body.get("model") or "Qwen3-Embedding-0.6B-Q8_0", "input": body["input"]}
        out = upstream(EMBED_URL, payload)
        usage = out.get("usage") or {}
        tokens = int(usage.get("prompt_tokens") or usage.get("total_tokens") or 0)
        fields = {
            "prompt_tokens": tokens,
            "cache_hit_tokens": 0,
            "cache_miss_tokens": tokens,
            "completion_tokens": 0,
            "reasoning_tokens": 0,
        }
        return out, fields, {
            "route": "embed",
            "served_model": "local:" + payload["model"],
            "price_model": PRICE_EMBED,
        }

    def rerank(self, body):
        documents = body["documents"]
        payload = {
            "model": body.get("model") or "Qwen3-Reranker-0.6B.Q4_K_M",
            "query": body["query"],
            "documents": documents,
            "top_n": body.get("top_n") or len(documents),
        }
        out = upstream(RERANK_URL, payload)
        usage = out.get("usage") or {}
        tokens = int(usage.get("prompt_tokens") or usage.get("total_tokens") or 0)
        fields = {
            "prompt_tokens": tokens,
            "cache_hit_tokens": 0,
            "cache_miss_tokens": tokens,
            "completion_tokens": 0,
            "reasoning_tokens": 0,
        }
        return out, fields, {
            "route": "rerank",
            "served_model": "local:" + payload["model"],
            "price_model": PRICE_RERANK,
        }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=18877)
    parser.add_argument("--run", default="b22")
    args = parser.parse_args()
    base = os.path.join(HARNESS, "runs", "bench22")
    State.exam_ledger = Ledger(
        os.path.join(base, "spend-ledger.jsonl"),
        os.path.join(base, "detail", args.run, "exam-calls.jsonl"),
    )
    State.natural_ledger = Ledger(
        os.path.join(base, "natural", "spend-ledger.jsonl"),
        os.path.join(base, "detail", args.run, "natural-calls.jsonl"),
    )
    print("shim gateway 127.0.0.1:%d" % args.port, flush=True)
    print("  exam ledger:   ", State.exam_ledger.official_path, flush=True)
    print("  natural ledger:", State.natural_ledger.official_path, flush=True)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
