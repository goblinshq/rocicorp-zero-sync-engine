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
