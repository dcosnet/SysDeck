# TODO

Deliberate, known follow-ups. Each item names what is missing, why it was left,
and what has to move for it to be done.

This file used to be a **pointer** to two owning records - a numbered decision
log and an open-risks register. Both were retired on 2026-07-30 (item 1), and
this file is now **the register itself**: it is where a new deliberate
divergence gets recorded, and where a code comment points when its rationale is
too long to sit at the point of use. That raises the bar on what goes in it: an
entry needs the mechanism, the evidence in code, what "done" means, and the
trigger that reopens it, because there is no second document to carry the
rationale.

Two kinds of entry live here, and they are kept apart on purpose:

- **Open follow-ups** (the numbered items) - work that is not done. Their
  numbers are reading order and will change as items are added and closed, so
  **never cite an open item by number from code**.
- **[Decisions the code cites](#decisions-the-code-cites)** - closed decisions
  whose rationale a source comment depends on. Each carries a **stable key**
  such as `D-REBUILD-HEADERS`. Code cites the key, never a position, which is
  the one property the retired numbered scheme had and the reason it was citable
  at all.

Bare numbers such as "decision-log 57" that survive in comments or in
`CLAUDE.md` are **provenance only**: they record that a decision was taken and
where it was once written down. They resolve to nothing on disk, and four of
them resolve to nothing anywhere (item 1).

---

## 1. The decision log and open-risks register are retired, and 38 files still cite them

**Status: decided 2026-07-30 (owner: retirement accepted). Links and code
citations closed; four items' rationale is unrecoverable.**
`docs/contracts/decision-log.md` (50 448 B at HEAD) and
`docs/guides/open-risks.md` (23 279 B) were deleted from the working tree, along
with nine other `docs/contracts/*` files, `docs/guides/admin-api-cookbook.md`,
both `docs/runbooks/*` files and `docs/assets/architecture-diagram.md`. The
owner accepted the retirement rather than restoring from HEAD.

**Owner:** unassigned · **Severity:** Major · **Records:** this item

**What makes it work rather than a clean deletion.** The numbered scheme was
load-bearing. 38 files in the tree cite it, and not only docs:

| Citer                                                              | Was | Now                                        |
| ------------------------------------------------------------------ | --- | ------------------------------------------ |
| `CLAUDE.md`                                                        | 10  | 0 links, inline numbers kept as provenance |
| [apps/gateway/context.ts](apps/gateway/context.ts)                 | 4   | 0                                          |
| [packages/core/src/translate.ts](packages/core/src/translate.ts)   | 3   | 0                                          |
| [packages/core/src/middleware.ts](packages/core/src/middleware.ts) | 2   | 0                                          |
| `AGENTS.md`, `permissions.md`, tests, other docs                   | 19  | prose provenance only                      |

15 of those citations were **markdown links**, and were dead links, in
`CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `docs/benchmark-report.md` and this
file; all 15 are gone. The nine in the three source files above were prose
references of the form "(decision-log 71)" and are gone too - see below for what
that cost.

**Nine source citations, and only two carried content the comment did not.**
Reviewed one by one on 2026-07-30. Eight of the nine comments already stated the
constraint they cited, so the number was decoration and dropping it lost
nothing. The exception was `middleware.ts`, which said _"see decision-log 87 for
the three rebuild sites, the 15 affected routes and the accepted `serveDir`
consequence"_ - a forward reference to information held nowhere else. That
content is now [D-REBUILD-HEADERS](#d-rebuild-headers), re-verified against the
code rather than copied from memory, and the shared-rate-limit rationale is
[D-SHARED-RATE-LIMIT](#d-shared-rate-limit).

**Four items are gone for good: 14, 15, 69 and 79.** They were cited by
`translate.ts` (14, 15, 79) and `context.ts` (69). Each cited comment states its
own constraint, so no behavior is undocumented:

| Lost item | The constraint that survives, in the comment                                       |
| --------- | ---------------------------------------------------------------------------------- |
| 14        | a zero token count means "the provider never told us", never "known and discarded" |
| 15        | edge translators run AFTER the plugin stream tap, so hooks see the canonical shape |
| 69        | config reload applies REMOVALS, because an upsert-only reload cannot revoke        |
| 79        | one canonical execution path is what lets every ingress dialect share it           |

What is lost is the reasoning behind each, and any alternative that was
rejected. Reconstructing them would mean inventing rationale, so they are
recorded as lost rather than guessed at. If one of these four decisions is ever
reopened, treat it as undecided and re-derive it.

The retired revision is also not recoverable. HEAD holds an _older_ lineage: its
log is the original Wave-1..Wave-5 prose with no numbered entries at all (items
57, 68, 81 and 87 return zero hits) and its risk register stops at `R19`. The
numbered 1..87 log and `R20`..`R25` existed only in the uncommitted tree. There
is no stash, no `checkout`/`reset` in the reflog, and no editor local-history
copy.

**Consequence absorbed.** This file is the new home, and
[Decisions the code cites](#decisions-the-code-cites) is where a divergence
whose rationale a comment depends on gets recorded, keyed rather than numbered.
Work that planned to append entries 88-91 or risks R26-R27 records them there
instead, with a fresh key each, at the point the work lands rather than in
advance.

**Still open:**

- `docs/contracts/fixtures/` holds the two golden fixtures that
  [tests/contract/golden_chat_test.ts:28](tests/contract/golden_chat_test.ts#L28)
  reads at module load, and is now the only inhabitant of a retired directory.
  Moving it under `tests/contract/` would finish the retirement; it was left
  alone because the deletion of those two files is what made the suite red in
  the first place and re-touching them was not worth bundling into that repair.
- The bare numbers left inline in `CLAUDE.md` and in `permissions.md`, tests and
  other docs. They are provenance, not links, and are labelled as such in the
  preamble here.

**Reopen trigger:** a reader following a citation that resolves to nothing, or a
new divergence recorded as a bare number instead of a key.

## 2. Telemetry does not cost the media surfaces

**Status: done for the chat surfaces (2026-07-29); the media surfaces are
mid-build.** `INFERENCE_PATHS` is now an `isInferencePath()` predicate covering
the four canonical paths plus `/v1/messages`, `/cohere/v2/chat`, GenAI generate
actions, the Azure deployment-scoped ops and OpenRouter chat and embeddings,
with metrics, usage, spans and log enrichment widened together as required
below.

**Owner:** unassigned · **Severity:** Minor · **Records:** this item; provenance
decision-log 56 (the gap) and 81 (the chat-surface closure), open-risks R19

What is left is `/v1/images/generations`, `/v1/audio/speech` and
`/v1/audio/transcriptions`. They still need `normalizeUsage` and the pricing
catalog to model per-image, per-character and per-second billing before they can
be observed without producing counted-but-uncosted records.

| Route                      | Billing unit        |
| -------------------------- | ------------------- |
| `/v1/images/generations`   | per image           |
| `/v1/audio/speech`         | per character       |
| `/v1/audio/transcriptions` | per second of audio |

`/v1/batches`, `/v1/files`, `/v1/count_tokens` and `/v1/models` are correctly
outside the set: none is a per-request billable completion.

**Why it was left.** The log trail was wired to the telemetry layer that already
existed; that did not change what the layer observes. Widening the predicate
moves billing-adjacent accounting - usage records feed governance budgets and
the analytics rollups - which is a materially larger blast radius than a log
column.

**Done means:** metrics, usage records, spans and log enrichment all widen
**together**, not logs alone.

**Reopen trigger:** any request to observe a non-`/v1`-canonical inference
surface, or a report that spend on one of the routes above is missing from
`/api/analytics` or the Grafana dashboards.

## 3. `LOG_LEVEL` is documented and plumbed but read by nothing

**Status: OPEN.** `LOG_LEVEL` has a row in the quick-reference table of
[docs/reference/environment-variables.md](docs/reference/environment-variables.md)
and a mention under "Core gateway and PostgreSQL", and
[docker-compose.yml](docker-compose.yml) forwards it into the container. No code
reads it, on any file type. An operator setting `LOG_LEVEL=debug` gets silence.

**Owner:** unassigned · **Severity:** Minor · **Records:** this item

It was removed from `.env.example` in the 2026-07-30 env cleanup, because an
example file that lists a dead knob is the defect. The docs row and the Compose
passthrough still promise it.

**Done means:** either implement a bounded log-level parse and restore the
`.env.example` line, or drop the docs row and the Compose passthrough too.

**Reopen trigger:** a report that log verbosity cannot be changed.

## 4. `totalTokens` is an unclamped vendor sum

**Status: OPEN, narrowed.** In
[apps/gateway/routes/telemetry.ts:135](apps/gateway/routes/telemetry.ts#L135)
`totalTokens` is `prompt + completion + (cacheCreation ?? 0)` with no ceiling.
It reaches the usage record (`:159`, `:190`) and the `gen_ai.usage.total_tokens`
span attribute (`:216`). It never passes through `costMicroUsd`, so the clamp
that protects the cost counter does not cover it.

**Owner:** unassigned · **Severity:** Minor · **Records:** this item

A provider returning three fields at `MAX_SAFE_INTEGER` yields a usage row and a
span attribute of `3 x MAX_SAFE_INTEGER`. Money is unaffected.

**Done means:** the same bounded parse the cost path uses, applied **after** the
vendor sum rather than per field - clamping each field independently leaves
`2 x MAX_SAFE_INTEGER`, which is the measured failure of the per-field approach.

**Reopen trigger:** an implausible token total in `/api/analytics` or a Tempo
span.

## 5. Deliberate gaps that are still live

Each is a decision, not an oversight; the row is here so it stays visible. The
evidence column is the code that implements the refusal.

| Gap                                                | Shape                                  | Evidence                                                                               |
| -------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------- |
| OpenRouter native `GET /generation` and `GET /key` | Explicit 501                           | [openrouter_ingress.ts:171](apps/gateway/routes/openrouter_ingress.ts#L171)            |
| Aggregator-path Bedrock native ingress             | Explicit 501                           | [compat_families.ts:795](apps/gateway/routes/compat_families.ts#L795)                  |
| Serving a cache hit as a stream                    | Not implemented by design              | cache reads are non-streaming; completed streams are stored via the passive tee        |
| Code Mode executor                                 | Two gates, and the run primitive stubs | [packages/mcp/src/codemode/](packages/mcp/src/codemode/), `FROSTY_CODE_MODE`           |
| Kubernetes and Helm packaging                      | Not present                            | deployment assets are Docker and Compose only                                          |
| Some provider-panel config fields                  | Persisted and surfaced, not enforced   | field comments in [packages/contracts/src/config.ts](packages/contracts/src/config.ts) |

The authoritative version of this table is the "Gaps and partial
implementations" section of
[docs/concepts/functionality-and-capabilities.md](docs/concepts/functionality-and-capabilities.md).
Do not let the two drift; that file wins.

## 6. Multi-process serving has a residual per-process gap

**Status: shipped with a named residual.** `FROSTY_WORKERS` is live, and budgets
and rate-limit windows are fleet-wide through PostgreSQL. The residual gap is
per-process state that no shared authority covers.

**Owner:** unassigned · **Severity:** Info · **Records:** this item; provenance
decision-log 62, 70, 71 (the shipped behavior) and 73 (the residual)

**Reopen trigger:** an operator report of limit overshoot that shared-authority
rate limiting does not explain.

---

# Decisions the code cites

Closed decisions whose rationale a source comment depends on. Each has a
**stable key**; a comment cites the key and nothing else, so entries can be
added, split or reordered without invalidating a citation. A key is never reused
or renamed.

Only decisions a comment genuinely cannot carry inline belong here. If the
constraint fits in a note under four lines at the point of use, that is where it
goes and no entry is needed - which is why this section is short and is expected
to stay short.

## D-REBUILD-HEADERS

**Rebuilding a `Response` around a new body invalidates the headers that
describe the old one, so the serving boundary drops all three.**

`REBUILT_BODY_HEADERS` in
[packages/core/src/middleware.ts](packages/core/src/middleware.ts) is
`content-encoding`, `content-length`, `transfer-encoding`, matched lowercased.

Why each one:

- `Content-Encoding` - Deno's `fetch` decompresses transparently but **keeps the
  header**. A rebuild loses the internal already-decoded flag, so the header
  stops describing the bytes and becomes an instruction the client acts on and
  fails. This is the one that corrupted responses rather than merely
  mis-describing them.
- `Content-Length` - a provider's value describes the **encoded** bytes.
- `Transfer-Encoding` - hop-by-hop; the serving runtime owns framing.

**Three sites rebuild a `Response` around a replacement body. Two strip, one
deliberately does not:**

| Site                                                                              | Behavior                                                       |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [middleware.ts:90](packages/core/src/middleware.ts#L90) (`makeRequestLogger`)     | strips - this is the serving boundary                          |
| [routes/helpers.ts:147](apps/gateway/routes/helpers.ts#L147) (`rebuild`)          | strips                                                         |
| [providers/src/client.ts:171](packages/providers/src/client.ts#L171) (`withBody`) | does **not** strip, and is safe because of the placement below |

**The fix is at the serving boundary because that placement is terminal in both
directions.** `withBody` is INWARD of the request logger, so a stale header it
attaches is cleaned on the way out. `reshapeError`
([compat_families.ts:188](apps/gateway/routes/compat_families.ts#L188)) rebuilds
around a different body too, but lives inside `compatPrefixMiddleware`, which
`main.ts` composes OUTWARD of the logger - it is safe for the opposite reason,
because it copies headers the logger has already cleaned. A third header-copy at
[governance.ts:584](apps/gateway/routes/governance.ts#L584) reuses the _same_
body, so its framing headers are still true.

**A denylist, not an allowlist.** An allowlist would silently drop
`openai-organization`, `x-request-id` and the `x-ratelimit-*` family, which
reach the client today and must continue to. The trade is that a future provider
header this rebuild also invalidates is inherited rather than caught.

**Accepted consequence.** The rule applies to every response passing the logger,
including static assets from `serveDir`
([main.ts:110](apps/gateway/main.ts#L110)). Those lose a `Content-Length` the
runtime then re-derives, so the cost is a recomputation, not a behavior change.

**Provenance:** decided 2026-07-29 as decision-log 87 and measured then as
repairing 15 live-broken routes. That route count is recorded as it was measured
on that date and has not been re-derived since; the mechanism and the three
sites above were re-verified 2026-07-30.

## D-SHARED-RATE-LIMIT

**Fixed-window rate limiting moves to a shared PostgreSQL authority only when
more than one process shares the port, because a single process already is the
whole fleet.**

Measured: a shared reservation costs **~1.8 ms** at 50 concurrent against local
PostgreSQL, versus **~1 us** for the in-process `Map`. In single-process mode
the Map is already fleet-accurate, so paying that buys nothing.

`FROSTY_SHARED_RATE_LIMIT` is `auto|on|off`, resolved by
[`sharedRateLimitEnabled`](apps/gateway/context.ts) - `auto` keys off
`FROSTY_WORKERS`, `on` forces it for operators running separate replicas that
`auto` cannot detect, `off` accepts N-times-the-limit across N processes. When a
shared limiter is present, `VirtualKeyManager` stands its own in-process windows
down so exactly one authority counts.

**Provenance:** decided as decision-log 71; the numbers live in
[docs/benchmark-report.md](docs/benchmark-report.md), which is their maintained
home.
