# Namiso

[English](README.md)

Namiso 是一个独立的 AI 长期记忆引擎。它保留原始对话，从中抽取持久的事实与事件，把每条结构化记忆关联回原始消息，并返回有预算、有依据的上下文给 agent 使用。

Namiso 是库，不是 agent 运行时。它不规划、不调用工具、不调度消息，也不提供 HTTP 服务。它负责对话历史、记忆空间、抽取、证据、索引、检索和上下文组装。agent、模型服务和产品策略由你提供。

## 为什么需要 Namiso

大多数聊天记忆只是把旧消息做成搜索框。Namiso 在原始消息之上增加一层结构化记忆：

- 原始消息只追加，始终可搜索。
- 事实和事件由消息抽取而来，而不是在读取时让另一个模型临时编造。
- 每条事实和事件都保留证据链接，检索到的事实可以追溯到当时到底说了什么。
- 当前状态是显式的。新事实可以取代或冲突旧事实，但历史不会被删除。
- 检索同时覆盖原始消息和结构化记忆，需要时两路一起返回。
- 引擎自包含。默认 provider 完全离线，模型服务通过接口接入。

## 安装

```bash
npm install @kmchai/namiso
```

需要 Node.js 24 或更新版本。包是 ESM，使用 Node 内置的 `node:sqlite`。数据存在本地 SQLite 文件，不需要额外服务。

## 快速开始

```ts
import { Namiso } from '@kmchai/namiso'

const memory = await Namiso.open({
  databasePath: './memory.db',
  memorySpace: { name: 'assistant' },
  self: {
    name: 'Aster',
    aliases: ['Ast'],
    description: '一个会跨会话记住用户的长期助手。',
  },
})

const conversation = memory.createConversation({ title: '第一次会话' })

await memory.ingest({
  conversationId: conversation.id,
  speakerId: 'user',
  role: 'user',
  content: '我用 IndexTTS2 做语音生成。',
})

await memory.drain()
await memory.consolidate()

const context = await memory.getContext({
  query: '我用的是哪个语音模型？',
})

console.log(context.text)
memory.close()
```

`drain()` 生成对话 chunk 和索引，不调用抽取模型。`consolidate()` 对未处理的批量消息执行抽取，每批一次 provider 调用。它必须显式调用，因为模型调用有成本和时间开销。适合在会话结束时、上下文压缩前，或由应用自己的调度器触发。

## 核心概念

一个 **workspace** 包含一个或多个 **memory space**。所有读写都限定在一个 memory space 内。

一个 **conversation** 是按时间追加的消息序列。消息保留说话人、角色、内容、发生时间和可选 metadata。

结构化记忆由消息派生：

- **Entity** 是对话中提到的人、地点、物品、项目等，可以有别名。
- **Claim** 是关于 entity 的持久事实，例如偏好、持有物、关系或计划。Claim 有状态，新事实可以取代旧事实。
- **Event** 是发生过的事，带参与者、时间和证据。源消息支持时可精确到日或具体时间。
- **Evidence** 把 claim 或 event 关联回支持它的消息。
- **Link** 记录 `supersedes`、`updates`、`contradicts`、`continues`、`caused_by`、`derived_from`、`related_to`、`same_as` 等关系。

每个 memory space 有一个助手 **self entity**。类型 `self` 只属于它。助手说话人会解析到这个 entity，它的 description 保存人设或背景。

## 写入路径

1. `ingest()` 追加一条消息，并写入全文索引。不调用模型。
2. `drain()` 处理 chunk 和索引任务。
3. `consolidate()` 按 conversation 批量处理未抽取的消息，调用抽取 provider。
4. 抽取产生 entity、alias、claim、event。流水线解析日期、关联证据，在日期和参与者支持时合并重复事件，并把该批标记为已处理。
5. 结构化文档写入全文索引；有 embedding 时也写入向量索引。即使 embedding 失败，原始消息全文索引也已经写入。

抽取失败时该批保持待处理。再次调用 `consolidate()` 会重试。一个数据库文件只能由一个进程写。不要让两个进程同时打开同一个文件写入。

## 读取路径

`retrieve()` 返回排序后的候选和 trace。`getContext()` 在检索之后组装可读、带 token 预算的上下文。

1. 解析 query，识别提到的 entity，解释相对时间。
2. 通过 SQL、全文检索和向量通道搜索结构化记忆与原始消息。
3. 用 Reciprocal Rank Fusion 融合各通道排名。
4. 对靠前的候选 rerank，再应用当前状态和时间过滤。
5. 在请求预算内扩展关联记录和证据。
6. 选择与 query 匹配的证据消息，再填充剩余位置。
7. 按软 token 目标组装分段。先缩短摘录，再丢弃记录；无法满足目标时 `overBudget` 会标记。

原始消息全文检索是一等通道。即使抽取没有把某条事实写成 claim 或 event，它仍然可能被搜到。`RetrieveResult.evidence` 返回最多四条原始消息命中，可传给 `getContext()`。

可选检索能力默认关闭或可配置：

- `chunkExpansion` 把 chunk 命中展开成消息候选，默认开启。
- `multiHop` 用 bridge term 扩展消息种子，可接入 evidence judge，默认关闭。
- `salientProfile` 对“怎么做/如何”这类问题补入强相关 entity 和它的近期事件，默认关闭。
- `evidenceJudge` 接收 SystemOne 兼容的 provider，用于 multi-hop 证据打分。

## 公共 API

| 方法                                                               | 用途                                         |
| ------------------------------------------------------------------ | -------------------------------------------- |
| `Namiso.open(options)`                                             | 打开数据库，绑定 workspace 和 memory space   |
| `createConversation()`、`getConversation()`、`listConversations()` | 管理会话                                     |
| `getMessages()`                                                    | 按索引、时间和数量读取消息                   |
| `ingest()`                                                         | 追加一条消息；带 `externalMessageId` 时幂等  |
| `drain()`                                                          | 处理 chunk 和索引任务                        |
| `consolidate()`                                                    | 抽取待处理消息；每批一次 provider 调用       |
| `retrieve()`                                                       | 返回排序候选、原始证据和 trace               |
| `getContext()`                                                     | 返回有预算、分段的记忆上下文                 |
| `upcomingEvents()`                                                 | 返回指定日期范围内的有效事件，供插件层做提醒 |
| `timeline()`                                                       | 按时间返回某个 entity 的事件                 |
| `getEntityDetails()`、`getEventDetails()`、`getClaimDetails()`     | 读取记录及其证据和链接                       |
| `ensureSelf()`、`ensureEntity()`                                   | 创建或更新 self entity 或命名 entity         |
| `link()`                                                           | 手动建立记忆记录之间的关系                   |
| `forget()`                                                         | 删除消息、会话、entity 或 event，并清理索引  |
| `reindex()`                                                        | 重建该 space 的文档、全文索引和向量          |
| `retryJobs()`                                                      | 重试失败的 job                               |
| `health()`                                                         | 返回计数、job、向量后端、provider 和警告     |
| `close()`                                                          | 关闭数据库                                   |

签名、选项和返回类型见 [spec/api.md](spec/api.md)。中文版接口文档尚未单独维护，以英文 spec 为准。

## Provider

默认栈离线且确定：

| 槽位      | 默认实现                 | 说明                                |
| --------- | ------------------------ | ----------------------------------- |
| 抽取      | `RuleExtractionProvider` | 基于规则的抽取，适合测试和小型 demo |
| Embedding | `HashEmbeddingProvider`  | 确定性特征哈希，不是语义模型        |
| Reranker  | `LexicalReranker`        | 基于 token 重叠打分                 |

生产环境应传入 LLM 抽取 provider 和真实的 embedding 模型。`HttpExtractionProvider`、`HttpEmbeddingProvider`、`HttpRerankerProvider` 接受 OpenAI 兼容端点。`SystemOneEvidenceJudge` 为 multi-hop 检索提供可选的证据判断器。

```ts
import { Namiso, providersFromEnv } from '@kmchai/namiso'

const memory = await Namiso.open({
  databasePath: './memory.db',
  ...providersFromEnv(process.env),
})
```

`providersFromEnv()` 读取 [.env.example](.env.example) 中记录的环境变量。端点 URL 和模型名必须同时设置。Embedding 还需要 `NAMISO_EMBEDDING_DIMENSIONS` 与模型输出维度一致。空变量会被忽略，因此未配置时仍使用离线默认实现。

## 配置

| 选项                                 | 默认值                    | 说明                                          |
| ------------------------------------ | ------------------------- | --------------------------------------------- |
| `databasePath`                       | 必填                      | 测试可用 `:memory:`                           |
| `workspace.id`、`workspace.name`     | 自动生成、`default`       | 优先按 ID 复用，否则按名称                    |
| `memorySpace.id`、`memorySpace.name` | 自动生成、`default`       | 优先按 ID 复用，否则按 workspace 内名称       |
| `embedding`                          | `HashEmbeddingProvider`   | 同一数据库的维度必须稳定                      |
| `extraction`                         | `RuleExtractionProvider`  | 生产环境应换成 LLM provider                   |
| `reranker`                           | `LexicalReranker`         | 单次查询可设 `rerank: false` 跳过             |
| `evidenceJudge`                      | 未设置                    | 可选的 multi-hop 证据判断器                   |
| `salientProfile`                     | `false`                   | 为过程/建议类问题补入强相关 entity 和近期事件 |
| `chunkExpansion`                     | `true`                    | 把 chunk 命中展开成消息候选                   |
| `extractRoles`                       | `['user', 'assistant']`   | 送入抽取的角色                                |
| `knownFacts`                         | `false`                   | 把当前事实送给抽取，用于判断变化              |
| `self`                               | 未设置                    | 助手身份：名称、别名、描述                    |
| `vectorIndex`                        | `auto`                    | `auto`、`sqlite-vec` 或 `exact`               |
| `chunking`                           | `{ size: 8, overlap: 2 }` | size 1 到 64；overlap 必须更小                |

## 设计保证

- 原始消息只追加。结构化记忆是派生数据，可以重建。
- 抽取是显式的。`ingest()` 永不调用模型。
- 每条 claim 和 event 至少关联一条证据消息。
- 当前事实和历史事实是分开的状态。替换事实时通过状态和链接保留历史。
- 所有读写都限定在一个 memory space 内。
- 每个 space 只有一个助手 self entity。
- 全文索引和向量索引是派生数据，`reindex()` 可以重建。
- 核心代码不 import agent harness、模型 SDK 或特定厂商。
- 默认 provider 不发起网络请求。

## Benchmark

仓库包含两层 benchmark：

- `bench/run.ts` 读取 [Ornn8/chat-memory-benchmark](https://github.com/Ornn8/chat-memory-benchmark) 的 JSONL 格式，衡量问题对应的证据消息是否出现在返回的上下文中。它不调用答题模型。
- `bench/b22` 把引擎接入 benchmark-2.2，覆盖 exam 和 natural 两个 split、答题、判分、成本统计和插件边界。见 [bench/b22/README.md](bench/b22/README.md)。

```bash
# 本地 fixture
pnpm bench

# 公开 demo
node bench/run.ts --dataset ../chat-memory-benchmark/demo --out bench/out/demo

# 正式数据集，接真实 provider
node bench/run.ts --dataset ../chat-memory-benchmark/datasets/natural-timegrid-20261101-v2 \
  --models --out bench/out/formal
```

Benchmark 数字取决于数据集、provider 栈、prompt、答题模型和 judge。历史运行和注意事项见 [spec/benchmark.md](spec/benchmark.md)。不要把 evidence recall 和端到端答题分直接比较。

## 项目结构

```text
src/
  namiso.ts            公共 facade
  types.ts             领域类型和 branded ID
  storage/             SQLite schema、repository、FTS 和向量存储
  ingestion/           消息写入、job、chunking
  annotation/          抽取流水线、entity 解析、链接
  indexing/            检索文档、embedding 同步、重建
  retrieval/           query 解析、通道、融合、rerank、扩展
  context/             记忆上下文组装和预算
  providers/           抽取、embedding、reranker、证据判断器
  admin/               遗忘和索引重建
spec/                  模块文档，按需阅读
test/                  Vitest 测试
bench/                 检索 benchmark 和 benchmark-2.2 adapter
```

## 文档

- [spec/README.md](spec/README.md) 是模块文档索引。
- [spec/api.md](spec/api.md) 是公共 API 参考。
- [spec/architecture.md](spec/architecture.md) 说明模块边界和数据流。
- [spec/plugin.md](spec/plugin.md) 说明哪些职责属于宿主应用。
- [spec/providers.md](spec/providers.md) 说明模型 provider。
- [spec/benchmark.md](spec/benchmark.md) 说明检索 benchmark。
- [AGENTS.md](AGENTS.md) 是贡献者约定。

## 状态与限制

Namiso 当前是 `0.1.0`。`1.0` 之前公共 API 可能变化。

它不是 HTTP 服务、后台 daemon 或多进程队列。一个进程独占一个数据库文件。它不运行 agent、不调度消息，也不决定产品策略。到期提醒和 benchmark 答题规则属于插件层。

除非调用 `forget()`，原始消息会一直保留。配置远程 provider 时，消息内容和记忆上下文会发送到对应端点。私有或受监管数据需要自行评估。

## 开发

```bash
pnpm install
pnpm test
pnpm build
pnpm verify
```

`pnpm verify` 会运行 type-aware lint、格式检查、测试和构建。测试默认使用内存数据库。真实模型集成测试是 opt-in，只有设置 `NAMISO_RUN_MODEL_TESTS=1` 才会运行。

## License

MIT。
