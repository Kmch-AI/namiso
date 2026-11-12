# Bench 2.2 · Namiso 本地跑法

官方仓库 `D:\AI\chat-memory-benchmark` 的 `benchmark-2.2` 只跑 dev 分片。为了让官方评分代码原样运行，Namiso 被包装成一个 `bench22.systems.System`，中间经过两个本地进程：

```text
python launch_runner.py / launch_natural.py       官方 runner / natural，未改动
        │  Gateway(HTTP, X-Bench-* 头)
        ▼
namiso_system.py  ──►  bridge.ts  :18902  ──►  Namiso（sqlite + 抽取/嵌入/重排）
                            │
                            └──►  gateway.py :18901  ──►  3425 chat / 8081 embedding / 8082 rerank
```

`gateway.py` 只做转发和记账，不改变答题、判分逻辑；`bridge.ts` 只负责 feed、检索、回滚。

## 与官方的差异（都已披露）

| 项                | 官方                           | 本次                                                                             | 原因                                         |
| ----------------- | ------------------------------ | -------------------------------------------------------------------------------- | -------------------------------------------- |
| 答题/判分思考强度 | `thinking:{"type":"disabled"}` | 默认强度（剥掉 `thinking`/`reasoning_effort`），`max_tokens` 提到 4096           | 用户要求                                     |
| 抽取思考强度      | 无（系统自定）                 | `reasoning_effort=none`                                                          | 用户要求                                     |
| 嵌入 / 重排       | qwen3.7 API                    | 本地 llama.cpp：Qwen3-Embedding-0.6B-Q8_0（1024 维）、Qwen3-Reranker-0.6B-Q4_K_M | 本地无 embedding/rerank 网关                 |
| 记忆文本成本      | 按 flash 输入价                | 同（prices.json 口径）                                                           | 与榜单可比                                   |
| 自然榜尾段        | 尾部真实写库后 `rewind`        | 尾段只留在 bridge 内存，`tailStart` 之后不落库                                   | 避免每个探针重建库；对模型可见内容与官方一致 |
| 分片              | dev + sealed                   | 只有 dev（sealed 未公开）                                                        | 仓库现状                                     |

## 计费口径

- **挑战价**：`harness/bench22/prices.json`（`prices-2.2.0`，CNY/Mtok），chat 按 flash 计，嵌入/重排按 qwen3.7 单价 0.5 计。这是榜单里 C 的算法。
- **谷价**：DeepSeek V4.1 Flash 闲时价，USD/Mtok：命中缓存 0.003、未命中 0.15、输出 0.60，按 7.2 汇率折 CNY。本地嵌入/重排无 API 费用，记 0。
- **峰价**：同一套 token 数按峰时价（0.006 / 0.30 / 1.20）复算，供对照。

token 明细来自 `gateway.py` 的 detail ledger：`prompt_tokens / cache_hit_tokens / cache_miss_tokens / completion_tokens / reasoning_tokens`，按 request 记录，再按 phase 汇总。

## 命令

```powershell
# 本地服务
llama-server -m ...\Qwen3-Embedding-0.6B-Q8_0.gguf --embeddings --pooling last --embd-normalize 2 --port 8081
llama-server -m ...\Qwen3-Reranker-0.6B.Q4_K_M.gguf --reranking --port 8082     # 不要加 --pooling
python bench/b22/gateway.py --port 18901 --run b22
node --env-file=.env bench/b22/bridge.ts                                        # BRIDGE_PORT=18902

# 考试榜
python bench/b22/launch_runner.py --release ..\dataset --system namiso --split dev --run b22 --gateway http://127.0.0.1:18901/v1 --workers 6
# 自然用记忆榜
python bench/b22/launch_natural.py run --release ..\dataset --natural ..\dataset\natural --system namiso --split dev --run b22 --gateway http://127.0.0.1:18901/v1
# 判分、汇总、报告
python bench/b22/finish.py
```

`finish.py` 依次执行：拆账本 → 自然榜 judge → summarize → `final_report.py` → `bill.py`。

## 产物

| 路径                                                  | 内容                                                              |
| ----------------------------------------------------- | ----------------------------------------------------------------- |
| `harness/runs/bench22/b22/namiso/dev/`                | `contexts.jsonl` `answers.jsonl` `judgments.jsonl` `summary.json` |
| `harness/runs/bench22/b22/namiso/natural-dev/`        | `turns.jsonl` `judgments.jsonl` `summary.json`                    |
| `harness/runs/bench22/spend-ledger.jsonl`             | 官方格式账单（考试榜）                                            |
| `harness/runs/bench22/natural/spend-ledger.jsonl`     | 官方格式账单（自然榜）                                            |
| `harness/runs/bench22/detail/b22/exam-calls.jsonl`    | 每次调用的 token 明细，含缓存命中/未命中/输出/思考                |
| `harness/runs/bench22/b22/report/namiso-summary.json` | 计分结果                                                          |
