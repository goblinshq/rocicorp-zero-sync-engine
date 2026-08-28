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
