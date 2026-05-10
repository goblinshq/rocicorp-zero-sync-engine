import {bench, describe, use} from '../../../shared/src/bench.ts';
import {createSilentLogContext} from '../../../shared/src/logging-test-utils.ts';
import {must} from '../../../shared/src/must.ts';
import {Database} from '../../../zqlite/src/db.ts';
import {
  ColumnMetadataStore,
  CREATE_COLUMN_METADATA_TABLE,
} from '../services/replicator/schema/column-metadata.ts';
import {CREATE_TABLE_METADATA_TABLE} from '../services/replicator/schema/table-metadata.ts';
import {createLiteIndexStatement} from './create.ts';
import {
  computeZqlSpecs,
  computeZqlSpecsFromLiteSpecs,
  listIndexes,
  listTables,
} from './lite-tables.ts';
import type {LiteAndZqlSpec, LiteTableSpec} from './specs.ts';

const NUM_TABLES = 100;
const NUM_COLUMNS = 20;
const lc = createSilentLogContext();

type ZqlSpecInput = {
  tables: ReturnType<typeof listTables>;
  indexes: ReturnType<typeof listIndexes>;
};

function createBenchDb() {
  const db = new Database(lc, ':memory:');
  db.exec(CREATE_COLUMN_METADATA_TABLE);
  db.exec(CREATE_TABLE_METADATA_TABLE);
  const store = must(ColumnMetadataStore.getInstance(db));

  for (let tableIndex = 0; tableIndex < NUM_TABLES; tableIndex++) {
    const tableName = `table_${tableIndex}`;
    const columns = Array.from({length: NUM_COLUMNS}, (_, columnIndex) =>
      columnIndex === 0
        ? `"col_${columnIndex}" TEXT PRIMARY KEY`
        : `"col_${columnIndex}" TEXT`,
    );
    db.exec(`CREATE TABLE "${tableName}" (${columns.join(',')})`);
    db.exec(
      createLiteIndexStatement({
        tableName,
        name: `${tableName}_unique_col_1`,
        columns: {col_1: 'ASC'},
        unique: true,
      }),
    );

    for (let columnIndex = 0; columnIndex < NUM_COLUMNS; columnIndex++) {
      store.insert(tableName, `col_${columnIndex}`, {
        pos: columnIndex + 1,
        dataType: 'text',
        notNull: columnIndex <= 1,
      });
    }
  }
  return db;
}

function currentReloadSpecs(db: Database) {
  const zqlSpecs = computeZqlSpecs(lc, db, {
    includeBackfillingColumns: true,
  });
  const tableSpecs = new Map<string, LiteTableSpec>();
  for (let spec of listTables(db)) {
    if (!spec.primaryKey) {
      spec = {
        ...spec,
        primaryKey: [...(zqlSpecs.get(spec.name)?.tableSpec.primaryKey ?? [])],
      };
    }
    tableSpecs.set(spec.name, spec);
  }
  return tableSpecs.size;
}

function singleIntrospectionReloadSpecs(db: Database) {
  const fullTables = new Map<string, LiteTableSpec>();
  const zqlSpecs = computeZqlSpecs(
    lc,
    db,
    {includeBackfillingColumns: true},
    new Map(),
    fullTables,
  );
  const tableSpecs = new Map<string, LiteTableSpec>();
  for (let spec of fullTables.values()) {
    if (!spec.primaryKey) {
      spec = {
        ...spec,
        primaryKey: [...(zqlSpecs.get(spec.name)?.tableSpec.primaryKey ?? [])],
      };
    }
    tableSpecs.set(spec.name, spec);
  }
  return tableSpecs.size;
}

function prelistedReloadSpecs(input: ZqlSpecInput) {
  const fullTables = new Map<string, LiteTableSpec>();
  const zqlSpecs = computeZqlSpecsFromLiteSpecsForBench(input, fullTables);
  const tableSpecs = new Map<string, LiteTableSpec>();
  for (let spec of fullTables.values()) {
    if (!spec.primaryKey) {
      spec = {
        ...spec,
        primaryKey: [...(zqlSpecs.get(spec.name)?.tableSpec.primaryKey ?? [])],
      };
    }
    tableSpecs.set(spec.name, spec);
  }
  return tableSpecs.size;
}

function computeZqlSpecsFromLiteSpecsForBench(
  {tables, indexes}: ZqlSpecInput,
  fullTables: Map<string, LiteTableSpec>,
) {
  return computeZqlSpecsFromLiteSpecs(
    tables,
    indexes,
    {includeBackfillingColumns: true},
    new Map<string, LiteAndZqlSpec>(),
    fullTables,
    lc,
  );
}

describe('change-processor table spec reload benchmark', () => {
  const db = createBenchDb();
  const prelisted = {tables: listTables(db), indexes: listIndexes(db)};

  bench(
    'current reloadTableSpecs double listTables path',
    () => use(currentReloadSpecs(db)),
    {min_cpu_time: 500_000_000, min_samples: 20},
  );

  bench(
    'reuse fullTables from computeZqlSpecs',
    () => use(singleIntrospectionReloadSpecs(db)),
    {min_cpu_time: 500_000_000, min_samples: 20},
  );

  bench(
    'prelisted tables/indexes pure map work',
    () => use(prelistedReloadSpecs(prelisted)),
    {min_cpu_time: 500_000_000, min_samples: 20},
  );
});
