import {afterAll, beforeEach} from 'vitest';
import {bench, describe, use} from '../../../../shared/src/bench.ts';
import {createSilentLogContext} from '../../../../shared/src/logging-test-utils.ts';
import {Database} from '../../../../zqlite/src/db.ts';
import {StatementRunner} from '../../db/statements.ts';
import type {ChangeStreamData} from '../change-source/protocol/current/downstream.ts';
import {ChangeProcessor} from './change-processor.ts';
import {initReplicationState} from './schema/replication-state.ts';
import {ReplicationMessages} from './test-utils.ts';

const ROWS = 1000;
const messages = new ReplicationMessages({issues: 'id'});
const transaction: ChangeStreamData[] = [
  ['begin', messages.begin(), {commitWatermark: '03'}],
  ...Array.from(
    {length: ROWS},
    (_, id) =>
      [
        'data',
        messages.insert('issues', {
          id,
          bool: id % 2 === 0,
          text: `issue ${id}`,
          json: `{"id":${id}}`,
        }),
      ] satisfies ChangeStreamData,
  ),
  ['commit', messages.commit(), {watermark: '03'}],
];

function createDb() {
  const lc = createSilentLogContext();
  const db = new Database(lc, ':memory:');
  initReplicationState(db, ['zero_data'], '02');
  db.exec(`
    CREATE TABLE issues(
      id INTEGER PRIMARY KEY,
      bool BOOL,
      text TEXT,
      json JSON,
      _0_version TEXT NOT NULL
    );
    INSERT INTO "_zero.column_metadata"
      (table_name, column_name, upstream_type, is_not_null, is_enum, is_array, character_max_length, backfill)
      VALUES
        ('issues', 'id', 'int4', 1, 0, 0, NULL, NULL),
        ('issues', 'bool', 'bool', 0, 0, 0, NULL, NULL),
        ('issues', 'text', 'text', 0, 0, 0, NULL, NULL),
        ('issues', 'json', 'json', 0, 0, 0, NULL, NULL),
        ('issues', '_0_version', 'text', 1, 0, 0, NULL, NULL);
  `);
  return {lc, db};
}

function processTransaction(mode: 'serving' | 'backup') {
  const {lc, db} = createDb();
  try {
    const processor = new ChangeProcessor(
      new StatementRunner(db),
      mode,
      (_, err) => {
        throw err;
      },
    );
    for (const message of transaction) {
      processor.processMessage(lc, message);
    }
    return db.prepare('SELECT COUNT(*) AS count FROM issues').get();
  } finally {
    db.close();
  }
}

describe('change-processor benchmark', () => {
  let warmup: unknown;

  beforeEach(() => {
    warmup = undefined;
  });

  afterAll(() => {
    use(warmup);
  });

  bench(
    'serving 1000 inserts with replica and changeLog writes',
    () => {
      warmup = processTransaction('serving');
      return use(warmup);
    },
    {min_cpu_time: 500_000_000, min_samples: 20},
  );

  bench(
    'backup 1000 inserts with replica-only writes',
    () => {
      warmup = processTransaction('backup');
      return use(warmup);
    },
    {min_cpu_time: 500_000_000, min_samples: 20},
  );
});
