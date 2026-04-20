import SQLite3Database from '@rocicorp/zero-sqlite3';
import {assert} from '../../shared/src/asserts.ts';
import {must} from '../../shared/src/must.ts';
import type {Condition, Ordering} from '../../zero-protocol/src/ast.ts';
import type {SchemaValue} from '../../zero-types/src/schema-value.ts';
import type {
  ConnectionCostModel,
  CostModelCost,
} from '../../zql/src/planner/planner-connection.ts';
import type {PlannerConstraint} from '../../zql/src/planner/planner-constraint.ts';
import type {Database, Statement} from './db.ts';
import {compileInline} from './internal/sql-inline.ts';
import {buildSelectQuery, type NoSubqueryCondition} from './query-builder.ts';
import {SQLiteStatFanout} from './sqlite-stat-fanout.ts';

/**
 * Loop information returned by SQLite's scanstatus API.
 */
interface ScanstatusLoop {
  /** Unique identifier for this loop */
  selectId: number;
  /** Parent loop ID, or 0 for root loops */
  parentId: number;
  /** Estimated rows emitted per turn of parent loop */
  est: number;
  /** EXPLAIN text for this loop to determine: b-tree vs list subquery */
  explain: string;
}

/**
 * Default selectivity returned when a recursive cycle is detected
 * during correlated subquery selectivity estimation.
 */
const CYCLE_DEFAULT_SELECTIVITY = 0.5;

/**
 * Internal cost model function signature with recursion tracking.
 */
type InternalCostModel = (
  tableName: string,
  sort: Ordering,
  filters: Condition | undefined,
  constraint: PlannerConstraint | undefined,
  visited: Set<string>,
) => CostModelCost;

/**
 * Creates a SQLite-based cost model for query planning.
 * Uses SQLite's scanstatus API to estimate query costs based on the actual
 * SQLite query planner's analysis.
 *
 * For correlated subquery conditions (EXISTS/NOT EXISTS), the scanstatus API
 * cannot provide estimates since these are subqueries. Instead, we recursively
 * estimate their selectivity by calling the cost model on the child table,
 * computing child selectivity, and translating it to a parent match probability
 * using the fanout between parent and child.
 *
 * @param db Database instance for preparing statements
 * @param tableSpecs Map of table names to their table specs with ZQL schemas
 * @returns ConnectionCostModel function for use with the planner
 */
export function createSQLiteCostModel(
  db: Database,
  tableSpecs: Map<string, {zqlSpec: Record<string, SchemaValue>}>,
): ConnectionCostModel {
  const fanoutEstimator = new SQLiteStatFanout(db);

  // Inner function that supports recursion tracking for correlated
  // subquery selectivity estimation.
  const costModelImpl: InternalCostModel = (
    tableName,
    sort,
    filters,
    constraint,
    visited = new Set(),
  ) => {
    // Transform filters to remove correlated subqueries
    // The cost model can't handle correlated subqueries in scanstatus,
    // so we estimate cost without them and then apply selectivity adjustment.
    const noSubqueryFilters = filters
      ? removeCorrelatedSubqueries(filters)
      : undefined;

    // Build the SQL query using the same logic as actual queries
    const {zqlSpec} = must(tableSpecs.get(tableName));

    const query = buildSelectQuery(
      tableName,
      zqlSpec,
      constraint,
      noSubqueryFilters,
      sort,
      undefined, // reverse is undefined here
      undefined, // start is undefined here
    );

    // Use compileInline to inline actual values into the SQL for cost estimation.
    // This allows SQLite's query planner to see real values and make better decisions
    // about index usage and query plans. This is safe here because it's only used for
    // cost estimation, not for executing user-facing queries (which use parameterized
    // queries via the standard compile() function).
    const sql = compileInline(query);

    // Prepare statement to get scanstatus information
    const stmt = db.prepare(sql);

    // Get scanstatus loops from the prepared statement
    const loops = getScanstatusLoops(stmt);

    // Scanstatus should always be available - if we get no loops, something is wrong
    assert(
      loops.length > 0,
      `Expected scanstatus to return at least one loop for query: ${sql}`,
    );

    const ret = estimateCost(loops, (columns: string[]) =>
      fanoutEstimator.getFanout(tableName, columns),
    );

    // Estimate selectivity contribution from correlated subquery conditions
    // and apply it to reduce the row estimate. Without this, EXISTS-only
    // filters look unselective (selectivity=1.0) because scanstatus can't
    // see correlated subqueries.
    if (filters) {
      const correlatedSelectivity = estimateCorrelatedSelectivity(
        filters,
        tableName,
        sort,
        constraint,
        costModelImpl,
        fanoutEstimator,
        tableSpecs,
        visited,
      );
      if (correlatedSelectivity < 1.0) {
        ret.rows *= correlatedSelectivity;
      }
    }

    return ret;
  };

  // Return the public interface (without the visited parameter)
  return (tableName, sort, filters, constraint) =>
    costModelImpl(tableName, sort, filters, constraint, new Set());
}

/**
 * Estimates the selectivity contribution of correlated subquery conditions
 * within a filter tree.
 *
 * Selectivity = fraction of rows that pass the correlated subquery conditions.
 * This is used to adjust the row count from scanstatus (which cannot see
 * correlated subqueries) to account for their filtering effect.
 *
 * For each correlated subquery (EXISTS), we:
 * 1. Recursively call the cost model on the child table to estimate child selectivity
 * 2. Get the fanout (average child rows per parent key) from SQLite statistics
 * 3. Compute parent match probability using: 1 - (1 - childSelectivity)^fanout
 *    This is the same formula used in planner-join.ts for join cost estimation.
 *
 * For NOT EXISTS, we return 1.0 since the planner never flips NOT EXISTS joins.
 *
 * For AND/OR, we combine selectivities assuming independence (same assumption
 * as the rest of the planner).
 *
 * @param condition The condition tree to estimate selectivity for
 * @param parentTable The parent table name (used for recursion tracking)
 * @param sort Current ordering (passed to recursive cost model calls)
 * @param parentConstraint Current constraint (passed to recursive cost model calls)
 * @param costModel The internal cost model function (for recursive calls)
 * @param fanoutEstimator The fanout estimator (for getting fanout data)
 * @param tableSpecs Table specs (for recursive cost model calls)
 * @param visited Set of visited (parent:child:fields) keys to prevent infinite recursion
 * @returns Selectivity value between 0 and 1 (1 = no filtering, 0 = no rows pass)
 */
export function estimateCorrelatedSelectivity(
  condition: Condition,
  parentTable: string,
  sort: Ordering,
  parentConstraint: PlannerConstraint | undefined,
  costModel: InternalCostModel,
  fanoutEstimator: SQLiteStatFanout,
  tableSpecs: Map<string, {zqlSpec: Record<string, SchemaValue>}>,
  visited: Set<string>,
): number {
  switch (condition.type) {
    case 'simple':
      // Simple conditions are already accounted for by scanstatus
      return 1.0;

    case 'correlatedSubquery': {
      // NOT EXISTS joins are never flipped by the planner, so don't estimate
      if (condition.op === 'NOT EXISTS') {
        return 1.0;
      }

      const {related} = condition;
      const childTable = related.subquery.table;
      const childFields = [...related.correlation.childField];

      // Check for recursion to prevent infinite loops
      const visitedKey = `${parentTable}:${childTable}:${childFields.join(',')}`;
      if (visited.has(visitedKey)) {
        return CYCLE_DEFAULT_SELECTIVITY;
      }

      const newVisited = new Set(visited);
      newVisited.add(visitedKey);

      // Estimate child selectivity: fraction of child rows matching subquery filters.
      // We do NOT pass the correlation fields as a constraint here. The correlation
      // fields are the join condition (every parent row matches exactly one child row
      // via them), not a filter. Passing them would cause a PK/constraint lookup
      // returning 1 row, making childSelectivity = 1/1 = 1.0 regardless of the
      // actual subquery selectivity.
      //
      // What we want: what fraction of ALL child rows pass the subquery's WHERE?
      // That's childWithFilters.rows / childTotalRows.rows where neither call
      // includes the correlation constraint.
      const childWithFilters = costModel(
        childTable,
        related.subquery.orderBy ?? [],
        related.subquery.where,
        undefined, // no constraint: we want total child row counts
        newVisited,
      );
      const childWithoutFilters = costModel(
        childTable,
        related.subquery.orderBy ?? [],
        undefined, // no filters = all child rows
        undefined, // no constraint: we want total child row counts
        newVisited,
      );

      const childSelectivity =
        childWithoutFilters.rows > 0
          ? childWithFilters.rows / childWithoutFilters.rows
          : 1.0;

      // Get fanout for the correlation columns (average child rows per parent key)
      const fanoutResult = fanoutEstimator.getFanout(childTable, childFields);
      const fanout = fanoutResult.fanout;

      // Probability that at least one child matches a given parent row
      // Same formula as planner-join.ts line 319:
      //   1 - (1 - childSelectivity)^fanout
      const parentMatchProb = 1 - Math.pow(1 - childSelectivity, fanout);

      return parentMatchProb;
    }

    case 'and': {
      // AND: multiply selectivities (assuming independence)
      let selectivity = 1.0;
      for (const sub of condition.conditions) {
        selectivity *= estimateCorrelatedSelectivity(
          sub,
          parentTable,
          sort,
          parentConstraint,
          costModel,
          fanoutEstimator,
          tableSpecs,
          visited,
        );
      }
      return selectivity;
    }

    case 'or': {
      // OR: P(A or B) = 1 - P(not A) * P(not B) (assuming independence)
      let missProb = 1.0;
      for (const sub of condition.conditions) {
        const sel = estimateCorrelatedSelectivity(
          sub,
          parentTable,
          sort,
          parentConstraint,
          costModel,
          fanoutEstimator,
          tableSpecs,
          visited,
        );
        missProb *= 1 - sel;
      }
      return 1 - missProb;
    }
  }
}

/**
 * Removes correlated subqueries from conditions.
 * The cost model estimates cost without correlated subqueries since
 * they can't be included in the scanstatus query.
 */
function removeCorrelatedSubqueries(
  condition: Condition,
): NoSubqueryCondition | undefined {
  switch (condition.type) {
    case 'correlatedSubquery':
      // Remove subqueries - we can't estimate their cost via scanstatus
      return undefined;
    case 'simple':
      return condition;
    case 'and': {
      const filtered = condition.conditions
        .map(c => removeCorrelatedSubqueries(c))
        .filter((c): c is NoSubqueryCondition => c !== undefined);
      if (filtered.length === 0) return undefined;
      if (filtered.length === 1) return filtered[0];
      return {type: 'and', conditions: filtered};
    }
    case 'or': {
      const filtered = condition.conditions
        .map(c => removeCorrelatedSubqueries(c))
        .filter((c): c is NoSubqueryCondition => c !== undefined);
      if (filtered.length === 0) return undefined;
      if (filtered.length === 1) return filtered[0];
      return {type: 'or', conditions: filtered};
    }
  }
}

/**
 * Gets scanstatus loop information from a prepared statement.
 * Iterates through all query elements and extracts loop statistics.
 *
 * Uses SQLITE_SCANSTAT_COMPLEX flag (1) to get all loops including sorting operations.
 *
 * @param stmt Prepared statement to get scanstatus from
 * @returns Array of loop information, or empty array if scanstatus unavailable
 */
function getScanstatusLoops(stmt: Statement): ScanstatusLoop[] {
  const loops: ScanstatusLoop[] = [];

  // Iterate through query elements by incrementing idx until we get undefined
  // which indicates we've reached the end
  for (let idx = 0; ; idx++) {
    const selectId = stmt.scanStatus(
      idx,
      SQLite3Database.SQLITE_SCANSTAT_SELECTID,
      1,
    );

    if (selectId === undefined) {
      break;
    }

    loops.push({
      selectId: must(selectId),
      parentId: must(
        stmt.scanStatus(idx, SQLite3Database.SQLITE_SCANSTAT_PARENTID, 1),
      ),
      explain: must(
        stmt.scanStatus(idx, SQLite3Database.SQLITE_SCANSTAT_EXPLAIN, 1),
      ),
      est: must(stmt.scanStatus(idx, SQLite3Database.SQLITE_SCANSTAT_EST, 1)),
    });
  }

  return loops.sort((a, b) => a.selectId - b.selectId);
}

/**
 * Estimates the cost of a query based on scanstats from sqlite3_stmt_scanstatus_v2
 */
function estimateCost(
  scanstats: ScanstatusLoop[],
  fanout: CostModelCost['fanout'],
): CostModelCost {
  // Sort by selectId to process in execution order
  const sorted = scanstats.toSorted((a, b) => a.selectId - b.selectId);

  let totalRows = 0;
  let totalCost = 0;

  // Identify if there are multiple top-level (parentId=0) operations
  // If so, the first is typically the scan, and subsequent ones are sorts
  const topLevelOps = sorted.filter(s => s.parentId === 0);

  // We only consider top level ops since ZQL queries are single-table when hitting SQLite.
  // We do have a nested op in the case of `WHERE x IN (:arg)` but it is negligible
  // assuming :arg is small.
  let firstLoop = true;
  for (const op of topLevelOps) {
    if (firstLoop) {
      // First top-level op is the main scan
      // and determines the total number of rows output.
      totalRows = op.est;
      firstLoop = false;
    } else {
      if (op.explain.includes('ORDER BY')) {
        totalCost += btreeCost(totalRows);
      }
    }
  }

  return {
    rows: totalRows,
    startupCost: totalCost,
    fanout,
  };
}

export function btreeCost(rows: number): number {
  // B-Tree construction is ~O(n log n) so we estimate the cost as such.
  // We divide the cost by 10 because sorting in SQLite is ~10x faster
  // than bringing the data into JS and sorting there.
  return (rows * Math.log2(rows)) / 10;
}
