# Cache planner decisions across client groups

## Problem

Every ViewSyncer owns its own `PipelineDriver`, so when N client groups request
the same query, the query gets planned N times. The decisions are identical --
the planner is a pure function of the AST and the cost model's view of the
database -- but nothing lets the second group reuse the first one's answer.

In the eight-group assignment-wave profile behind this work, planner `plan` was
14.1% inclusive of all samples. On the machine that produced the numbers below
it measured 20.0%, and it is much larger on individual queries: the profiler
run put `assignment.roster` planning at 33-38% of its own CPU with 692 SQLite
statement prepares per build, and `problem_trackers.for_assignment` at 9-11%
with 1,182 prepares per build. Warm hydration does not re-prepare statements --
the statement cache works -- so essentially all of that prepare churn is the
planner's cost probes, which is exactly what a decision cache removes.

## Design

Three pieces, one per commit.

**Planner purity.** `buildPlanGraph` wrote a `planIdSymbol` property onto every
`CorrelatedSubqueryCondition` it visited, mutating AST objects owned by the
caller. `buildPipeline` happened to be shielded because `completeOrdering`
rebuilds every condition wrapper before planning, but direct `planQuery`
callers were not, and a cache contract cannot be published on top of that. Plan
IDs are already a deterministic function of the condition tree -- a counter
over a depth-first walk, with a correlated subquery numbered after the
conditions of its own subquery -- so the apply path re-derives them with a
mirrored walk instead of reading them back off the AST. Conditions that
`processOr` filters out contain no correlated subquery and so consume no IDs in
either walk. With the last writer gone, `planIdSymbol` and its optional field on
`CorrelatedSubqueryCondition` are removed from zero-protocol.

**The cached value is a flip blueprint, and nothing else.** `FlipBlueprint` is
a frozen, recursively indexed record of which joins the planner chose to flip:
`flips` indexed by plan ID, `related` keyed by alias. It holds no AST, no
`PlannerGraph`, no cost model, no `Input`, no `Storage`, no cursor, no row, and
no diff. `planQueryBlueprint` produces one; `applyFlipBlueprint` stamps it onto
a fresh AST; `planQuery` is those two composed, so its signature is unchanged
and `applyPlansToAST` still works for callers that restore a planning snapshot.
Every stateful operator and storage object is still built from scratch on every
hit.

**The seam sits exactly around `planQuery`.** `BuilderDelegate.planCache` is
consulted in `buildPipeline` after `delegate.mapAst` and `completeOrdering`,
which is the exact AST the planner sees -- and therefore already subsumes
resolved scalar subqueries, auth literals bound upstream, and the primary keys
the client schema contributes to ordering completion. The key is
`plannerAlgorithmVersion + host-supplied epoch + h64(canonical serialization)`,
and the full canonical string is compared on every hit, so a 64-bit collision
is a miss rather than a wrong plan.

Canonicalization sorts object keys but preserves array order. This is
load-bearing in both directions: property order is not query identity, but
condition order decides which plan ID belongs to which join, so canonicalizing
with the existing `normalizeAST` (which sorts condition lists) would have
produced a real correctness bug.

`BoundedPlanCache` is an LRU bounded by both entries and estimated bytes. A
blueprint is stored only after planning returns, so a planning failure cannot
poison a key.

**zero-cache wiring.** One `BoundedPlanCache` per sync worker (1,024 entries /
16 MiB), constructed in the worker factory and passed to every `PipelineDriver`
that factory creates. This is the only level where the reuse is visible: the
drivers themselves are per client group.

## Key and invalidation semantics

The epoch is the driver's current replica `stateVersion`, so a decision is only
reused within the snapshot it was made against and any replicated commit starts
a new generation. A schema-change reset clears every generation, as does worker
shutdown. Nothing is cached when `enableQueryPlanner` is off, because no cost
model is built and therefore nothing is planned, and the cache is bypassed when
a `PlanDebugger` is present, because a hit has no planning attempts to report.

`stateVersion` is deliberately conservative, and it should not be sold as
"fresh statistics per stateVersion". `ANALYZE` is a migration and startup
operation, not part of ordinary commit advancement
(`packages/zero-cache/src/db/migration-lite.ts`), and `SQLiteStatFanout` caches
its answers per `(table, columns)` with an explicit "clear the cache if you run
ANALYZE" contract that nothing calls on reset. That staleness edge predates
this branch and is named below rather than fixed here. What `stateVersion`
buys is that a cached decision never outlives the snapshot it was computed
against, which is strictly tighter than what the cost model itself guarantees.

## Why this is safe

Upstream states the invariant this rests on directly. The flip-invariance suite
added in PR #6136 documents that `flip` is "a **plan choice**, not a semantic
one", that an `EXISTS` can be lowered as a semi-join or a `FlippedJoin`, and
that "every flip assignment ... MUST hydrate to the same rows"; the suite
enumerates every `2^k` assignment and pins each to the same Postgres oracle,
through the SQLite IVM and not only an in-memory one. A strategy-only blueprint
therefore cannot change result rows.

Reusing a plan across snapshots introduces no new staleness class either. PRs
#2229 and #2158 established hydrate-once-advance-forever: `addQuery` selects a
pipeline against the driver's current snapshot and `advance` pushes later
changes into that already-built pipeline. A pipeline already outlives the
snapshot that chose it; this branch only lets a second client group reach the
same decision without recomputing it.

The residual risk is performance, not correctness, and it has a canonical
receipt: PR #6164 traced a planned hydration case going from ~103 us to 3.88 ms
to a fixture that lacked predicate indexes before `ANALYZE`, which let the
planner pick a worse plan. Stale or incomplete cost inputs select a slower
strategy; they do not select a different row set.

PR #5080 already floated plan caching upstream and set it aside because it
"does not help for first run". That is true per query per worker, and it is
also why the win here is real: the diagnosed burst is N client groups each
taking their _own_ first run of the _same_ query, which is exactly what a
worker-level cache collapses.

Two regression classes get explicit tests because they are the nearest
historical analogues.

PRs #5423 and #5429 were transformation-hash dedup sync bugs: keying pipelines
by transformation hash let one query's removal tear down another query that
shared that hash. Hash-identity reuse going wrong is the closest thing in this
repo's history to a wrong cache hit, so the mirrored scenario is tested --
two query IDs with the same AST in one driver, one removed, the survivor still
owning its own pipeline and still advancing.

PRs #5857 and #6196 established that a row set can drift even at the same CVR
version, so `stateVersion` alone never identifies hydrated results. This branch
does not touch that: it returns a strategy, then hydration and advancement run
against the current snapshot exactly as before, and the row-set signature drift
and re-execution paths are untouched.

## Numbers

All measurements are from one machine; the ratios are the portable result.

### Microbenchmarks

`pnpm --filter zql-benchmarks bench` on the diagnosis's real post-auth
transformed ASTs, taken verbatim from the eight-group run's `Slow query
materialization` log lines and run against a same-shape synthetic replica.
`assignment.roster` carries 40 EXISTS with 31 app-supplied flip hints, leaving
9 for the planner; `problem_trackers.for_assignment` carries 15 with 9 hints.

Planning only (`planner-cost.bench.ts`, median per iteration):

| query                           | cold miss | warm hit | key only | hash only | blueprint apply |
| ------------------------------- | --------: | -------: | -------: | --------: | --------------: |
| assignment.roster               |  11.29 ms |   264 µs |   212 µs |     52 µs |          4.8 µs |
| problem_trackers.for_assignment |  19.42 ms |    92 µs |    74 µs |     21 µs |          2.5 µs |

Build plus hydrate (`planner-hydration.bench.ts`, median per iteration), so a
hit is measured against the cost it actually displaces:

| query                           | cache off | cache cold | cache warm | warm vs off |
| ------------------------------- | --------: | ---------: | ---------: | ----------: |
| assignment.roster               |  19.85 ms |   19.71 ms |    7.87 ms |      −60.4% |
| problem_trackers.for_assignment |  93.02 ms |   94.98 ms |   70.73 ms |      −24.0% |

Cold is within noise of off, so the cache path costs nothing on a miss beyond
the key. Canonical key computation is the floor on a hit -- 212 µs of the
roster's 264 µs -- which is about 2% of the cold plan cost.

The tracker figure should be read with one caveat: a separately-tracked ignored
scalar access hint will substantially simplify that AST, and that fix and this
cache overlap on the tracker. The roster numbers are clean of it.

### End-to-end, N=8 wave replay

`packages/zero-cache/bench/wave-replay`, N=8 client groups × 3 runs, one sync
worker, pooled medians. Before is `capy/zc-baseline-harness` (main plus the
harness instrumentation); after is this branch merged onto it.

| metric                     |    before |     after | change |
| -------------------------- | --------: | --------: | -----: |
| query wave wall            | 3629.4 ms | 2240.2 ms | −38.3% |
| client settle              | 4898.0 ms | 3565.5 ms | −27.2% |
| query processing (CPU-ish) |  401.3 ms |  231.1 ms | −42.4% |
| tracker hydrate            |  214.0 ms |  180.9 ms | −15.5% |
| CVR flush                  |   45.9 ms |   34.7 ms | −24.4% |

The baseline was re-measured after the after-run to rule out machine drift:
3613.5 ms query wave wall, within 0.4% of the first baseline.

Sync-worker CPU profile of one N=8 wave, inclusive share of sampled time:

| frame                         |  before | after, cold worker | after, warm cache |
| ----------------------------- | ------: | -----------------: | ----------------: |
| `planQuery` / `planWithCache` |   20.0% |               4.1% |              0.2% |
| `buildPipeline`               |   21.2% |               5.5% |              1.7% |
| native SQLite `prepare`       |    8.6% |               2.8% |              1.1% |
| sampled seconds               | 6.512 s |            5.086 s |           4.567 s |

"Cold worker" is the first wave after a restart, where the first group plans
and the other seven hit. "Warm cache" is a later wave with no replica commit in
between, where the client roots are already cached. Both are real states; the
cold number is the one to quote for a worker that has just come up.

Plan cache gauges after one N=8 wave on a fresh worker, read from
`sync.plan_cache_*` via the console metrics exporter:

| gauge              |  value |
| ------------------ | -----: |
| lookups, hit       |     42 |
| lookups, miss      |     22 |
| lookups, collision |      0 |
| evictions          |      0 |
| entries            |     22 |
| bytes              | 93,224 |

65.6% hit rate, which is the ceiling for this workload: 8 groups × 8 pipelines
is 64 lookups; the 6 client roots are shared, so the first group misses 6 and
the other 7 hit 6 each, while the 2 internal pipelines per group embed the
client group ID in their AST and correctly never share. Memory is 4.2 KB per
entry, 0.6% of the 16 MiB bound, with no evictions.

### Equality

The CVR was truncated and one N=8 wave replayed on each branch, then every
client group's CVR row set digested (table, row key, row version, and the query
names referencing it).

Within each run, all 8 client groups produced byte-identical digests. Across
runs, the digests differ in exactly one field -- the replica `rowVersion` token,
which differs because each run initial-synced its own replica file. Stripping
that single token, both runs digest to `d3d0bc2734fa5b1c` over 3,378 rows per
group, with identical per-query reference counts (`problem_trackers` 2,903 rows
at refcount 1, `assignment.roster` 141 at 1 and 272 at 2, and so on).

Byte-for-byte poke equality is not captured on the wire here; the harness
client does not record pokes. It is proven one level down, where pokes are
made: `pipeline-driver.test.ts` compares the complete `RowChange` stream from a
cache-on driver against a cache-off driver and requires deep equality, and
`builder.test.ts` compares full hydrated node trees, rows and relationships, on
a hit versus a miss.

## Risks, stated honestly

**Stale statistics select a slower plan.** This is the real residual risk, and
it is performance-only for a strategy-only blueprint (PR #6164). The
`stateVersion` epoch bounds it to a single snapshot, which is tighter than what
the cost model's own `SQLiteStatFanout` cache guarantees.

**Adjacent known edge, deliberately not fixed here.** `SQLiteStatFanout` caches
per-`(table, columns)` answers for the lifetime of a cost model, the cost model
lives in a `WeakMap<Database, …>` that `PipelineDriver.reset()` does not clear,
and the two snapshot connections alternate, so a fanout answer can survive many
state versions and a runtime `ANALYZE` or index change. That edge predates this
branch and is untouched by it -- the plan cache's own epoch is strictly
tighter -- but it is worth naming because it now sits next to a cache and could
be mistaken for one.

**Diagnostics on a hit.** A cache hit skips planner debugger events and the
"more than nine flippable joins" warning. The debugger case is handled by
bypassing the cache entirely; the warning becomes once-per-key-per-epoch rather
than once-per-call.

**Key cost on a miss.** Canonicalizing the AST costs 74-212 µs on these
queries and is paid on every lookup, hit or miss. It is roughly 2% of the plan
it replaces, but it is not free, and a workload with no cross-group reuse pays
it for nothing.

**Not in scope.** No cross-group pipeline or result sharing: that is a separate
change with a much larger correctness surface (auth isolation, TTL, row-set
signatures, per-group cookies), and PRs #5857/#6196 are the reason to keep it
separate.

## Validation

```bash
pnpm --filter zql test
pnpm --filter zql check-types && pnpm --filter zql lint
pnpm --filter zero-cache check-types && pnpm --filter zero-cache lint
pnpm --filter zero-protocol check-types
npx vitest run --root packages/zero-cache src/services/view-syncer/ src/workers/syncer.test.ts
pnpm --filter zql-benchmarks bench   # planner-cost.bench.ts, planner-hydration.bench.ts
npx oxlint --quiet --type-aware
pnpm verify-deps
git diff --check
```

The N=8 replay needs the harness branch and its environment; see
`packages/zero-cache/bench/wave-replay/README.md`. With that running:

```bash
# before
git checkout capy/zc-baseline-harness
bun run-matrix.ts --server-log <log> --output ./before --concurrencies 8 --runs 3
# after
git checkout capy/planner-blueprint-cache && git merge capy/zc-baseline-harness
bun run-matrix.ts --server-log <log> --output ./after --concurrencies 8 --runs 3
```

Set `OTEL_METRICS_EXPORTER=console` to read the `sync.plan_cache_*` gauges.
