# Plugin layer

Namiso owns memory. A plugin owns the product behavior around it.

## Responsibilities

The memory engine:

- stores append-only messages;
- extracts claims and events;
- links claims and events to evidence;
- retrieves structured memory and raw messages;
- builds a bounded, cited context;
- exposes `upcomingEvents()` for dated events.

The plugin:

- decides when to ingest and when to consolidate;
- assembles the final prompt, including system policy and recent turns;
- decides whether to remind the user about a dated event;
- chooses the answer model and generation settings;
- scores, judges, and reports results.

## Prompt assembly

Pass `getContext()` output to the answer model as the memory block. Keep the
rest of the prompt in the plugin. The engine contract covers evidence use and
missing records. Product rules, benchmark rules, and formatting rules do not
belong in the engine.

`bench/b22/bridge.ts` is the reference plugin. It appends
`BENCH_ANSWER_CONTRACT` as `【回答要求】` unless `NAMISO_BENCH_CONTRACT=0`.
That block is benchmark policy, not engine behavior.

## Reminders

Call `upcomingEvents()` with the user's time range, then decide whether the
current turn should mention the result. The engine does not inject reminders
into `getContext()`.

```ts
const due = memory.upcomingEvents({ from: now, to: now + 86_400 })
```

## Benchmark mapping

The benchmark layer maps its rules to engine features:

| Benchmark need              | Plugin action                                             |
| --------------------------- | --------------------------------------------------------- |
| Per-question history cutoff | Ingest only messages before `cutoff_turn`                 |
| Recent dialogue             | Append the last six turns after the memory block          |
| Due-day probe               | Call `upcomingEvents()` and add your reminder instruction |
| Answer policy               | Append your own contract after the memory block           |
| Cost accounting             | Count only engine calls the benchmark charges             |

Do not add benchmark-only fields to the engine API. If a behavior is useful to
other plugins, expose a primitive; otherwise keep it in the plugin.
