import {afterAll, beforeAll} from 'vitest';
import {bench, describe, use} from '../../../../../shared/src/bench.ts';
import {createSilentLogContext} from '../../../../../shared/src/logging-test-utils.ts';
import {Database} from '../../../../../zqlite/src/db.ts';
import {CREATE_CHANGELOG_SCHEMA} from './change-log.ts';

const ROWS = 100_000;
const VERSION_MOD = 10_000;
const PREV_VERSION = '005000';

function createDb() {
  const db = new Database(createSilentLogContext(), ':memory:');
  db.exec(CREATE_CHANGELOG_SCHEMA);
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

function countChanges(db: Database) {
  return db
    .prepare(
      `SELECT COUNT(*) AS count FROM "_zero.changeLog2" WHERE stateVersion > ?`,
    )
    .get(PREV_VERSION);
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

describe('change-log snapshot query benchmark', () => {
  let db: Database;

  beforeAll(() => {
    db = createDb();
  });

  afterAll(() => {
    db.close();
  });

  bench('count changes since middle watermark', () => use(countChanges(db)), {
    min_cpu_time: 500_000_000,
    min_samples: 20,
  });

  bench(
    'scan ordered changes since middle watermark',
    () => use(scanChanges(db)),
    {min_cpu_time: 500_000_000, min_samples: 20},
  );
});
