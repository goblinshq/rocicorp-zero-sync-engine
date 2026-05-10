import type {LogContext} from '@rocicorp/logger';
import {testLogConfig} from '../../../../otel/src/test-log-config.ts';
import {
  bench,
  describe,
  use,
  type MeasureOptions,
} from '../../../../shared/src/bench.ts';
import {createSilentLogContext} from '../../../../shared/src/logging-test-utils.ts';
import type {AST} from '../../../../zero-protocol/src/ast.ts';
import {createSchema} from '../../../../zero-schema/src/builder/schema-builder.ts';
import {
  string,
  table,
} from '../../../../zero-schema/src/builder/table-builder.ts';
import {
  CREATE_STORAGE_TABLE,
  DatabaseStorage,
} from '../../../../zqlite/src/database-storage.ts';
import {Database} from '../../../../zqlite/src/db.ts';
import {InspectorDelegate} from '../../server/inspector-delegate.ts';
import {DbFile} from '../../test/lite.ts';
import {initReplicationState} from '../replicator/schema/replication-state.ts';
import {fakeReplicator, ReplicationMessages} from '../replicator/test-utils.ts';
import {PipelineDriver, type Timer} from './pipeline-driver.ts';
import {Snapshotter} from './snapshotter.ts';

const ISSUES = 1_000;
const BENCH_OPTS: MeasureOptions = {min_cpu_time: 500_000_000, min_samples: 20};
const NO_TIME_ADVANCEMENT_TIMER: Timer = {
  elapsedLap: () => 0,
  totalElapsed: () => 0,
};

const issue = table('issue')
  .columns({
    id: string(),
    creatorID: string(),
  })
  .primaryKey('id');
const user = table('user')
  .columns({
    id: string(),
    name: string(),
  })
  .primaryKey('id');
const comment = table('comment')
  .columns({
    id: string(),
    issueID: string(),
  })
  .primaryKey('id');

const clientSchema = createSchema({tables: [issue, user, comment]});

const issuesWithCreator: AST = {
  table: 'issue',
  orderBy: [['id', 'desc']],
  related: [
    {
      system: 'client',
      correlation: {
        parentField: ['creatorID'],
        childField: ['id'],
      },
      subquery: {
        table: 'user',
        alias: 'creator',
        orderBy: [['id', 'desc']],
      },
    },
  ],
};

const issuesWithCreatorExistsComment: AST = {
  table: 'issue',
  orderBy: [['id', 'asc']],
  related: issuesWithCreator.related,
  where: {
    type: 'correlatedSubquery',
    op: 'EXISTS',
    related: {
      system: 'client',
      correlation: {
        parentField: ['id'],
        childField: ['issueID'],
      },
      subquery: {
        table: 'comment',
        alias: 'comments',
        orderBy: [['id', 'asc']],
      },
    },
  },
};

type Fixture = {
  lc: LogContext;
  dbFile: DbFile;
  db: Database;
  pipelines: PipelineDriver;
  version: number;
};

function createPipelineFixture(query: AST): Fixture {
  const lc = createSilentLogContext();
  const dbFile = new DbFile('pipeline-driver-bench');
  dbFile.connect(lc).pragma('journal_mode = wal2');

  const storage = new Database(lc, ':memory:');
  storage.prepare(CREATE_STORAGE_TABLE).run();

  const pipelines = new PipelineDriver(
    lc,
    testLogConfig,
    new Snapshotter(lc, dbFile.path, {appID: 'zeroz'}),
    {appID: 'zeroz', shardNum: 1},
    new DatabaseStorage(storage).createClientGroupStorage('bench-client-group'),
    'pipeline-driver.bench.ts',
    new InspectorDelegate(undefined),
    () => Number.MAX_SAFE_INTEGER,
  );

  const db = dbFile.connect(lc);
  initReplicationState(db, ['zero_data'], 'v000000000');
  db.exec(/*sql*/ `
    CREATE TABLE issue (
      id TEXT PRIMARY KEY,
      creatorID TEXT,
      _0_version TEXT NOT NULL
    );
    CREATE TABLE user (
      id TEXT PRIMARY KEY,
      name TEXT,
      _0_version TEXT NOT NULL
    );
    CREATE TABLE comment (
      id TEXT PRIMARY KEY,
      issueID TEXT,
      _0_version TEXT NOT NULL
    );
    INSERT INTO user (id, name, _0_version) VALUES ('u1', 'seed', 'v000000000');
    INSERT INTO issue (id, creatorID, _0_version)
      WITH RECURSIVE cnt(n) AS (
        SELECT 1
        UNION ALL
        SELECT n + 1 FROM cnt WHERE n < ${ISSUES}
      )
      SELECT 'i' || n, 'u1', 'v000000000' FROM cnt;
  `);

  pipelines.init(clientSchema);
  use(
    [
      ...pipelines.addQuery(
        'hash1',
        'queryID1',
        query,
        NO_TIME_ADVANCEMENT_TIMER,
      ),
    ].length,
  );

  return {lc, dbFile, db, pipelines, version: 0};
}

function nextWatermark(fixture: Fixture) {
  fixture.version++;
  return `v${fixture.version.toString(36).padStart(9, '0')}`;
}

function advanceAfterUserUpdate(fixture: Fixture) {
  const replicator = fakeReplicator(fixture.lc, fixture.db);
  const messages = new ReplicationMessages({user: 'id'});
  replicator.processTransaction(
    nextWatermark(fixture),
    messages.update('user', {id: 'u1', name: `name-${fixture.version}`}),
  );
  const result = [
    ...fixture.pipelines.advance(NO_TIME_ADVANCEMENT_TIMER).changes,
  ];
  use(result.length);
}

describe('PipelineDriver IVM advancement throughput', () => {
  const relatedFanout = createPipelineFixture(issuesWithCreator);
  const filteredFanout = createPipelineFixture(issuesWithCreatorExistsComment);

  bench(
    `advance one child update fanout to ${ISSUES} related rows`,
    () => advanceAfterUserUpdate(relatedFanout),
    BENCH_OPTS,
  );

  bench(
    `advance one child update through EXISTS filter over ${ISSUES} rows`,
    () => advanceAfterUserUpdate(filteredFanout),
    BENCH_OPTS,
  );
});
