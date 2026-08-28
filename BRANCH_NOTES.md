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
