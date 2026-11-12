# -*- coding: utf-8 -*-
"""Namiso as a Bench 2.2 system: thin HTTP client for the Node bridge.
"""
import json
import os
import threading
import time
import urllib.error
import urllib.request
import uuid

from bench22.systems import Retrieval, System


class NamisoSystem(System):
    name = "namiso"

    def __init__(self, gw):
        self.gw = gw
        self.base = os.environ.get("NAMISO_BRIDGE", "http://127.0.0.1:18878")
        self.sid = self._sid()
        self.persona = None
        self.split = None
        self.lock = threading.Lock()

    def _sid(self):
        raw = os.environ.get("NAMISO_SID_MAP", "")
        if raw:
            try:
                mapped = json.loads(raw).get(self.gw.system or "")
            except ValueError:
                mapped = None
            if mapped:
                return str(mapped)
        return uuid.uuid4().hex

    def _scope(self):
        parts = (self.gw.system or "").split(":")
        persona = parts[1] if len(parts) > 1 else "M01"
        tail = parts[2] if len(parts) > 2 else "dev"
        board = "natural" if tail.startswith("natural-") else "exam"
        split = tail.replace("natural-", "")
        return {"run": self.gw.run or "b22", "board": board, "split": split,
                "system": self.gw.system, "persona": persona}

    def _post(self, path, payload, timeout=3600):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        last = None
        for attempt in range(4):
            try:
                req = urllib.request.Request(self.base + path, data=data,
                                             headers={"Content-Type": "application/json"}, method="POST")
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    return json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as error:
                try:
                    body = error.read().decode("utf-8", "replace")[:800]
                except Exception:  # noqa: BLE001
                    body = ""
                last = "HTTP %s: %s" % (error.code, body)
            except Exception as error:  # noqa: BLE001
                last = "%s: %s" % (type(error).__name__, str(error)[:300])
            time.sleep(5)
        raise RuntimeError("bridge %s failed: %s" % (path, last))

    def ingest(self, turn):
        self._post("/ingest", {"sid": self.sid, "turn": turn})

    def retrieve(self, question, now, cutoff_turn, item_id=None):
        scope = self._scope()
        self.persona, self.split = scope["persona"], scope["split"]
        out = self._post("/retrieve", {"sid": self.sid, "question": question, "now": now,
                                       "scope": scope, "persona": scope["persona"],
                                       "cutoff_turn": cutoff_turn, "item_id": item_id})
        return Retrieval(out["prompt"], out["usedTurns"], out.get("meta") or {})

    def mark(self):
        return self._post("/mark", {"sid": self.sid})["token"]

    def rewind(self, token):
        self._post("/rewind", {"sid": self.sid, "token": token})

    def begin_tail(self):
        self._post("/begin_tail", {"sid": self.sid})
