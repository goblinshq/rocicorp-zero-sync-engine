# INTEGRATION PREVIEW -- do not open a pull request from this branch

`capy/zc-combined-preview` exists to prove that the seven zero-cache performance
branches compose and to measure the stack against the same-machine baseline. The
six optimizations land individually, on their own branches, with their own
reviews. Nothing here is new work: every code change on this branch arrived
through a merge, and the only hand-written content is this preamble and the
conflict log below.

Base: `main` @ `16019afa4`.

## Merge order

Each optimization branch was merged separately with `--no-ff`, so every merge is
one reviewable commit and no conflict is hidden inside an octopus. The harness
branch is merged last, because its stage probes have to sit on top of the
optimized code for `diagnosis-*` events to describe what the optimized code
actually does.

1. `capy/planner-blueprint-cache`
2. `capy/scalar-gate-propagation`
3. `capy/scalar-compound-guard`
4. `capy/zqlite-fetch-cost`
5. `capy/streamer-batch`
6. `capy/flipped-join-batch-cost`
7. `capy/syncer-observability`
8. `capy/zc-baseline-harness` (instrumentation, must be last)

## Conflicts and resolutions

**`BRANCH_NOTES.md`, add/add, on all seven merges.** Every branch writes its own
notes to the same path. Resolved by concatenation: the accumulated file stays
first and the incoming branch's notes follow under a
`# Merged branch notes: capy/<branch>` heading. Documentation only, no code
effect.

**`packages/zqlite/src/resolve-scalar-subqueries.test.ts`, merge 3
(`scalar-compound-guard` onto `scalar-gate-propagation`).** Gate propagation
widened the file's `makeTableSpecs` helper with an optional `columns` parameter
that defaults to `{}` and appended its propagation suite; compound guard appended
a separate compound-correlation suite onto the unmodified base, so git saw two
different rewrites of the same tail. Resolved by keeping the gate-propagation
file in full and re-appending the compound-guard tail after it. Compound guard's
`makeTableSpecs({parent: …, child: …})` calls bind to the widened signature
unchanged because the new parameter is optional. Both suites run and pass.

**`packages/zero-cache/src/workers/syncer.ts`, merge 7
(`syncer-observability` onto `planner-blueprint-cache`).** Both branches add one
field to `Syncer` and one line to `stop()`, at the same two places. Resolved by
keeping both: `#planCache` next to `#stopEventLoopMonitor`, and
`this.#planCache.clear()` next to `this.#stopEventLoopMonitor?.()`.

**`packages/zero-cache/src/services/view-syncer/view-syncer.ts`, merge 8
(`zc-baseline-harness` onto `syncer-observability`).** The two branches
instrument the same three points for different consumers. Observability
restructured `#runInLockWithCVR` so the whole locked body sits in a `try`, and
records `lockWaitTime`/`lockHoldTime` histograms around it; the harness left the
body flat and added `diagnosis-view-syncer-lock-acquired` and
`-lock-released` logs at the same boundaries. Resolved by keeping
observability's structure and feeding both consumers from one measurement:
`lockHoldStart` is taken once on lock entry, `lockWaitMs` is derived from it for
both the histogram and the acquired log, and the `finally` block computes
`lockHoldMs` once for both the hold histogram and the released log's
`lockWorkMs`. The harness's duplicated copy of the pre-`try` body was dropped,
since observability's restructure already contains it. At the end of the query
wave both sides are additive, so `#waveWallTime`/`#waveRows` and the
`diagnosis-query-wave-stages` log both stay.

No conflict required a behavioral choice: every resolution keeps both branches'
observable effects.

## What was validated on this tree

`pnpm --filter zql test` (1335), `--filter zqlite test` (228), `--filter
zero-cache test:no-pg` (1997), `--filter zero-cache test:pg17` (719), `--filter
zql-integration-tests test` (1165), plus `check-types`, `lint` and
`check-format` on all four packages. No test fails on the combination that
passes on the branches alone.

---

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

---

# Merged branch notes: capy/scalar-gate-propagation

# Propagate a parent literal through a scalar gate's correlation

`whereExists(rel, …, {scalar: true})` promises to collapse a correlated EXISTS
into one lookup plus a literal comparison. Today the promise is kept only when
the subquery pins itself: `isSimpleSubquery` accepts the hint when literals
_inside_ the subquery's WHERE cover every column of some unique key. The
authorization shape that motivates the hint does not look like that. Its root
is already filtered to one parent value and the gate correlates the child's key
to that same column:

```ts
problemTracker
  .where('assignmentID', assignmentID) // parent.pf = L
  .whereExists('assignment', q => q.where(canRead), {scalar: true});
//               correlation: assignment.id = problem_tracker.assignment_id
```

The subquery has no literal on `assignment.id`, so the hint is dropped, the
server warns, and the gate runs as a per-parent EXISTS. On the production
replica that is 7,795 SQLite iterator starts and 4,865 access-support rows to
serve 2,903 requested rows.

This branch teaches eligibility to see the literal the parent already carries.

## The invariant

Write the gate's parent column `pf`, the correlated child column `cf`, the
subquery's own predicate `P`, and the parent's literal `L`. The claim is:

```
  pf = L AND EXISTS(child WHERE cf = pf AND P)
≡ pf = L AND EXISTS(child WHERE cf = pf AND cf = L AND P)
```

Take any parent row. If `pf ≠ L`, or `pf` is NULL, the first conjunct is false
and both sides are false — the gate's value is never observed, so nothing the
rewrite does to it can matter. If `pf = L`, then any child row satisfying
`cf = pf` also satisfies `cf = L`, so the added conjunct discards nothing and
the two EXISTS have the same truth value. The equivalence is pointwise on the
rows where the conjunction can be true, which is why it survives negation: the
same argument gives `NOT EXISTS ≡ NOT EXISTS` under `pf = L`.

Adding `cf = L` is exactly what the existing machinery needs. The subquery is
now pinned by a literal on a unique key, so the established rewrite applies
unchanged: run it once, take the single row's `cf`, and replace the gate with
`pf = <that value>` (or `IS NOT`, for `NOT EXISTS`). If no row matches, the gate
is constant-false for every parent row that survives the literal, so it
collapses to `ALWAYS_FALSE` — the same collapse the in-subquery-literal path
already performs.

### Which parent positions qualify

The literal must apply to _every_ row the enclosing query returns. It qualifies
when it is a `column = literal` conjunct reachable from the enclosing WHERE's
root by following only `and` nodes. That is precisely what
`extractLiteralEqualityConstraints` already computes, so nothing new had to be
written: it stops at `or`, never descends into a `correlatedSubquery` (so a
literal inside an `EXISTS` or `NOT EXISTS` body cannot escape), and ignores any
operator other than `=` and any right-hand side that is not a literal. There is
no `not` node in the condition grammar — negation exists only as the
`NOT EXISTS` operator — so there is no negated branch to guard against beyond
that.

The _gate_ itself may sit anywhere in that WHERE, including under an `or`,
because the equivalence is pointwise: rows where `pf ≠ L` are dropped by the
conjunct regardless of what the surrounding boolean structure does with the
gate's value.

Literals are collected from the **unresolved** WHERE, before any gate in it is
rewritten. Resolving a gate produces a new `pf = value` conjunct that would
itself be a legal source of propagation, but harvesting it would make
eligibility depend on the order gates happen to be visited. The current rule is
order-independent.

### Value semantics: why the type check is not paranoia

The rewrite replaces one comparison with another, so the two comparisons have
to mean the same thing. In zqlite they do not go through the same code:

- A correlation becomes a SQL constraint in `constraintsToSQL`
  (`query-builder.ts`), which binds the value as
  `toSQLiteType(value, columns[cf].type)` — the **child column's declared
  type**.
- A literal `=` becomes a SQL filter through `valuePositionToSQL`, which binds
  as `toSQLiteType(value, getJsType(value))` — the **literal's own JS type**.
- The in-memory overlay and filter paths (`createPredicate` in
  `zql/src/builder/filter.ts`) compare the decoded row value with `===`.

Those three agree for `string`, `number` and `boolean` and disagree for `json`,
where one path applies `JSON.stringify` and the other does not. SQLite affinity
adds a second way to diverge: a literal bound as a number against a TEXT column
takes on TEXT affinity, so `cf = 5` can match a row whose `cf` is `'5'` while
the JS `===` in the overlay path does not.

So propagation requires the parent column's declared type, the child column's
declared type, and `typeof literal` to be the same, and that type to be one
SQLite and JS agree on. In code this is one comparison, because `typeof` never
yields `'json'` or `'null'`; the same comparison therefore also excludes array
literals and `null` literals. Reading the declared types is why the module's
table-spec parameter now carries `zqlSpec` alongside `uniqueKeys` — both
production callers already pass a full `LiteAndZqlSpec`.

Collation is not a further hazard here: no `COLLATE` clause is emitted anywhere
in the replica DDL or in zqlite's generated SQL, so text comparison is BINARY on
both paths. If a non-BINARY collation is ever introduced, it would break the
existing in-subquery-literal path in the same way, not just this one.

### NULL discipline

No exclusion was needed, because the equivalence covers NULL parents directly.
`pf = L` is false for a NULL `pf` on both the SQL path (`NULL = x` is NULL,
which is not true) and the JS path (`createPredicate` returns false when the
left value is null or undefined), so a NULL-`pf` row never reaches the gate's
result. Symmetrically, a correlated EXISTS on a NULL parent value matches
nothing. Nullable parent and child columns are therefore both fine; a unique
key over a nullable column still admits at most one row satisfying `cf = L`,
since NULL rows do not satisfy it.

`null` literals are excluded separately, by the type check — not because the
logic breaks, but because `= NULL` has no useful meaning and its two encodings
are not worth proving equal.

### What stays ineligible

Compound correlations, even when every parent column is pinned. The resolved
gate names a single parent column (`parentField[0]`), so a compound correlation
cannot be answered by one scalar value. This is a pre-existing limitation of the
resolver, not one this branch introduces; the branch simply refuses to widen the
set of ASTs that reach it.

Non-equality correlations are unrepresentable: `Correlation` is a pair of
compound keys, and the AST documents that only equality correlations are
supported.

A subquery's own `related`, `limit`, `orderBy` or `start` do not break the
proof — a unique key pinned to a literal admits at most one row whatever those
do, and any of them can only remove it, which the executor already reports as
"no row". Propagation therefore treats them exactly as the in-subquery-literal
path does.

## Companion semantics are unchanged by construction

The propagation hands the resolver a subquery AST with the literal spliced in
and then does nothing else. Everything downstream — the executor, the companion
pipeline built from that AST, `scalarValuesEqual`, `ResetPipelinesSignal`, the
companion rows streamed to the client — operates on that AST alone and cannot
tell where the literal came from. A unit test asserts this directly: resolving
the propagated shape produces a byte-identical `ResolveResult` to resolving the
shape an author would have written by hand.

The end-to-end tests confirm the invalidation behavior on a real replica: an
access grant, a revocation, deletion of the gating row, and an ownership change
each flip the gate and each raise `ResetPipelinesSignal`, after which
rehydration on the new snapshot yields exactly the rows the plain EXISTS path
yields. A change to the gating row that does _not_ flip access streams as an
ordinary row change with no reset.

## Measured effect

Seeded production replica (136 students, 973 trackers, 973 conversations, 957
mastery assessments), the real post-auth tracker AST, warm hydration through
`buildPipeline` + `hydrateInternal`, 2 warmups and 20 measured iterations per
process, three processes per side.

|                                |                   before |                 after |
| ------------------------------ | -----------------------: | --------------------: |
| hydration median (planner on)  | 299.8 / 312.3 / 319.1 ms | 65.2 / 60.5 / 59.7 ms |
| hydration median (planner off) |         246.8 / 253.0 ms |        56.4 / 55.1 ms |
| SQLite iterator starts         |                    7,795 |                 1,947 |
| iterator `next()` calls        |                   16,823 |                 3,877 |
| emitted row changes            |                    7,768 |                 2,903 |

That is an 81% reduction with the planner on and 78% with it off, so planner
simplification does not explain it. Requested-table results are identical on
both sides: 973 `problem_tracker`, 973 `conversation`, 957 `mastery_assessment`.
The difference is entirely the access-support rows the EXISTS gate had to
stream — 973 `assignment`, 1,946 `teacher_assignment_access` and 1,946 `teacher`
— which collapse to the single companion `assignment` row.

## Risk

The failure mode of a wrong eligibility decision is wrong results, not slow
ones, so the change is deliberately narrow: one new predicate, no change to the
resolution, companion or pipeline machinery, and an exclusion for every value
edge that could not be proven rather than a best-effort guess. The shapes that
newly become eligible are exactly those where the parent already guarantees the
subquery sees one row, and the test suite pins fourteen shapes that must stay
ineligible.

The ignored-hint warning is unchanged and still fires for everything that is
genuinely not provably single-row; it simply stops firing for the shapes that
now are.

The one behavior change beyond eligibility is that a newly-eligible gate
invalidates by `ResetPipelinesSignal` (rehydrate the client group) rather than
by streaming incremental EXISTS changes. That is the same trade the hint already
made wherever it was honored, and it is what makes the companion mechanism
correct; it costs a rehydration on access changes, which are rare relative to
the per-parent gate evaluation it removes.

## Validation

```bash
pnpm --filter zqlite test          # 213 passed
pnpm --filter zql test             # 1316 passed, 2 skipped
pnpm --filter zero-cache test      # no-pg: 1981 passed; pg-17: full suite
pnpm --filter zqlite check-types
pnpm --filter zero-cache check-types
pnpm lint && pnpm check-format
```

Benchmark rerun, per side, against a fresh copy of the replica:

```bash
node --experimental-strip-types --expose-gc hydrate-profile.mjs \
  --db "$RUN/assignment-replica.db" --specimen tracker \
  --warmup 2 --iterations 20 --mode full --instrument
```

---

# Merged branch notes: capy/scalar-compound-guard

# Bug: a compound-correlation `{scalar: true}` gate returns wrong rows

`resolveSimpleScalarSubqueries` honors a `{scalar: true}` hint whenever the
subquery is provably limited to one row, then replaces the correlated EXISTS
with a single comparison built from `correlation.parentField[0]` and
`correlation.childField[0]`. It never checks how many columns the correlation
actually has. When the relationship is compound, every pair after the first is
silently dropped, and the query admits parent rows the EXISTS excludes.

This is a correctness bug on the zqlite/zero-cache read path. It is reachable
through the public query builder, it is silent, and its live-update behavior
can keep the wrong answer in place indefinitely.

## Repro

A one-hop compound relationship whose destination has a unique key the callback
pins is enough. Nothing here is exotic or hand-written AST:

```ts
const child = table('child')
  .columns({id: string(), x: string(), y: string()})
  .primaryKey('id');
const parent = table('parent')
  .columns({id: string(), a: string(), b: string()})
  .primaryKey('id');
// parent -> child = one({sourceField: ['a', 'b'], destField: ['x', 'y'], destSchema: child})

newQuery(schema, 'parent').whereExists('child', q => q.where('id', '=', 'c1'), {
  scalar: true,
});
```

The static gate on the scalar overload checks that the callback covers some
unique key of the destination. It does not check the relationship's arity, so
this compiles. The resulting AST carries
`correlation: {parentField: ['a', 'b'], childField: ['x', 'y']}` together with
`scalar: true`.

With the fixture

| table    | rows                                                                      |
| -------- | ------------------------------------------------------------------------- |
| `child`  | `{id: 'c1', x: 'x1', y: 'y1'}`                                            |
| `parent` | `p1 {a: 'x1', b: 'y1'}`, `p2 {a: 'x1', b: 'y2'}`, `p3 {a: 'x9', b: 'y1'}` |

the gate means `a = 'x1' AND b = 'y1'`, so only `p1` qualifies.

**On `main` at `16019afa4` the query returns `p1` and `p2`.** The resolver
emitted `a = 'x1'` and dropped `b = 'y1'`, so `p2` — which matches the first
correlated column and not the second — is served to the client. The resolved
`where` is a plain `simple` condition, and no warning is logged, because from
the resolver's point of view the hint was honored.

### The live path makes it worse

The companion pipeline stores a single `childField` (`childField[0]`) and
raises `ResetPipelinesSignal` only when the value read from that one column
changes. Editing the child's **second** correlated column leaves the first one
alone, so nothing invalidates.

Updating `child.c1` from `{x: 'x1', y: 'y1'}` to `{x: 'x1', y: 'y2'}` should
move the parent set to `['p2']`. Measured on `main`:

```
{"before":["p1","p2"],"reset":false,"parentChanges":0,"after":["p1","p2"]}
```

No reset, no row changes, and the already-wrong set persists — now wrong in a
second way, since `p1` no longer qualifies at all. A client can hold rows it was
never entitled to for the lifetime of the query.

`z2s` is unaffected: its correlated SQL emits every pair and deliberately
ignores the hint, so the same AST is correct when compiled for Postgres. The
hazard is specific to zqlite's scalar pre-resolution.

## The fix

Refuse the hint when either correlation array has more than one column, and
report it through the existing ignored-hint channel so the gate degrades to the
plain EXISTS it should always have been:

```ts
const compoundCorrelation =
  correlation.parentField.length > 1 || correlation.childField.length > 1;

if (compoundCorrelation || !isSimpleSubquery(subquery, tableSpecs)) {
  out.ignoredScalarHints.push({table, uniqueKeys, reason: …});
  …
}
```

This is correctness-restoring, not a breaking change: every query it affects is
returning wrong rows today, and after the fix it returns the rows its own
`EXISTS` semantics always specified. The cost is that such a gate no longer gets
the single-lookup plan it asked for — which it was never entitled to.

`IgnoredScalarHint` gains a `reason` so the warning can say what actually went
wrong. The existing message tells the author to constrain every column of a
unique key to a literal; someone hitting the compound case has already done
exactly that, and would have no way to act on the advice. The two callers that
format the warning pick the matching clause; the wording of the pre-existing
`unpinned` case is unchanged, including its inline snapshot.

## Follow-up upstream may prefer

Full compound support rather than a refusal: emit one comparison per
correlation pair (`a = row.x AND b = row.y`), and widen the companion contract
to watch every `childField` so any of them changing invalidates. That is a
larger change — `CompanionSubquery.childField` becomes a list, `ScalarExecutor`
returns a tuple, and `scalarValuesEqual` compares vectors — and it changes the
shape of data the driver keeps per query. It is strictly better for performance
and strictly larger in risk, so it seemed wrong to bundle with a bug fix that
should land quickly. The guard and the full implementation are compatible: the
guard becomes dead code the day the vector rewrite lands.

## Tests

`packages/zqlite/src/resolve-scalar-subqueries.test.ts` adds five cases: the
trace's repro degrades even though `isSimpleSubquery` accepts its subquery (the
test asserts that acceptance explicitly, since it is what made the shape
dangerous), the same for `NOT EXISTS`, the same for a compound gate nested
inside another subquery, a single-pair correlation still resolves, and an
unpinned subquery is still reported as `unpinned` rather than as compound.

`packages/zero-cache/src/services/view-syncer/pipeline-driver.compound-scalar.test.ts`
runs the repro on a real replica: hydration admits `p1` only, the gate survives
as a real `correlatedSubquery` with the warning logged, editing the second
correlated column streams `remove p1` / `add p2`, and the compound gate agrees
with the same query written without the hint. Copied onto `main` at `16019afa4`,
all four fail:

```
AssertionError: expected [ 'p1', 'p2' ] to deeply equal [ 'p1' ]
AssertionError: expected 'simple' to be 'correlatedSubquery'
AssertionError: expected [ 'p1', 'p2' ] to deeply equal [ 'p1' ]
AssertionError: expected [ 'p1', 'p2' ] to deeply equal [ 'p1' ]
```

## Validation

```bash
pnpm --filter zqlite test                 # 198 passed
pnpm --filter zql test                    # 1316 passed, 2 skipped
pnpm --filter zero-cache test             # no-pg 1975 passed; pg-17 719 passed, 9 skipped
pnpm --filter zql-integration-tests test  # 1165 passed, 16 skipped
pnpm --filter zqlite check-types
pnpm --filter zero-cache check-types
pnpm lint && pnpm check-format
```

The `zql-integration-tests` chinook zero-cache fuzzer's churn case times out
under heavy parallel load on a small machine; it passes at file level (12/12,
including the 5,091-case replica/PostgreSQL equivalence run) and in a full run
with nothing else competing. That suite's scalar property — marking gates
`scalar` must not change results — is exactly what this fix restores.

---

# Merged branch notes: capy/zqlite-fetch-cost

# `capy/zqlite-fetch-cost` — per-fetch and per-row cost in `TableSource`

Six commits, all inside `packages/zqlite`, all behavior-preserving. No API
changes outside the package. Measured against the seeded assignment replica
from the zero-cache diagnosis kit.

**54.95 ms → 37.30 ms per hydration wave, −32.1%**, with byte-identical rows.

## What the evidence said

Statement caching is **not** the problem, and neither is statement preparation.
Driving real `TableSource` fetches against the replica, `db.prepare` is called
**0 times** in a warm wave, before and after. Identical shapes hit
`StatementCache` every time.

Self time *under* `TableSource.#fetch` in the diagnosis kit's
`eight-groups.cpuprofile` (`#fetch` is 28.5% of all samples):

| frame                                                           | share of `#fetch` |
| --------------------------------------------------------------- | ----------------: |
| native SQLite `next`                                              |             37.3% |
| SQL build + `formatStandard` + normalize + cache lookup           |              ~27% |
| zqlite `Statement` / iterator wrapper (`withContext` alone 4.7%)   |              ~18% |
| row conversion (`fromSQLiteTypes`, `#mapFromSQLiteTypes`)          |             ~5.4% |

Per-row ladder on the 973-row tracker fetch: native iterate 1.27 us/row →
+ wrapper 1.42 → + `fromSQLiteTypes` 2.00 → + generators 2.39.

The follow-up hydration profiles put `buildSelectQuery` at 8.8–9.1% inclusive,
zqlite `format` at 8.2–8.6% inclusive, `formatStandard` at 5.2–5.6% self, and
`normalizeWhitespace` at ~1% self, over a warm tracker hydration that runs
7,795 fetches across only 12 distinct SQL texts.

## The commits

1. **Log a completed SQLite iterator's slow-query epilogue once.** An exhausted
   iterator logged twice: `next()` logs on `done`, then `#fetch`'s `finally`
   closes it and `return()` logs the same query again. 6,822 of 7,795 profiled
   tracker iterators and all 362 roster iterators did this. `#log()` is now
   idempotent; early closes and aborts still log.

2. **Build the slow-query log context only when the query is slow.**
   `Statement.run/get/all/iterate`, the iterator epilogue and `Database.#run`
   each derived a `LogContext` and spread an attribute object on every call,
   then `logIfSlow` discarded both. `withContext` is 4.7% of `#fetch` self time.
   Output is unchanged: `logIfSlow` already re-applied every attribute, and
   `withContext` merges rather than appends.

3. **Format SQL with a SQLite-specific item walker.** `@databases/sql`'s
   `formatStandard` ends every call by dedenting: split, filter, measure each
   line's indent, take the minimum, rejoin — dead work for the single-line SQL
   the builder emits, and the diagnosis's "SQL formatting 3.0% self". `format`
   and `compile` now walk the items directly, skip the dedent when the text has
   no newline (provably a no-op there, since the trailing `trim()` removes the
   leading whitespace either way), and memoize escaped identifiers, bounded at
   10,000 entries.

4. **Materialize fetched rows from a precomputed column plan.** `#fetch` selects
   exactly `Object.keys(this.#columns)`, so the per-row `Object.keys(row)`
   allocation and schema lookups in `fromSQLiteTypes` are avoidable. Exported
   `fromSQLiteTypes` is untouched for `getRow`, the snapshotter and the write
   authorizer.

5. **Reuse a fetch's SQL text across fetches of the same shape.** A
   per-connection template keyed by the constrained columns in order, each
   multi-constraint's columns and arity, and `reverse`; values are rebound in
   `buildSelectQuery`'s order, with the same per-entry column check
   `multiConstraintToSQL` makes. The connection already fixes the table, columns,
   filters and ordering, and values never change the text because
   `constraintsToSQL` emits `col = ?` even for a null. `StatementCache` grows
   `getNormalized` so the canonical text is normalized once per template rather
   than once per fetch. Requests with a `start` keep the old path, because
   `gatherStartConstraints` chooses comparisons from the cursor row's values.

## Numbers

Fixture: `assignment-replica.db` (+ wal, + shm) copied out of
`zc-kit-full/current-run/`. The wave replays the SQL shapes observed in that
run's `server.log` — `problem_tracker` by assignment (973 rows), 973 ×
`conversation` by tracker, 973 × `mastery_assessment` by tracker, `assignment`
by id, `student_class_membership` with multi-constraint `IN` of arity
1/2/5/17/126 — plus reverse fetches and cursor paging over both bases. 2,064
fetches, 4,665 rows per wave. Before and after run interleaved from two
checkouts of the same base commit to cancel machine drift; each number is the
median of 25 waves.

| round | before | after |
| ----: | -----: | ----: |
| 1 | 54.9 ms | 37.3 ms |
| 2 | 54.9 ms | 37.5 ms |
| 3 | 55.2 ms | 37.3 ms |
| 4 | 54.8 ms | 37.1 ms |
| 5 | 54.0 ms | 37.6 ms |
| 6 | 55.1 ms | 37.1 ms |

**54.98 ms → 37.32 ms, −32.1%** on medians, and −32.1% on per-round minima
(54.833 → 36.80 ms). The before and after ranges do not overlap.

Cumulative through each commit, same method, three interleaved rounds each:

| through commit | median | vs base |
| --- | ---: | ---: |
| base | 55.0 ms | — |
| 1 — idempotent iterator log | 55.0 ms | 0% |
| 2 — deferred log context | 52.5 ms | −4.6% |
| 3 — SQLite formatter | 48.9 ms | −11.1% |
| 4 — row conversion plan | 46.4 ms | −15.6% |
| 5 — fetch-template cache | 37.3 ms | −32.1% |

Commit 1 does not move this benchmark, and that is expected: its duplicate
epilogue only becomes expensive when the log context is built eagerly, which
commit 2 removes anyway. Its value on top of main is the profiled 1–2% of
tracker CPU and, either way, one slow-query record per iterator instead of two.

The win is per-fetch dominated. A single 973-row fetch, where SQL costs amortize
over many rows, improves only through the row plan: 2.39 → 2.25 us/row.

Isolated micro-numbers: the formatter is 45–48% cheaper than `formatStandard` on
the four dominant fetch shapes, and the row plan halves row conversion — 0.36 →
0.19 us/row on the 8-column `problem_tracker`, 1.08 → 0.57 us/row on the
17-column `assignment`.

## Work eliminated

Counters over one warm wave, before and after:

| counter | before | after |
| --- | ---: | ---: |
| rows | 4,665 | 4,665 |
| iterators started | 2,064 | 2,064 |
| `db.prepare` calls | 0 | 0 |
| SQL formats | 2,064 | 68 |
| distinct SQL texts formatted | 16 | 4 |

The 68 remaining formats are exactly the 68 cursor-paging fetches (17 rows × 2
bases × 2 directions) that bypass the template by design.

## Equality proof

The harness in `MODE=dump` writes every fetched row, in fetch order, as JSONL
(bigints tagged so they survive `JSON.stringify`). Before and after are
byte-identical:

```
$ cmp rows-before-ext.jsonl rows-after-ext.jsonl && echo IDENTICAL
IDENTICAL
$ sha256sum rows-before-ext.jsonl
21b2a36669ab56bdd515457138acd97904f8bd7acd9509e55463fa3e5aa7106d
```

4,665 rows across five tables covering `string`, `number`, `boolean`, `json` and
`null` columns, ascending and descending multi-column orderings, single and
compound constraints, multi-constraint `IN` of five different arities, reverse
fetches, and cursor paging on both bases.

The unit tests add the shapes the replica does not exercise: the same
constrained columns in a different order, chained multi-constraints, compound
multi-constraints whose later entries list their columns in a different order,
and connection filters. Each cached shape is compared against building and
formatting the query from scratch, twice, so it is served once by a fresh
template and once by a cached one. Deliberately breaking the template key on
`reverse`, on the constraint columns, on multi-constraint arity, on the
filter-value position, or on the compound column order fails those tests. A
heterogeneous multi-constraint must throw rather than misbind, on the fresh path
and on the cached one.

## Tests

```
pnpm --filter zqlite test                 203 passed (13 files)
pnpm --filter zql test                    1316 passed, 2 skipped (76 files)
pnpm --filter zql-integration-tests test  1165 passed, 16 skipped (91 files)
pnpm --filter zero-cache test             4851 passed, 32 skipped (344 files)
pnpm --filter zero-cache check-types      clean
pnpm --filter zqlite check-types          clean
npx oxlint --quiet --config oxlint.config.ts packages/zqlite/src
                                          19 warnings (18 on main; the extra is
                                          `valid-title` on a table-driven test,
                                          matching the file's existing pattern)
npx oxfmt --check packages/zqlite/src     clean
```

## Reproducing

The harness is scratch and is not committed; it is archived with the raw logs in
`~/.capy/work/zc-fetch-results/` on the run machine (`hydration-mix.ts`,
`format-counters.ts`, `row-cost.ts`, `format-variants.ts`, `conv-variants.ts`,
`fetch-cost.ts`, `mc-heavy.ts`, `prof-subtree.mjs`, `ab.sh`).

```bash
# fixture: copy the db together with its wal and shm
cp zc-kit-full/current-run/assignment-replica.db{,-wal,-shm} ~/bench/

# interleaved A/B (baseline worktree at the branch point + patched checkout)
git worktree add ../zero-base <base-sha>
ROUNDS=6 REPS=25 ./ab.sh

# work eliminated
node --experimental-strip-types packages/zqlite/scratch/format-counters.ts

# price the multi-constraint guard (needs a second worktree with it removed)
node --experimental-strip-types packages/zqlite/scratch/mc-heavy.ts

# equality diff
MODE=dump OUT=rows-before.jsonl node --experimental-strip-types hydration-mix.ts  # baseline
MODE=dump OUT=rows-after.jsonl  node --experimental-strip-types hydration-mix.ts  # branch
cmp rows-before.jsonl rows-after.jsonl
```

## What the multi-constraint guard costs

`multiConstraintToSQL` asserts that every entry of a multi-constraint carries
the first entry's columns, and a fetch served from a template never reaches it.
An earlier revision of the template cache trusted that invariant instead of
re-deriving it, which would have turned a loud assert into silently wrong
bindings on a cache hit for any future caller that broke the shape. The
templated binding path now makes the same check -- a column count per entry,
plus a presence check per expected column.

On the production-shaped wave, which binds 787 multi-constraint entries, the
guard is invisible: 37.30 ms without it, 37.32 ms with it, under 0.1% of the
wave.

Priced on a pathological wave that is nothing but arity-126 multi-constraint
fetches -- 800 fetches, 100,800 entries checked per wave, single-column and
compound -- against the same branch with the guard removed:

| | median | min |
| --- | ---: | ---: |
| without guard | 95.7 ms | 94.4 ms |
| with guard | 96.4 ms | 95.4 ms |

**+1.2%** of a wave that does nothing else, or roughly 12 ns per entry. It stays
unconditional.

Both halves are load-bearing, and the test proves it: removing the count check
lets an entry with an extra column through, and removing the presence check lets
an entry with the right number of columns but a different one through.

## Not done, and why

**Templating cursor-paged fetches.** `gatherStartConstraints` derives its
comparison operators from the cursor row's values — a null bound emits
`IS NOT NULL`, or `FALSE`, or nothing at all — so the text depends on values and
the key would need a null mask over the ordering fields. Paging fetches do not
repeat a shape often enough to pay for that risk; in the replay they are 68 of
2,064 fetches.

**Per-row `performance.now()` in `LoggingIterableIterator.next`.** Two calls per
row, 7.8% of `#fetch` self time. `#sqliteRowTimeSum` and the total elapsed
measure genuinely different intervals, so collapsing them would change when the
`type=sqlite` warning fires.

---

# Merged branch notes: capy/streamer-batch

# `capy/streamer-batch` — hydration streaming allocation cuts

Three changes in `packages/zero-cache/src/services/view-syncer/pipeline-driver.ts`
that reduce per-row work in the `Streamer` path, plus a microbench that isolates
it. Output is byte-identical.

## Why this path

The 8-group CPU profile of the syncer shows `Streamer.stream` at 38.8% inclusive
and `Streamer.#streamNodes` at 36.2% inclusive, with GC at 7.6% self time. Almost
all of that is initial hydration, not push: one-group inclusive time for
`hydrateInternal` is 0.446 s against 0.444 s for `Streamer.stream`, so the two
frames are effectively the same stack. That also means the
`streamer.accumulate(queryID, schema, [change])` one-element array in the push
callback is *not* on the hot path — it costs one array per pushed change on a
path the profile barely reaches. It was left alone.

Most of the 36.2% inclusive is the lazy `fetch`/join work pulled *through*
`#streamNodes`, which no edit here can remove. What the Streamer itself owns is
per-row allocation and generator layering, and that is what these changes cut.

## The changes

**`getRowKey` builds the key with a loop.** It was
`Object.fromEntries(cols.map(col => [col, must(row[col])]))`: one array for the
pairs, one two-element array per primary-key column, then `Object.fromEntries`.
The loop allocates only the result object. This runs for every streamed row,
parent and child, so it is the broadest of the three.

**The relationship walk uses `Object.keys` instead of `Object.entries`.**
`Object.entries` allocates the outer array plus a two-element array per
relationship; `Object.keys` allocates only the outer array. Key order is
identical, so the recursion order into child relationships is unchanged.

**Initial hydration streams nodes without wrapping them in `Change` tuples.**
`hydrate`/`hydrateInternal` ran the fetched nodes through `toAdds`, which built a
`[ChangeType.ADD, node, null]` tuple per node, and `#streamChanges` then unwrapped
each tuple back into a fresh `() => [node]` one-element iterable for
`#streamNodes`. The new `Streamer.accumulateAdds` hands the node stream straight
to `#streamNodes` with `op = ADD`. Per top-level row this drops the tuple, the
closure, the one-element array and its iterator; and because `#streamChanges`
leaves the delegation chain, *every* row (child rows included) crosses one fewer
generator frame. `toAdds` is deleted.

This required hoisting the `system === 'permissions'` early return in
`#streamNodes` above the `#primaryKeys`/`#tableSpecs` lookups, so the new entry
point skips a permissions schema exactly as `#streamChanges` did. For a
non-permissions schema nothing changes; for a permissions schema both orders
return without emitting.

## Numbers

Microbench, `packages/zero-cache/src/services/view-syncer/streamer.bench.ts`.
Synthetic `Input`, node tree built once outside the loop, so this is Streamer
work only. 5000 rows per shape, median of 25+ samples, node v24.18.0.

| shape                        | before  | after    | change |
| ---------------------------- | ------- | -------- | ------ |
| 5000 rows, 0 children/parent | 2.82 ms | 0.94 ms  | −66.7% |
| 5000 rows, 1 child/parent    | 4.91 ms | 2.51 ms  | −48.9% |
| 5000 rows, 4 children/parent | 2.71 ms | 1.32 ms  | −51.3% |
| 5000 rows, 19 children/parent| 1.99 ms | 1.12 ms  | −43.7% |

End-to-end hydration through the real `PipelineDriver` against a seeded 61 MB
replica (20327 `problem` rows, 973 trackers, 973 conversations), 41 reps per
query, median / min wall time. This includes SQLite, joins and planning, so it
is the honest ceiling.

| query                              | rows  | before median | after median | change | before min | after min | change |
| ---------------------------------- | ----: | ------------: | -----------: | -----: | ---------: | --------: | -----: |
| flat scan of `problem`             | 20327 |     186.74 ms |    184.70 ms |  −1.1% |  179.84 ms | 174.44 ms |  −3.0% |
| tracker + conversations            |  1946 |      40.12 ms |     39.12 ms |  −2.5% |   36.06 ms |  35.25 ms |  −2.2% |
| tracker + problem + conversations  |  2919 |      63.57 ms |     58.66 ms |  −7.7% |   58.28 ms |  55.26 ms |  −5.2% |
| tracker WHERE EXISTS conversations |  1946 |      66.09 ms |     59.97 ms |  −9.3% |   61.59 ms |  56.68 ms |  −8.0% |
| assignment + problems + problem    |    71 |       2.08 ms |      1.94 ms |  −6.7% |    1.98 ms |   1.85 ms |  −6.6% |

Every shape improved on both median and min. The flat scan gains least because a
20327-row SQLite scan over a wide table dominates it; the nested and EXISTS
shapes, which are closer to the profiled workload, gain 5-9%.

## Equality proof

A scratch harness hydrated the five query shapes above through the real
`PipelineDriver` against the seeded replica, wrote every `RowChange` as one
canonical JSON line (recursively key-ordered, bigints stringified), and hashed
the stream. `'yield'` is skipped because its interleaving is wall-clock
dependent and never reaches the wire.

```
before: 27209 row changes  sha256 b788ab1ba2e17f2d42147ab715dd914bd6712efdf7be1aea988148f587458a9f
after:  27209 row changes  sha256 b788ab1ba2e17f2d42147ab715dd914bd6712efdf7be1aea988148f587458a9f
```

`diff before.jsonl after.jsonl` is empty. Since `RowChange` is what
`view-syncer.#processChanges` consumes, identical streams mean identical poke
content, ordering, chunking and CVR effects.

## Tests

- `pnpm --filter zero-cache run check-types` — clean
- `pnpm --filter zero-cache exec vitest run --project='*no-pg*'` — 132 files,
  1971 tests passed
- `pnpm --filter zero-cache exec vitest run --project='*pg-17*' src/services/view-syncer`
  — passed
- `pnpm --filter zero-cache run lint`, `oxfmt` — clean

## Rerunning

```bash
pnpm --filter zero-cache run bench streamer
```

The equality and end-to-end harnesses are scratch scripts, kept out of the
commit; they live with the numbers in `~/.capy/work/zc-streamer-results/`. Drop
`equality.ts`, `realistic.ts` and `queries.ts` into `packages/zero-cache/.scratch/`,
copy the seeded replica to `/tmp/assignment-replica.db`, then:

```bash
cd packages/zero-cache
node --experimental-strip-types .scratch/equality.ts /tmp/after.jsonl
node --experimental-strip-types .scratch/realistic.ts 41
```

## Risk

Low. One file, +38/−21, no public API change beyond a new method on a
module-private class. The one non-mechanical change is the reordered permissions
check described above; it is strictly more permissive and matches what
`#streamChanges` already did.

---

# Merged branch notes: capy/flipped-join-batch-cost

# `capy/flipped-join-batch-cost` — FlippedJoin batched-fetch per-row cost

Branch off `main` (`16019afa4`). One behavior-preserving change to
`packages/zql/src/ivm/flipped-join.ts`, plus one new benchmark file.

## Problem

`FlippedJoin.#fetchBatched` pays three allocations on every row it touches:
a tagged canonical key string per child row and per returned parent row, a
`number[]` of child indexes per distinct key, and a fresh `idxs.map(...)`
array per emitted parent. `#yieldParentWithOverlay` was a generator invoked
once per parent, so each parent also allocated a generator object and paid
`yield*` delegation.

## Mechanism

- Single-column joins — the common shape — key the dedupe/lookup `Map` on
  the value itself. `Map` already keys `1`, `'1'`, `1n` and `true` apart, so
  the type tag string is unnecessary. `null` and `undefined` still share one
  bucket, matching the compound path and the existing tests. JSON values
  keep the tagged string form because `Map` would otherwise key them by
  identity. Compound keys are unchanged.
- The map holds the grouped child `Node[]` directly, so the per-parent
  `idxs.map(i => childNodes[i])` array disappears. The group is only read by
  `#parentWithOverlay`, which copies before mutating (`filter` / spread).
- `#yieldParentWithOverlay` yielded zero or one node, so it became
  `#parentWithOverlay`, a plain method returning `Node | undefined`.

## Numbers

Machine-local, warm, same process shape on both sides; every comparison is
interleaved A/B with the file swapped between runs.

### Roster specimen (primary — profiler's exact post-auth `assignment.roster` AST)

`hydrate-profile.mjs --specimen roster --warmup 2 --iterations 120 --mode full`,
1,118 rows per hydration, 10 processes per side, run once in each A/B order:

| Order | base median-of-medians | opt median-of-medians | Delta |
|---|---:|---:|---:|
| base first | 33.23 ms | 32.42 ms | −2.4% |
| opt first | 33.55 ms | 32.35 ms | −3.7% |

CPU profile of the same loop (500 µs sampling, 120 iterations):

| Frame (self time) | base | opt |
|---|---:|---:|
| `#fetchBatched` | 3.2% | 1.7% |
| `#yieldParentWithOverlay` → `#parentWithOverlay` | 1.5% | 1.2% |
| `fetch` | 1.0% | 0.8% |
| **FlippedJoin JS body total** | **5.7%** | **3.7%** |
| `FlippedJoin.fetch` inclusive | 30.3% | 28.4% |

That loop still spends ~19% in native `prepare` and ~33% in the planner, so
the 2.0 points removed from FlippedJoin's own body are a larger share of
what remains once planner caching lands.

### Tracker specimen (secondary — dominated by other work)

`--specimen tracker`: no end-to-end delta outside noise (medians 270/275 ms
base vs 275/270 ms opt across four profiled processes). The profile shows
the code path itself got cheaper — FlippedJoin JS self time 2.8% → 2.2% —
but the tracker loop is dominated by a per-tracker authorization N+1 under
the join, so 0.6 points is not measurable end to end. This specimen is not
evidence for or against the change.

### Repo benchmarks

`pnpm --filter zql-benchmarks bench`, 5 rounds per side, comparing the
fastest iteration of each case (bench medians are noisy at 5–25 samples):

| Case | base min | opt min | Delta |
|---|---:|---:|---:|
| keys: 1000 unique string keys | 5.403 ms | 5.019 ms | −7.1% |
| keys: 50 string keys × 20 children | 4.976 ms | 4.547 ms | −8.6% |
| keys: 1000 compound (string,string) | 7.131 ms | 7.150 ms | +0.3% |
| batching: 1,000 / 2,500 / 5,000 / 10,000 rows | — | — | −1.7% … −5.6% |
| merge: 100 … 10,000 rows | — | — | −3.8% … −10.7% |

`flipped-join-keys.bench.ts` is new: the two existing flipped-join benches
only cover integer keys at a 1:1 ratio, so neither exercises string keys,
duplicate parent keys, or the compound-key path.

### Targeted microbench (seeded tracker replica, join isolated)

`FlippedJoin.fetch` driven directly over `assignment-replica.db`, 8 rounds
per side, median of per-process medians:

| Shape | base | opt | Delta |
|---|---:|---:|---:|
| tracker × conversation, 973 unique string keys | 6.70 ms | 6.34 ms | −5.5% |
| tracker × assessment, 957 unique string keys | 5.45 ms | 5.36 ms | −1.5% (min −5.3%) |
| tracker × conversation by student, 58 keys / 973 children | 5.01 ms | 4.66 ms | −6.9% |
| tracker × conversation, compound (student_id,id) | 7.58 ms | 7.47 ms | −1.4% |
| in-memory sources, 973 unique string keys (no SQLite) | 3.61 ms | 3.19 ms | −11.7% |
| in-memory sources, 58 keys / 973 children (no SQLite) | 0.42 ms | 0.30 ms | −29.6% |

## Equality evidence

A harness serialized every fetched row, in order, with each relationship
expanded, over 5 join shapes (single string key, unique and duplicate;
compound key; numeric key) × 8 request variants (plain, `reverse`, four
`constraint` shapes, `start` at/after, reverse+start) × 3 chunk sizes (64,
256, and one larger than the key set, so both the single-fetch and the
`mergeSortedStreams` chunked path are covered). Output: 537,144 lines /
97,438,814 bytes, `sha256
7eb190909c104b1fe6d9ccc1e59f63e64402277a2d1e0f29744435d9010a3f1a`,
identical before and after.

Suites, all unmodified and green: `pnpm --filter zql test` (1,316 passed),
`pnpm --filter zqlite-zql-test test` (1,316 passed),
`pnpm --filter zql-integration-tests test` (1,165 passed, including
`Flip-invariance — every flip plan of an EXISTS query hydrate-equal over
mini` and the random-yield push/hydrate parity fuzzers),
`pnpm --filter zql check-types`, `pnpm --filter zero-cache check-types`,
`pnpm --filter zql-benchmarks check-types`, lint and format clean.

## Risk

The one behavior worth naming in review: the grouped child array is now
shared by every parent row with the same key instead of being rebuilt per
parent. `#parentWithOverlay` only reads it and copies before mutating, and
the relationship closure already returned the same array on repeated calls,
but a downstream consumer that mutated a relationship stream in place would
now be visible across parents. Nothing in the tree does.

Ideas measured and dropped for being noise: skipping the `buildJoinConstraint`
object for duplicate parent keys (0.0% on the duplicate-key shape).

## Rerun

```bash
# Roster specimen A/B (needs the zc-prof kit and a copied replica).
.fjscratch/ab-roster.sh /tmp/fj-base.ts base /tmp/fj-final.ts opt 10

# Repo benches.
pnpm --filter zql-benchmarks bench
pnpm --filter zql-benchmarks exec vitest run --config vitest.config.bench.ts \
  src/flipped-join-keys.bench.ts

# Equality hash and suites.
node .fjscratch/fj-golden.ts
pnpm --filter zql test && pnpm --filter zqlite-zql-test test
```

The scratch harnesses (`fj-bench.ts`, `fj-golden.ts`, `ab*.sh`) and the raw
result files live in `~/.capy/work/zc-fj-results/`; they are deliberately not
committed.

---

# Merged branch notes: capy/syncer-observability

# capy/syncer-observability

Production can currently see that a query wave was slow. It cannot see whether
the wave was slow because the query was expensive or because the sync worker
serving it was already busy with other client groups. This branch closes that
gap, and fixes one metric label that has been recording `undefined` since a
refactor.

Three commits, in order:

1. `fix(zero-cache): restore change-type attribution on ivm.advance-time`
2. `feat(zero-cache): export wave wall time, lock hold, and slice-queue pressure`
3. `feat(zero-cache): monitor event-loop delay and utilization per sync worker`

No behavior changes. Nothing schedules differently, no worker counts move, no
query path is altered. Every change either records a value that was already
computed or samples a Node API.

## Per-worker attribution is already a resource attribute

The task asked for a worker-index label on the sync-path metrics. That label
would be redundant, because `server/otel-start.ts:50-61` already stamps every
metric, trace, and log emitted from a sync worker process with the OTel
**resource** attributes `process.worker` and `process.worker_index`, derived
from the ordinal that `server/main.ts:154-174` passes to each forked syncer and
`server/syncer.ts:74-89` parses. Adding the same dimension as a metric label
would duplicate a resource dimension, inflate every series, and diverge from
the convention the repository already follows: `pipelines_total` and friends
document themselves as "on this worker" and carry no worker label for exactly
this reason.

The live capture confirms it end to end: every data point in
`capture/metrics-n8.txt` arrives under `process.worker=syncer,
process.worker_index=0`, and the dispatcher, change-streamer, and replicator
each export under their own resource.

**Limitation, pre-existing.** In `SINGLE_PROCESS` mode the workers run inside
one process (`types/processes.ts:196-212`) and the dispatcher wins the
`OtelManager` singleton, so that process reports `dispatcher/0` for everything.
Per-worker attribution is meaningful in normal multiprocess mode only, which is
how the hosted provider runs. This branch does not change that.

## Metric inventory

New in this branch:

| Metric | Type | Labels | Cardinality bound | Question it answers |
|---|---|---|---|---|
| `zero.sync.wave.wall-time` | histogram, s | `type` = `query-sync` \| `advance` | 2 | How long did a wave actually take, wall clock, through `pokeEnd`? Compared against `hydration-time` / `advance-time` it separates cost from queueing. |
| `zero.sync.wave.rows` | counter, `{row}` | `type` = `query-sync` \| `advance` | 2 | How much work was in the wave, after batched de-duplication? Distinguishes an expensive wave from a slow one. |
| `zero.sync.lock-hold-time` | histogram, s | none | 1 | How long did the client-group lock stay held? Paired with the existing `lock-wait-time` it shows the lock is held while descheduled rather than contended. |
| `zero.sync.ivm.slice-wait-time` | histogram, s | none | 1 | How long did a ViewSyncer wait for its turn on the worker-wide time-slice queue? This is pure scheduler delay. |
| `zero.sync.ivm.slice-queue-depth` | histogram, `{slice}` | none | 1 | How many peers was it queued behind? Its `count` is also the worker's slice throughput. |
| `zero.server.event_loop_delay` | gauge, ms | `stat` = `mean` \| `p50` \| `p99` \| `max` | 4 | Is this worker's loop saturated, independent of any query? |
| `zero.server.event_loop_utilization` | gauge, ratio | none | 1 | What fraction of the interval was the loop active rather than idle? |

Fixed in this branch:

| Metric | Type | Labels | Cardinality bound | What changed |
|---|---|---|---|---|
| `zero.sync.ivm.advance-time` | histogram, s | `table`, `type` = `add` \| `remove` \| `edit` | tables x 3 | `type` was declared and never assigned, so every observation recorded `undefined`. |

Already existed, and already per-worker through the resource, so this branch
deliberately adds nothing for them:

| Requested signal | Existing metric |
|---|---|
| CPU-ish query processing time (`TimeSliceTimer` total) | `zero.sync.hydration-time`, `zero.sync.advance-time` |
| Whole-wave latency including transform and `pokeEnd` | `zero.sync.view_syncer_hydration` |
| CVR flush timing | `zero.sync.cvr.flush-time{flush.type}` |
| Poke timing and poked rows | `zero.sync.poke.time`, `zero.sync.poke.rows` |
| Live client groups per worker | `zero.sync.active-client-groups` |
| Lock acquisition wait | `zero.sync.lock-wait-time` |

## Cardinality discipline

No client-group ID and no query name or hash appears as a label on any metric,
new or existing. Custom query names are derived from registry object paths and
typed as a plain `v.string()` in `zero-protocol/src/custom-queries.ts` with no
length or charset bound, so they are client-supplied and unbounded by
construction; they stay in logs, spans, and lifecycle state where they already
live. Every label this branch adds is a closed enum of at most four values,
except `ivm.advance-time`'s pre-existing `table`, which is bounded by the
replicated schema.

## Where the instrumentation sits

- **Wave wall and rows.** `#syncQueryPipelineSet` and `#advancePipelines` both
  already computed `wallTime` and logged it; `#processChanges` already computed
  the de-duplicated row total for a span attribute. The change returns that
  total and records both values after `pokeEnd`.
- **Lock hold.** `#runInLockWithCVR` records from lock acquisition to release in
  a `finally`, so early returns and thrown protocol errors are included.
- **Slice queue.** Instrumented inside the module-level `yieldProcess`, the one
  choke point every yield goes through, so hydration, advancement, and change
  processing are all covered by one measurement. Depth is sampled before the
  waiter increments, so an uncontended slice reports 0. The wait is measured
  outside the `TimeSliceTimer` lap, which is why it does not perturb
  `hydration-time`.
- **Event loop.** `observability/event-loop.ts`, started and stopped with the
  `Syncer`. The delay histogram is reset after each observation and utilization
  is differenced against the previous one, so both describe the last collection
  interval instead of the process lifetime. Values have a 10 ms floor: the
  monitor measures the interval between its own timer fires, so an idle loop
  reads as one sampling resolution rather than zero.

## Live capture

Rig: `zcbaseline` Postgres created from the goblins template and seeded with the
wave-replay fixture (973 problem trackers, 973 conversations, 957 mastery
assessments, 136 students, 5 classes), the goblins transform server on 49800,
and zero-cache from this branch on 49700 with `ZERO_NUM_SYNC_WORKERS=1`,
exporting OTLP/JSON every 5 s. N fresh client groups each register the six
assignment-page roots in one same-tick batch. Full output in `capture/`.

Three runs at each concurrency, so 3, 12, and 24 waves respectively:

| N | `wave.wall-time` avg | `hydration-time` avg | wall / CPU | `slice-queue-depth` avg / max | `slice-wait-time` avg | `lock-hold-time` avg | `lock-wait-time` avg | utilization peak |
|---|---|---|---|---|---|---|---|---|
| 1 | 541 ms | 437 ms | 1.24x | 0.00 / 0 | 0.9 ms | 155 ms | 0.1 ms | 0.15 |
| 4 | 1883 ms | 415 ms | 4.5x | 2.74 / 3 | 43.7 ms | 527 ms | 0.1 ms | 0.50 |
| 8 | 3635 ms | 397 ms | 9.2x | 6.24 / 7 | 97.6 ms | 1174 ms | 0.1 ms | 0.74 |

CPU per wave is flat while wall time grows 6.7x, and queue depth tracks N-1
exactly. That is the mechanism the diagnosis inferred, now visible directly.
The lock columns settle the question the diagnosis flagged: hold time grows
with N while wait time stays at a tenth of a millisecond, so the client-group
lock is held through descheduling and is never contended.

`zero.sync.active-client-groups` peaks at 1, 4, and 8 respectively, which is the
per-worker load shape the operational conversation needs.

The advance path was exercised separately by holding one client group open and
mutating its rows upstream (`capture/metrics-advance.txt`):

```
zero.sync.ivm.advance-time{table=problem_tracker,type=edit}      count=2
zero.sync.ivm.advance-time{table=problem_tracker,type=remove}    count=1
zero.sync.ivm.advance-time{table=problem_tracker,type=add}       count=1
zero.sync.ivm.advance-time{table=conversation,type=edit}         count=1
zero.sync.ivm.advance-time{table=mastery_assessment,type=remove} count=1
zero.sync.wave.wall-time{type=advance}                           count=4
zero.sync.wave.rows{type=advance}                                14
```

Before the fix all six of those series were one series labelled
`type=undefined`.

## Overhead

Measured against `origin/main` in a second worktree, alternating arms and
alternating which arm went first, four pairs of 24 client samples each at N=8
(`capture/ab-overhead.txt`):

| pair | order | main median | branch median | delta |
|---|---|---|---|---|
| 7 | branch first | 4.821 s | 4.964 s | +3.0% |
| 8 | branch first | 4.847 s | 4.872 s | +0.5% |
| 9 | main first | 4.943 s | 4.781 s | -3.3% |
| 10 | main first | 4.790 s | 4.747 s | -0.9% |

Pooled, main 4.875 s against branch 4.813 s over 96 samples per arm, a delta of
-1.3%. The sign flips between pairs, so the effect is inside the cell-to-cell
noise of the harness. Server-side over the same 96 waves per arm,
`zero.sync.hydration-time` averages 385.6 ms on main and 383.2 ms on the branch,
and `zero.sync.view_syncer_hydration` 3606.7 ms against 3593.5 ms.

This is what the placement predicts. The added work is two `performance.now()`
calls and two histogram records per time slice, the capture shows about 27
slices per wave, and all of it runs while the `TimeSliceTimer` lap is stopped,
so it is outside the interval `hydration-time` measures.

## Validation

```bash
pnpm --filter zero-cache check-types
pnpm --filter zero-cache exec vitest --project='*no-pg*' run \
  src/services/view-syncer/ src/workers/ src/observability/
pnpm --filter zero-cache exec vitest --project='*pg-16*' run src/services/view-syncer/
pnpm exec oxlint --quiet --config oxlint.config.ts packages/zero-cache/src
pnpm exec oxfmt --check packages/zero-cache/src
git diff --check
```

New tests:

- `services/view-syncer/pipeline-driver.metrics.test.ts` drives real
  transactions through an in-memory OTel exporter and asserts the exported
  `{table, type}` label sets, including that a primary-key change records one
  remove and one add. Both cases fail on the pre-fix code with
  `comments/undefined`.
- `services/view-syncer/view-syncer.metrics.test.ts` asserts an uncontended
  slice reports depth 0 and that two `TimeSliceTimer`s started in the same tick
  produce exactly one sample of depth 1.
- `observability/event-loop.test.ts` saturates the loop and asserts the delay
  reported is the loop's, not the monitor's own sampling resolution, and that
  stopping the monitor removes both callbacks.

## Rerunning the capture

```bash
docker exec goblins-postgres psql -U postgres \
  -c 'CREATE DATABASE zcbaseline TEMPLATE goblins;'
# harness from the fork's capy/zc-baseline-harness branch
git archive origin/capy/zc-baseline-harness packages/zero-cache/bench/wave-replay | tar -x -C /tmp/
bash /tmp/packages/zero-cache/bench/wave-replay/seed/apply-seed.sh \
  'postgresql://postgres:postgres@localhost:5432/zcbaseline?sslmode=disable' 16

# scripts used for this capture, on the run machine
~/work/zcbench/run-transform-server.sh   # goblins server on 49800, dev secrets
~/work/zcbench/otlp-sink.mjs             # OTLP/JSON sink -> jsonl
~/work/zcbench/run-matrix.sh <label> <checkout> <clients> <runs>
~/work/zcbench/run-advance-demo.sh       # holds a group open and mutates upstream
node ~/work/zcbench/summarize-metrics.mjs metrics-<label>.jsonl 'zero\.'
```

zero-cache needs `OTEL_METRICS_EXPORTER=otlp`,
`OTEL_EXPORTER_OTLP_PROTOCOL=http/json`,
`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://localhost:4318/v1/metrics` and
`OTEL_METRIC_EXPORT_INTERVAL=5000`; `OTEL_METRICS_EXPORTER=console` also works
for a quick look but ignores the interval and does not show resource
attributes.
