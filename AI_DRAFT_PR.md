# AI-Generated Draft PR

> **⚠️ WARNING: This PR is AI-generated and the code is NOT necessarily correct.** This is being used more like an issue report with a concrete code suggestion. The Zero/Rocicorp team should review the approach carefully before merging.

## Problem: Zero Planner Does Not Auto-Flip Selective Correlated EXISTS Subqueries

### Background

In our production app (Goblins, an AI tutoring platform), we have a membership query that checks whether an assignment is visible to a student via three alternative paths:

```ts
.where(({ or, exists }) =>
  or(
    exists("students", (students) => students.where("student_id", "=", args.student_id)),
    exists("classes", (assignment_classes) =>
      assignment_classes.whereExists("class", (class_query) =>
        class_query.whereExists("students", (class_students) =>
          class_students.where("student_id", "=", args.student_id)
        )
      )
    ),
    exists("groups", (assignment_groups) =>
      assignment_groups.whereExists("group", (group_query) =>
        group_query.whereExists("students", (group_students) =>
          group_students.where("student_id", "=", args.student_id)
        )
      )
    )
  )
)
```

**Without manual `{flip: true}` on each `exists` call**, the planner generates an extremely slow query that scans the entire `assignments` table and probes each child table per row. **With manual flips**, the query is instant (orders of magnitude faster).

### Root Cause

The SQLite cost model in `packages/zqlite/src/sqlite-cost-model.ts` uses `removeCorrelatedSubqueries()` to strip EXISTS/NOT EXISTS conditions before passing filters to SQLite's `scanstatus` API. This is correct: SQLite scanstatus cannot handle correlated subqueries.

However, the side effect is devastating: if a query has **only** correlated subquery conditions (no simple conditions), `removeCorrelatedSubqueries()` removes all filters, and the cost model returns the full table scan row count. This means:

1. `costWithFilters.rows` = full table scan (e.g., 10,000 rows)
2. `costWithoutFilters.rows` = full table scan (e.g., 10,000 rows)
3. `selectivity = costWithFilters.rows / costWithoutFilters.rows = 1.0`

The planner's `PlannerConnection` (in `planner-connection.ts:124-136`) computes `this.selectivity` from this ratio. With selectivity = 1.0, the planner thinks the EXISTS condition is completely unselective (passes all rows). The planner's join cost estimator (`planner-join.ts:319`) then computes:

```
scaledChildSelectivity = 1 - (1 - child.selectivity)^fanout = 1 - (1 - 1.0)^fanout = 1.0
```

With scaledChildSelectivity = 1.0, the semi-join cost and flipped-join cost are nearly equal, so the planner has no incentive to flip. But in reality, the EXISTS condition is highly selective (e.g., only 5% of assignments belong to a specific student).

### The Fix

After `removeCorrelatedSubqueries()` strips the subqueries and scanstatus gives us the base row count, we **recursively estimate the selectivity of the correlated subquery conditions** and apply it to reduce the row estimate.

For each `EXISTS` correlated subquery:

1. Recursively call the cost model on the child table **without** the correlation constraint to get:
   - `childWithFilters.rows` = child rows matching the subquery's WHERE clause
   - `childWithoutFilters.rows` = total child rows
2. Compute `childSelectivity = childWithFilters.rows / childWithoutFilters.rows`
3. Get the fanout (average child rows per parent key) from `SQLiteStatFanout`
4. Compute parent match probability: `1 - (1 - childSelectivity)^fanout` (same formula as `planner-join.ts:319`)

For `NOT EXISTS`, we return selectivity = 1.0 since the planner never flips NOT EXISTS joins.

For `AND`/`OR`, we combine selectivities assuming independence (same assumption as the rest of the planner).

**Critical detail**: We do NOT pass the correlation fields as a constraint when computing child selectivity. The correlation constraint is a join condition (every parent row matches exactly one child row via it), not a filter. Passing it causes a PK lookup returning 1 row, making `childSelectivity = 1/1 = 1.0`.

### Test Coverage

1. **Unit tests** (`sqlite-cost-model.test.ts`): 3 new tests in `describe('correlated subquery selectivity')`:
   - `EXISTS-only filter reduces row estimate below full scan`
   - `mixed simple + correlated conditions are more selective`
   - `OR of EXISTS branches computes union selectivity`

2. **Planner-level test** (`planner-controlled.test.ts`): New test demonstrating that a selective correlated subquery cost model causes the planner to auto-flip, without requiring manual `{flip: true}`.

### Impact

This fix means Zero users no longer need to manually add `{flip: true}` to every `whereExists` call in OR-based membership queries. The planner will automatically choose the correct join direction based on actual selectivity.

### Limitations & Open Questions

1. **Independence assumption**: We assume AND/OR selectivities are independent, same as the rest of the planner. This is a known limitation.

2. **Recursion depth**: Very deep nesting could cause many recursive cost model calls. We track visited keys to prevent infinite loops and return `CYCLE_DEFAULT_SELECTIVITY = 0.5` on cycles.

3. **Fanout confidence**: When `SQLiteStatFanout` returns `confidence: 'none'`, the fanout estimate may be inaccurate. This is the same limitation that exists for all fanout-based cost estimation in the planner.

4. **Why not fix in the planner instead?**: The planner's `PlannerConnection` computes selectivity from cost model results. The fix belongs in the cost model because that's where `removeCorrelatedSubqueries()` strips the information. The planner has no way to know about correlated subquery selectivity unless the cost model provides it.

5. **SELECTIVITY_PLAN.md**: The design doc in `packages/zql/src/planner/SELECTIVITY_PLAN.md` describes the fan-out formula relationship between filter selectivity and semi-join selectivity. Our fix uses this same formula at the cost model level.
