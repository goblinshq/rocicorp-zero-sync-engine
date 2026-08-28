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
