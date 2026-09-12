# Benchmark and Performance Matrix

Measured 2026-07-29 · Gateway v0.9.0 · Deno 2.9.3 (V8 14.9.207.2-rusty) ·
PostgreSQL 18 (`pgvector/pgvector:0.8.5-pg18`) · Windows 10 host, 8 logical CPUs
/ 16 GB · Docker Desktop 29.6.2 (Linux containers, 8 CPUs visible).

Historical runs from 2026-07-13 and 2026-07-22 are preserved in the
[appendix](#appendix-historical-waves), which is where the pre-PostgreSQL
numbers now live. Everything above the appendix was measured on the current
tree.

## Two harnesses, two questions

`scripts/load-bench.ts` (`deno task test:load`) measures **end-to-end request
cost** and is the source of sections 1-5. `deno task bench` measures **single
pure functions** on the hot path, which is the one thing the load harness cannot
isolate; it is the source of section 6 (decision-log 78, superseding 76). Never
carry a number from one into a sentence about the other.

## Method

Two harness shapes for the end-to-end numbers in sections 1-5, because one shape
cannot answer both questions. Section 6 is a third shape and is described there.

**In-process.** Client, gateway, and mock upstream share a single Deno event
loop. This isolates gateway overhead from provider latency and is the right
shape for comparing one commit against another, which is what the measure-first
rule in decision-log 45 needs. It cannot measure process count: a multi-process
gateway cannot be hosted inside the load generator's own event loop.

**External target.** The load generator and the mock upstream run in a container
on the same Docker network as a real, already-running gateway, so the gateway is
a separate process tree with a real PostgreSQL behind it. Keeping the generator
inside the container network matters: driving it from the Windows host instead
put Docker Desktop's NAT hop in the measurement path and capped throughput
before the gateway did.

Latency is per request including full body drain. Unless stated otherwise N=3000
with a discarded warmup, and one request in five uses the SSE streaming path.

**Never compare a number from one shape against a number from the other.** The
container rows do strictly more work than the in-process rows (a real PostgreSQL
round trip, a real network hop to the upstream) and are only meaningful against
each other.

### Reproduce

```bash
# In-process, concurrency sweep
deno task test:load                                            # 500 / 50
deno run --allow-net --allow-env scripts/load-bench.ts 3000 100

# Streaming share: 0 = never, 1 = always, N = every Nth (default 5)
FROSTY_BENCH_STREAM_EVERY=0 deno run --allow-net --allow-env \
  scripts/load-bench.ts 3000 50

# External target: pin the mock upstream, point the gateway at it, then drive
FROSTY_BENCH_TARGET=http://frosty-bench:8080 \
FROSTY_BENCH_UPSTREAM_PORT=9099 \
  deno run --unstable-net --allow-net --allow-env scripts/load-bench.ts 3000 100
```

`FROSTY_BENCH_TARGET`, `FROSTY_BENCH_UPSTREAM_PORT`,
`FROSTY_BENCH_STREAM_EVERY`, `FROSTY_BENCH_MODEL`, and `FROSTY_BENCH_KEY` are
documented in the header of [`scripts/load-bench.ts`](../scripts/load-bench.ts).
The positional `load-bench.ts [requests] [concurrency]` contract is unchanged.
The mock upstream is served in both modes, and an external gateway only dials it
per request, so there is no start-order dependency.

## Matrix

### 1. Concurrency (in-process, mixed streaming)

| Concurrency | RPS        | p50       | p95       | p99       | max       | Failures |
| ----------- | ---------- | --------- | --------- | --------- | --------- | -------- |
| 1           | 670.5      | 1.14 ms   | 3.08 ms   | 4.91 ms   | 31.81 ms  | 0        |
| 10          | 669.6      | 12.68 ms  | 25.87 ms  | 38.58 ms  | 76.44 ms  | 0        |
| 50          | **1069.2** | 43.21 ms  | 66.25 ms  | 125.97 ms | 134.06 ms | 0        |
| 100         | 999.2      | 90.85 ms  | 139.86 ms | 258.55 ms | 288.32 ms | 0        |
| 200         | 821.4      | 200.98 ms | 575.61 ms | 727.06 ms | 803.17 ms | 0        |

Peak is at 50 concurrent. Past that, p50 grows almost linearly while throughput
falls: queue wait, not processing cost.

### 2. Streaming share (in-process)

| Concurrency | Non-streaming RPS | All-streaming RPS | Cost of streaming |
| ----------- | ----------------- | ----------------- | ----------------- |
| 10          | 1035.0            | 953.1             | -8%               |
| 50          | 1005.0            | 818.1             | -19%              |
| 100         | 931.5             | 831.8             | -11%              |

p50 non-streaming / all-streaming: 8.40 / 9.28 ms at c=10, 43.26 / 52.76 ms at
c=50, 86.59 / 115.51 ms at c=100. Zero failures throughout. The passive tee
(`withStreamCompletion` + `StreamAccumulator`) is the cost here, and it is the
price of reconstructing the assistant message for plugins, cost, and logging
without buffering the client stream.

### 3. Process count (container, PostgreSQL state, log store ON)

This is the shipped default shape: `FROSTY_LOG_STORE=pg`. N=3000, c=100. Process
counts were confirmed inside the container: 1, 3, 5, 9 running
`apps/gateway/main.ts` = supervisor + N children.

| `FROSTY_WORKERS` | Serving procs | RPS       | p50       | p95       | p99       | max        | Failures |
| ---------------- | ------------- | --------- | --------- | --------- | --------- | ---------- | -------- |
| unset / 1        | 1             | 553.6     | 159.98 ms | 356.39 ms | 437.89 ms | 533.65 ms  | 0        |
| 2                | 1 + 2         | **732.0** | 121.15 ms | 268.59 ms | 390.99 ms | 490.25 ms  | 0        |
| 4                | 1 + 4         | 680.2     | 108.34 ms | 359.35 ms | 433.95 ms | 514.75 ms  | 0        |
| 8                | 1 + 8         | 419.1     | 169.69 ms | 602.83 ms | 792.08 ms | 1280.88 ms | 0        |

### 4. Durable log store on vs off (container)

Identical to section 3 with `FROSTY_LOG_STORE=off`. This isolates the cost of
the durable request-log write, which is a PostgreSQL round trip per request.

| `FROSTY_WORKERS` | Log store ON | Log store OFF  | Delta    |
| ---------------- | ------------ | -------------- | -------- |
| 1                | 553.6 rps    | **902.4 rps**  | **+63%** |
| 2                | 732.0 rps    | **1158.7 rps** | **+58%** |
| 4                | 680.2 rps    | **1153.7 rps** | **+70%** |

p50 with the store off: 95.62 ms (1 worker), 77.19 ms (2), 68.92 ms (4). Zero
failures.

### 5. Boot

| `FROSTY_WORKERS` | Container start to `/healthz` 200 |
| ---------------- | --------------------------------- |
| 1                | 1745 ms                           |
| 4                | 2469 ms                           |

Fan-out costs roughly 240 ms per worker at boot: each child opens its own
PostgreSQL pool and its own LISTEN connection.

### 6. Micro-benchmarks (`deno task bench`)

Six `*_bench.ts` files sit next to the source they measure. They are pure, need
no network, database, or gateway, and run in about 40 seconds. Run them with:

```bash
deno task bench                                     # everything
deno bench --unstable-net --allow-net --allow-env --allow-read \
  packages/core/src/translate_bench.ts              # one file
```

Numbers below are one run on the reference box (Deno 2.9.4, Intel i7-6700HQ,
Windows 10). **They are a comparison instrument, not a spec.** Re-run the suite
on the machine you are optimizing on, before and after the change, and apply
decision-log 45: a win inside run-to-run variance is rejected.

**Cache key projection** (`packages/cache/src/semantic_bench.ts`,
`store_bench.ts`). `keyFor` runs on every cacheable request; `digestKey` runs
only when a shared L2 tier is attached.

| Benchmark                                  | time/iter | iter/s    |
| ------------------------------------------ | --------- | --------- |
| `keyFor`, 2-message request                | 625.0 ns  | 1,600,000 |
| `keyFor`, 21-message thread + 2 tools      | 9.9 µs    | 101,200   |
| `keyFor`, same thread, excludeSystemPrompt | 10.5 µs   | 95,220    |
| `promptText`, 21-message thread            | 1.4 µs    | 718,500   |
| `digestKey`, 120-byte key                  | 54.9 µs   | 18,220    |
| `digestKey`, 37 KB key                     | 265.7 µs  | 3,764     |

**Governance admission** (`packages/governance/src/virtual_keys_bench.ts`).
`check` is the synchronous half of the admission path, once per governed
request.

| Benchmark                                       | time/iter | iter/s      |
| ----------------------------------------------- | --------- | ----------- |
| `check`, admit (hash, lookup, budgets, windows) | 3.2 µs    | 316,300     |
| `check`, reject unknown token                   | 2.4 µs    | 409,400     |
| `hashVirtualKeyToken` alone                     | 2.1 µs    | 474,000     |
| chars/4 token estimate, 6 KB body               | 8.2 ns    | 122,000,000 |
| `JSON.parse` model extraction, same 6 KB body   | 5.7 µs    | 176,900     |

**Stream translation and accumulation** (`packages/core/src/translate_bench.ts`,
`accumulate_bench.ts`). One iteration processes a whole 74-chunk response, not
one chunk.

| Benchmark                                           | time/iter | iter/s  |
| --------------------------------------------------- | --------- | ------- |
| identity passthrough, 74 chunks (Web Streams floor) | 119.6 µs  | 8,359   |
| Anthropic Messages, 74 chunks                       | 644.5 µs  | 1,551   |
| OpenAI Responses, 74 chunks                         | 629.2 µs  | 1,589   |
| Google GenAI, 74 chunks                             | 340.1 µs  | 2,941   |
| Cohere v2, 74 chunks                                | 369.2 µs  | 2,709   |
| legacy completions, 74 chunks                       | 372.5 µs  | 2,684   |
| `StreamAccumulator`, 67 text chunks                 | 2.0 µs    | 493,400 |
| `StreamAccumulator`, 15 tool-call chunks            | 1.5 µs    | 668,300 |

**Thinking-block translation.** Decision-log 79 gave `AnthropicStreamTranslator`
a thinking-block lifecycle for canonical reasoning deltas, and item 78 requires
a changed translator to carry a bench row. The base fixture has no `reasoning`
deltas, so without this case the path would ship unmeasured. Re-run on a quieter
machine than the table above, so compare the two rows to each other rather than
to the numbers above them.

| Benchmark                                        | time/iter | iter/s |
| ------------------------------------------------ | --------- | ------ |
| identity passthrough, 74 chunks (floor)          | 93.3 µs   | 10,720 |
| Anthropic Messages, 74 chunks                    | 293.4 µs  | 3,408  |
| Anthropic Messages + thinking blocks, 106 chunks | 473.8 µs  | 2,111  |

Per chunk that is 3.96 µs without reasoning deltas and 4.47 µs with them: the
extra wall-clock is the extra 32 chunks, not a per-chunk regression, so the
thinking-block lifecycle costs about what an equivalent text block costs. Well
inside the noise band item 45 requires a win to clear, which is the point - this
row exists to catch a future regression, not to claim a gain.

**State key encoding** (`packages/config/src/store_bench.ts`). `keyId` runs on
every durable read, write, and counter operation; `hasPrefix` and `compareKeys`
run per candidate row inside a prefix listing.

| Benchmark                     | time/iter | iter/s     |
| ----------------------------- | --------- | ---------- |
| `keyId`, 3-part path          | 213.2 ns  | 4,690,000  |
| `keyId`, 5-part path          | 288.7 ns  | 3,464,000  |
| `hasPrefix`, 5-part vs 3-part | 48.0 ns   | 20,850,000 |
| `compareKeys`, two 5-part     | 48.9 ns   | 20,460,000 |

What section 6 says:

- **Nothing on the pure hot path is worth optimizing.** The most expensive
  per-request pure function measured is `keyFor` on a 21-message thread at ~10
  µs, against a p50 of 1.14 ms for a whole in-process request (section 1) and
  100 ms to 10 s for a real upstream call. Governance admission is 3.2 µs, which
  independently reproduces the "~0.1 ms" end-to-end result from the 2026-07-22
  addendum below.
- **The translators are dominated by Web Streams plumbing, not by translation.**
  The identity-passthrough baseline is 119.6 µs of every translator's 340-645 µs
  over the same 74 chunks. The spread _between_ translators moved by more than
  2x across repeat runs on this box, so treat it as noise; the plumbing floor is
  the finding. Anyone proposing a faster translator should first check whether
  they are proposing a faster `TransformStream`.
- **The `chars/4` estimate is free; the parse next to it is not.** 8.2 ns
  against 5.7 µs for the `JSON.parse` the same middleware does to recover the
  requested model, roughly 700x. Replacing the estimate with a real tokenizer
  would be a correctness argument, never a performance one.
- **Token hashing is most of admission.** 2.1 µs of the 3.2 µs `check` is the
  SHA-256 of the bearer token. That is the deliberate cost of never storing a
  raw token, and it is not a candidate for removal.
- **`digestKey` is the one L2 cost worth knowing.** 54.9 µs for a small key, and
  it is paid twice per request (read and write) when a shared tier is attached.
  This is why L1 keeps using the raw string and never hashes.

## What the numbers mean

**The durable log store is the throughput ceiling, not the gateway.** Turning it
off is worth 58-70% across every process count. It is on by default
(`FROSTY_LOG_STORE=pg`), which is the right default - the dashboard trail is the
product - but an operator who needs throughput more than history has one knob
that moves more than anything else in this document.

**Fan-out buys about one doubling on this box, and the knee is early.** One to
two workers is +32% with the log store on and +28% with it off. Two to four is
flat. Eight workers is _worse than one_. With 8 logical CPUs shared between the
gateway, PostgreSQL, and the in-network load generator, 8 workers oversubscribes
the machine, and the p99 and max columns show it: 792 ms and 1281 ms against 438
ms and 534 ms at a single worker. The transferable result is the shape, not the
peak: set `FROSTY_WORKERS` well below core count when the database and the load
source are co-resident, and measure rather than assuming N cores means N
workers.

**Latency under load is queuing, not work.** p50 tracks concurrency almost
linearly while throughput plateaus, in both harness shapes. That is Little's Law
queue wait, and it reproduces the conclusion the 2026-07-22 addendum reached on
the pre-PostgreSQL backend: there is no per-request hot-path bottleneck.

**Streaming costs 8-19%,** and the cost grows with concurrency.

**Nothing failed.** Zero failed requests across every run in every section, at
up to 200 concurrent connections and up to 9 processes.

## Not measured, and why

- **Real provider latency and throughput.** Network-dominated and
  provider-specific. A real LLM call is 100 ms to 10 s upstream, which is one to
  four orders of magnitude above anything in this document.
- **Separate replicas behind a load balancer,** as opposed to workers sharing a
  port. Note this is the topology where `FROSTY_SHARED_RATE_LIMIT=auto` cannot
  help: `auto` keys off `FROSTY_WORKERS`, which a second machine does not see.
  Set it to `on` explicitly. See [multi-process.md](guides/multi-process.md).
- **Long-haul soak and memory growth** over hours.
- **L1/L2 cache hit-path throughput.**
- **Host-native multi-process.** Windows has no SO_REUSEPORT, so `planCluster()`
  serves single-process by design and says so on the boot line. Every
  process-count row here is containerized.
- **PgBouncer under the `pgbouncer` profile.** The connection budget is
  `workers x FROSTY_PG_POOL_SIZE + workers`; the pooler is the escape hatch past
  `max_connections=200`, and it is untested for throughput here.

## Appendix: historical waves

Retained for the trend line. **These predate the PostgreSQL consolidation**
(decision-log 57, 61) and were measured against the retired Deno KV backend on
Deno 2.9.x. Their storage claims no longer describe the system; their latency
conclusions do.

### Waves 1-2, 2026-07-13

| Run             | Requests | Concurrency | RPS   | p50      | p95      | p99      | max      | Failures |
| --------------- | -------- | ----------- | ----- | -------- | -------- | -------- | -------- | -------- |
| Baseline        | 500      | 50          | 691.9 | 58.6 ms  | 180.3 ms | 185.1 ms | 190.8 ms | 0        |
| Stress          | 2000     | 100         | 679.3 | 117.5 ms | 224.3 ms | 627.7 ms | 672.4 ms | 0        |
| Wave-2 re-check | 500      | 50          | -     | 54.1 ms  | 150.4 ms | 156.0 ms | 163.8 ms | 0        |

Wave-2 re-check (post streaming/MCP/vector changes): latency held or improved at
every percentile with zero failures.

### Addendum 2026-07-22: governed hot-path profile

Differential profiling of the fully governed request path after the
hash-token/reserve-before-admit hardening, attributing latency by isolating one
factor at a time. In-process harness, mock upstream, N=3000 per stage.

Per-request cost, p50, single request in flight:

| Stage                             | End-to-end | Handler-direct |
| --------------------------------- | ---------- | -------------- |
| A · direct mock (HTTP floor)      | 0.18 ms    | -              |
| B · gateway, ungoverned, tiny     | 1.03 ms    | 0.51 ms        |
| C · gateway, **governed**, tiny   | 1.06 ms    | 0.61 ms        |
| D · gateway, governed, 200 KB     | 4.06 ms    | 2.37 ms        |
| Ds · gateway, governed, streaming | 1.23 ms    | -              |

Conclusions that still hold on the current backend:

- The full governance admission pipeline (hash lookup, hierarchy, scope,
  reserve, epoch admit, cost accounting) adds **~0.1 ms** (C minus B). That is
  under 1% of any real LLM call, so no hot-path optimization is warranted.
- The only input-scaling cost is body size, roughly 1.8 ms server-side per 200
  KB, dominated by the unavoidable read plus re-serialization. A measured
  parse-once optimization returned a win inside noise and was rejected under
  decision-log 45.

Conclusions that have since been overtaken:

- "The lever is horizontal scaling, which first requires externalizing the
  single-node KV state." That work shipped: state is in PostgreSQL, budgets and
  rate-limit windows are fleet-wide, and section 3 above measures the result.

### Packaging verification, 2026-07-13 (not re-run)

- **Docker**: image built, container booted, `/healthz` 200, schema validation
  live inside the container. The KV volume persistence noted at the time no
  longer applies - durable state is in the `postgres-data` volume.
- **`deno compile`**: 85.5 MB standalone executable, booted and served
  (`/healthz`, `/v1/models`). Caveats recorded then: the unstable flags and
  permission set are baked at compile time, and the same-origin UI needs
  `apps/control-ui/dist` next to the binary or falls back to API-only mode.
  **Not re-verified on the current tree**, and the flag set has changed
  (`--unstable-net` replaced `--unstable-kv`), so treat the size and the verdict
  as historical. A compiled binary now also needs a reachable `FROSTY_PG_URL`
  like every other run mode.

## Related

- [Running multiple processes](guides/multi-process.md) - what `FROSTY_WORKERS`
  does, where it does not work, and the connection budget.
- [TODO.md](../TODO.md) - the register that replaced the retired decision log.
  The numbers this report cites as provenance are items 45 (measure-first), 57
  and 61 (PostgreSQL), 62 (multi-process), 71 (shared rate limits) and 78 (the
  micro-benchmark suite, superseding 76); they no longer resolve to a file.
