# -*- coding: utf-8 -*-
"""Run the official Bench 2.2 natural board with the Namiso system registered.

Same CLI as `python -m bench22.natural`.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
HARNESS = r"D:\AI\chat-memory-benchmark\benchmark-2.2\harness"
for path in (HARNESS, HERE):
    if path not in sys.path:
        sys.path.insert(0, path)

from bench22 import natural, systems  # noqa: E402
from namiso_system import NamisoSystem  # noqa: E402

systems.REGISTRY["namiso"] = NamisoSystem
natural.REGISTRY = systems.REGISTRY

if __name__ == "__main__":
    natural.main()
