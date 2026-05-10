import type {LogContext} from '@rocicorp/logger';
import {
  bench,
  describe,
  use,
  type MeasureOptions,
} from '../../../../shared/src/bench.ts';
import {createSilentLogContext} from '../../../../shared/src/logging-test-utils.ts';
import {Database} from '../../../../zqlite/src/db.ts';
import {StatementRunner} from '../../db/statements.ts';
import type {DataOrSchemaChange} from '../change-source/protocol/current/data.ts';
import type {MessageBackfill} from '../change-source/protocol/current/data.ts';
import {ChangeProcessor} from './change-processor.ts';
import {initReplicationState} from './schema/replication-state.ts';
import {ReplicationMessages} from './test-utils.ts';

const ROWS = 1_000;
const BENCH_OPTS: MeasureOptions = {min_cpu_time: 500_000_000, min_samples: 20};

type Fixture = {
  lc: LogContext;
  db: Database;
  processor: ChangeProcessor;
  messages: ReplicationMessages<{issues: 'id'}>;
  version: number;
};

function setupFixture(seedRows: boolean): Fixture {
  const lc = createSilentLogContext();
  const db = new Database(lc, ':memory:');
  initReplicationState(db, ['zero_data'], 'v000000000');
  db.exec(/*sql*/ `
    CREATE TABLE issues (
      id INTEGER PRIMARY KEY,
      value INTEGER,
      text TEXT,
      _0_version TEXT NOT NULL
    );
  `);

  if (seedRows) {
    const insert = db.prepare(
      `INSERT INTO issues (id, value, text, _0_version) VALUES (?, ?, ?, ?)`,
    );
    db.transaction(() => {
      for (let i = 0; i < ROWS; i++) {
        insert.run(i, i, `seed-${i}`, 'v000000000');
      }
    });
  }

  return {
    lc,
    db,
    processor: new ChangeProcessor(
      new StatementRunner(db),
      'serving',
      (_, err) => {
        throw err;
      },
    ),
    messages: new ReplicationMessages({issues: 'id'}),
    version: 0,
  };
}

function nextWatermark(fixture: Fixture) {
  fixture.version++;
  return `v${fixture.version.toString(36).padStart(9, '0')}`;
}

function applyTransaction(
  fixture: Fixture,
  changes: readonly DataOrSchemaChange[],
) {
  const {lc, processor, messages} = fixture;
  const watermark = nextWatermark(fixture);
  processor.processMessage(lc, [
    'begin',
    messages.begin(),
    {commitWatermark: watermark},
  ]);
  for (const change of changes) {
    processor.processMessage(lc, ['data', change]);
  }
  const result = processor.processMessage(lc, [
    'commit',
    messages.commit(),
    {watermark},
  ]);
  use(result?.watermark);
}

function applyBackfill(fixture: Fixture, backfill: MessageBackfill) {
  const {lc, processor, messages} = fixture;
  const watermark = nextWatermark(fixture);
  processor.processMessage(lc, [
    'begin',
    messages.begin(),
    {commitWatermark: watermark},
  ]);
  processor.processMessage(lc, ['data', backfill]);
  const result = processor.processMessage(lc, [
    'commit',
    messages.commit(),
    {watermark},
  ]);
  use(result?.watermark);
}

describe('ChangeProcessor replication apply throughput', () => {
  const insertFixture = setupFixture(false);
  const updateFixture = setupFixture(true);
  const backfillFixture = setupFixture(false);

  const insertMessages = Array.from({length: ROWS}, (_, id) =>
    insertFixture.messages.insert('issues', {
      id,
      value: id,
      text: `insert-${id}`,
    }),
  );
  const updateMessages = Array.from({length: ROWS}, (_, id) =>
    updateFixture.messages.update('issues', {
      id,
      value: id + 1,
      text: `update-${id}`,
    }),
  );
  const backfillMessage: MessageBackfill = {
    tag: 'backfill',
    relation: {
      schema: 'public',
      name: 'issues',
      rowKey: {type: 'default', columns: ['id']},
    },
    columns: ['value', 'text'],
    watermark: 'v000000000',
    rowValues: Array.from({length: ROWS}, (_, id) => [
      id,
      id,
      `backfill-${id}`,
    ]),
  };

  bench(
    `apply ${ROWS} insert messages in one transaction`,
    () => applyTransaction(insertFixture, insertMessages),
    BENCH_OPTS,
  );

  bench(
    `apply ${ROWS} update messages in one transaction`,
    () => applyTransaction(updateFixture, updateMessages),
    BENCH_OPTS,
  );

  bench(
    `apply ${ROWS} backfill rows in one message`,
    () => applyBackfill(backfillFixture, backfillMessage),
    BENCH_OPTS,
  );
});
