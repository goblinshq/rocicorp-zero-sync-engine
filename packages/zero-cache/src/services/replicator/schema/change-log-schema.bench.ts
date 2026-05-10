import {afterAll, beforeAll} from 'vitest';
import {bench, describe, use} from '../../../../../shared/src/bench.ts';
import {createSilentLogContext} from '../../../../../shared/src/logging-test-utils.ts';
import {Database} from '../../../../../zqlite/src/db.ts';
import {CREATE_CHANGELOG_SCHEMA} from './change-log.ts';

const ROWS = 50_000;
const VERSION_MOD = 10_000;
const PREV_VERSION = '005000';

type Mode = 'rowid' | 'without-rowid';

function createDb(mode: Mode) {
  const db = new Database(createSilentLogContext(), ':memory:');
  db.exec(
    mode === 'rowid'
      ? CREATE_CHANGELOG_SCHEMA
      : CREATE_CHANGELOG_SCHEMA.replace(
          'UNIQUE("table", "rowKey")\n  );',
          'UNIQUE("table", "rowKey")\n  ) WITHOUT ROWID;',
        ),
  );
  const insert = db.prepare(`
    INSERT INTO "_zero.changeLog2" (stateVersion, pos, "table", rowKey, op)
    VALUES (?, ?, 'issues', ?, 's')
  `);
  db.transaction(() => {
    for (let i = 0; i < ROWS; i++) {
      const version = String(i % VERSION_MOD).padStart(6, '0');
      insert.run(version, i, `{"id":${i}}`);
    }
  });
  return db;
}

function insertRows(mode: Mode) {
  const db = createDb(mode);
  try {
    return db.prepare('SELECT COUNT(*) AS count FROM "_zero.changeLog2"').get();
  } finally {
    db.close();
  }
}

function scanChanges(db: Database) {
  let rows = 0;
  for (const _ of db
    .prepare(
      `SELECT "stateVersion", "table", "rowKey", "op" FROM "_zero.changeLog2"
         WHERE "stateVersion" > ? ORDER BY "stateVersion" ASC, "pos" ASC`,
    )
    .iterate(PREV_VERSION)) {
    rows++;
  }
  return rows;
}

describe('change-log schema benchmark', () => {
  let rowidDb: Database;
  let withoutRowidDb: Database;

  beforeAll(() => {
    rowidDb = createDb('rowid');
    withoutRowidDb = createDb('without-rowid');
  });

  afterAll(() => {
    rowidDb.close();
    withoutRowidDb.close();
  });

  bench(
    'rowid schema insert 50k change-log rows',
    () => use(insertRows('rowid')),
    {min_cpu_time: 500_000_000, min_samples: 20},
  );

  bench(
    'WITHOUT ROWID schema insert 50k change-log rows',
    () => use(insertRows('without-rowid')),
    {min_cpu_time: 500_000_000, min_samples: 20},
  );

  bench('rowid schema scan ordered changes', () => use(scanChanges(rowidDb)), {
    min_cpu_time: 500_000_000,
    min_samples: 20,
  });

  bench(
    'WITHOUT ROWID schema scan ordered changes',
    () => use(scanChanges(withoutRowidDb)),
    {min_cpu_time: 500_000_000, min_samples: 20},
  );
});
