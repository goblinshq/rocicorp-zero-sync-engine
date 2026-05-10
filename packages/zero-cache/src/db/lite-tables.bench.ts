import {afterAll, beforeAll} from 'vitest';
import {bench, describe, use} from '../../../shared/src/bench.ts';
import {createSilentLogContext} from '../../../shared/src/logging-test-utils.ts';
import {must} from '../../../shared/src/must.ts';
import {Database} from '../../../zqlite/src/db.ts';
import {
  ColumnMetadataStore,
  CREATE_COLUMN_METADATA_TABLE,
  metadataToLiteTypeString,
} from '../services/replicator/schema/column-metadata.ts';
import {CREATE_TABLE_METADATA_TABLE} from '../services/replicator/schema/table-metadata.ts';

type ColumnInfo = {
  table: string;
  name: string;
  type: string;
};

const NUM_TABLES = 100;
const NUM_COLUMNS = 20;

function createBenchDb() {
  const db = new Database(createSilentLogContext(), ':memory:');
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

    for (let columnIndex = 0; columnIndex < NUM_COLUMNS; columnIndex++) {
      store.insert(
        tableName,
        `col_${columnIndex}`,
        {
          pos: columnIndex + 1,
          dataType: 'text',
          notNull: columnIndex === 0,
        },
        columnIndex === 1 && tableIndex % 10 === 0
          ? {backfill: tableIndex}
          : undefined,
      );
    }
  }
  return db;
}

function listColumns(db: Database) {
  return db
    .prepare(
      `
      SELECT
        m.name as "table",
        p.name as name,
        p.type as type
      FROM sqlite_master as m
      LEFT JOIN pragma_table_info(m.name) as p
      WHERE m.type = 'table'
      AND m.name NOT LIKE 'sqlite_%'
      AND m.name NOT LIKE '_zero.%'
      AND m.name NOT LIKE '_litestream_%'
      `,
    )
    .all() as ColumnInfo[];
}

function legacyPerColumnMetadataLookup(db: Database) {
  const columns = listColumns(db);
  const store = must(ColumnMetadataStore.getInstance(db));
  let backfilling = 0;
  let typeBytes = 0;
  for (const col of columns) {
    const tableExists = db
      .prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_zero.column_metadata'`,
      )
      .get();
    const metadata = tableExists
      ? store.getColumn(col.table, col.name)
      : undefined;
    const dataType = metadata ? metadataToLiteTypeString(metadata) : col.type;
    typeBytes += dataType.length;
    if (metadata?.isBackfilling) {
      backfilling++;
    }
  }
  return {columns: columns.length, backfilling, typeBytes};
}

function batchedMetadataLookup(db: Database) {
  const columns = listColumns(db);
  const store = must(ColumnMetadataStore.getInstance(db));
  const metadataByTable = new Map<
    string,
    ReturnType<ColumnMetadataStore['getTable']>
  >();
  let backfilling = 0;
  let typeBytes = 0;
  for (const col of columns) {
    let tableMetadata = metadataByTable.get(col.table);
    if (!tableMetadata) {
      tableMetadata = store.getTable(col.table);
      metadataByTable.set(col.table, tableMetadata);
    }
    const metadata = tableMetadata.get(col.name);
    const dataType = metadata ? metadataToLiteTypeString(metadata) : col.type;
    typeBytes += dataType.length;
    if (metadata?.isBackfilling) {
      backfilling++;
    }
  }
  return {
    tables: metadataByTable.size,
    columns: columns.length,
    backfilling,
    typeBytes,
  };
}

describe('lite-tables metadata benchmark', () => {
  let db: Database;

  beforeAll(() => {
    db = createBenchDb();
  });

  afterAll(() => {
    db.close();
  });

  bench(
    'legacy per-column metadata lookup',
    () => use(legacyPerColumnMetadataLookup(db)),
    {min_cpu_time: 500_000_000, min_samples: 20},
  );

  bench('batched metadata lookup', () => use(batchedMetadataLookup(db)), {
    min_cpu_time: 500_000_000,
    min_samples: 20,
  });
});
