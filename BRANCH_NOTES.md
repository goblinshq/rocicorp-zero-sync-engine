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
