import {afterAll, beforeAll} from 'vitest';
import {bench, describe, use} from '../../../shared/src/bench.ts';
import {createSilentLogContext} from '../../../shared/src/logging-test-utils.ts';
import {Database} from '../../../zqlite/src/db.ts';
import {INSERT_BATCH_SIZE} from '../services/change-source/pg/initial-sync.ts';

const ROWS = 10_000;
const COLUMNS = 8;
const values = Array.from({length: ROWS * COLUMNS}, (_, i) => i);

function runFlush(batchSize: number, pendingValues: number[]) {
  const db = new Database(createSilentLogContext(), ':memory:');
  try {
    db.exec(
      `CREATE TABLE t(${Array.from({length: COLUMNS}, (_, i) => `c${i} INTEGER`).join(',')})`,
    );
    const valuesSql = `(${'?,'.repeat(COLUMNS - 1)}?)`;
    const insertSql = `INSERT INTO t VALUES ${valuesSql}`;
    const insertStmt = db.prepare(insertSql);
    const insertBatchStmt = db.prepare(
      insertSql + `,${valuesSql}`.repeat(batchSize - 1),
    );

    db.transaction(() => {
      let pendingRows = ROWS;
      let l = 0;
      const valuesPerBatch = COLUMNS * batchSize;
      for (; pendingRows > batchSize; pendingRows -= batchSize) {
        insertBatchStmt.run(pendingValues.slice(l, (l += valuesPerBatch)));
      }
      for (; pendingRows > 0; pendingRows--) {
        insertStmt.run(pendingValues.slice(l, (l += COLUMNS)));
      }
    });
    return db.prepare('SELECT COUNT(*) AS count FROM t').get();
  } finally {
    db.close();
  }
}

function runFlushWithScratch(batchSize: number, pendingValues: number[]) {
  const db = new Database(createSilentLogContext(), ':memory:');
  try {
    db.exec(
      `CREATE TABLE t(${Array.from({length: COLUMNS}, (_, i) => `c${i} INTEGER`).join(',')})`,
    );
    const valuesSql = `(${'?,'.repeat(COLUMNS - 1)}?)`;
    const insertSql = `INSERT INTO t VALUES ${valuesSql}`;
    const insertStmt = db.prepare(insertSql);
    const insertBatchStmt = db.prepare(
      insertSql + `,${valuesSql}`.repeat(batchSize - 1),
    );
    const scratch = Array.from({length: COLUMNS * batchSize});

    db.transaction(() => {
      let pendingRows = ROWS;
      let l = 0;
      const valuesPerBatch = COLUMNS * batchSize;
      for (; pendingRows > batchSize; pendingRows -= batchSize) {
        for (let i = 0; i < valuesPerBatch; i++) {
          scratch[i] = pendingValues[l + i];
        }
        l += valuesPerBatch;
        insertBatchStmt.run(scratch);
      }
      for (; pendingRows > 0; pendingRows--) {
        for (let i = 0; i < COLUMNS; i++) {
          scratch[i] = pendingValues[l + i];
        }
        l += COLUMNS;
        insertStmt.run(scratch.slice(0, COLUMNS));
      }
    });
    return db.prepare('SELECT COUNT(*) AS count FROM t').get();
  } finally {
    db.close();
  }
}

describe('initial-sync sqlite batch insert benchmark', () => {
  let result: unknown;

  beforeAll(() => {
    result = runFlush(INSERT_BATCH_SIZE, values);
  });

  afterAll(() => {
    use(result);
  });

  bench(
    'current 50-row INSERT batches',
    () => {
      result = runFlush(INSERT_BATCH_SIZE, values);
      return use(result);
    },
    {min_cpu_time: 500_000_000, min_samples: 20},
  );

  bench(
    'larger 200-row INSERT batches',
    () => {
      result = runFlush(200, values);
      return use(result);
    },
    {min_cpu_time: 500_000_000, min_samples: 20},
  );

  bench(
    'current 50-row batches with scratch array reuse',
    () => {
      result = runFlushWithScratch(INSERT_BATCH_SIZE, values);
      return use(result);
    },
    {min_cpu_time: 500_000_000, min_samples: 20},
  );
});
