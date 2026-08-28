# capy/syncer-observability

Production can currently see that a query wave was slow. It cannot see whether
the wave was slow because the query was expensive or because the sync worker
serving it was already busy with other client groups. This branch closes that
gap, and fixes one metric label that has been recording `undefined` since a
refactor.

Three commits, in order:

1. `fix(zero-cache): restore change-type attribution on ivm.advance-time`
2. `feat(zero-cache): export wave wall time, lock hold, and slice-queue pressure`
3. `feat(zero-cache): monitor event-loop delay and utilization per sync worker`

No behavior changes. Nothing schedules differently, no worker counts move, no
query path is altered. Every change either records a value that was already
computed or samples a Node API.

## Per-worker attribution is already a resource attribute

The task asked for a worker-index label on the sync-path metrics. That label
would be redundant, because `server/otel-start.ts:50-61` already stamps every
metric, trace, and log emitted from a sync worker process with the OTel
**resource** attributes `process.worker` and `process.worker_index`, derived
from the ordinal that `server/main.ts:154-174` passes to each forked syncer and
`server/syncer.ts:74-89` parses. Adding the same dimension as a metric label
would duplicate a resource dimension, inflate every series, and diverge from
the convention the repository already follows: `pipelines_total` and friends
document themselves as "on this worker" and carry no worker label for exactly
this reason.

The live capture confirms it end to end: every data point in
`capture/metrics-n8.txt` arrives under `process.worker=syncer,
process.worker_index=0`, and the dispatcher, change-streamer, and replicator
each export under their own resource.

**Limitation, pre-existing.** In `SINGLE_PROCESS` mode the workers run inside
one process (`types/processes.ts:196-212`) and the dispatcher wins the
`OtelManager` singleton, so that process reports `dispatcher/0` for everything.
Per-worker attribution is meaningful in normal multiprocess mode only, which is
how the hosted provider runs. This branch does not change that.

## Metric inventory

New in this branch:

| Metric | Type | Labels | Cardinality bound | Question it answers |
|---|---|---|---|---|
| `zero.sync.wave.wall-time` | histogram, s | `type` = `query-sync` \| `advance` | 2 | How long did a wave actually take, wall clock, through `pokeEnd`? Compared against `hydration-time` / `advance-time` it separates cost from queueing. |
| `zero.sync.wave.rows` | counter, `{row}` | `type` = `query-sync` \| `advance` | 2 | How much work was in the wave, after batched de-duplication? Distinguishes an expensive wave from a slow one. |
| `zero.sync.lock-hold-time` | histogram, s | none | 1 | How long did the client-group lock stay held? Paired with the existing `lock-wait-time` it shows the lock is held while descheduled rather than contended. |
| `zero.sync.ivm.slice-wait-time` | histogram, s | none | 1 | How long did a ViewSyncer wait for its turn on the worker-wide time-slice queue? This is pure scheduler delay. |
| `zero.sync.ivm.slice-queue-depth` | histogram, `{slice}` | none | 1 | How many peers was it queued behind? Its `count` is also the worker's slice throughput. |
| `zero.server.event_loop_delay` | gauge, ms | `stat` = `mean` \| `p50` \| `p99` \| `max` | 4 | Is this worker's loop saturated, independent of any query? |
| `zero.server.event_loop_utilization` | gauge, ratio | none | 1 | What fraction of the interval was the loop active rather than idle? |

Fixed in this branch:

| Metric | Type | Labels | Cardinality bound | What changed |
|---|---|---|---|---|
| `zero.sync.ivm.advance-time` | histogram, s | `table`, `type` = `add` \| `remove` \| `edit` | tables x 3 | `type` was declared and never assigned, so every observation recorded `undefined`. |

Already existed, and already per-worker through the resource, so this branch
deliberately adds nothing for them:

| Requested signal | Existing metric |
|---|---|
| CPU-ish query processing time (`TimeSliceTimer` total) | `zero.sync.hydration-time`, `zero.sync.advance-time` |
| Whole-wave latency including transform and `pokeEnd` | `zero.sync.view_syncer_hydration` |
| CVR flush timing | `zero.sync.cvr.flush-time{flush.type}` |
| Poke timing and poked rows | `zero.sync.poke.time`, `zero.sync.poke.rows` |
| Live client groups per worker | `zero.sync.active-client-groups` |
| Lock acquisition wait | `zero.sync.lock-wait-time` |

## Cardinality discipline

No client-group ID and no query name or hash appears as a label on any metric,
new or existing. Custom query names are derived from registry object paths and
typed as a plain `v.string()` in `zero-protocol/src/custom-queries.ts` with no
length or charset bound, so they are client-supplied and unbounded by
construction; they stay in logs, spans, and lifecycle state where they already
live. Every label this branch adds is a closed enum of at most four values,
except `ivm.advance-time`'s pre-existing `table`, which is bounded by the
replicated schema.

## Where the instrumentation sits

- **Wave wall and rows.** `#syncQueryPipelineSet` and `#advancePipelines` both
  already computed `wallTime` and logged it; `#processChanges` already computed
  the de-duplicated row total for a span attribute. The change returns that
  total and records both values after `pokeEnd`.
- **Lock hold.** `#runInLockWithCVR` records from lock acquisition to release in
  a `finally`, so early returns and thrown protocol errors are included.
- **Slice queue.** Instrumented inside the module-level `yieldProcess`, the one
  choke point every yield goes through, so hydration, advancement, and change
  processing are all covered by one measurement. Depth is sampled before the
  waiter increments, so an uncontended slice reports 0. The wait is measured
  outside the `TimeSliceTimer` lap, which is why it does not perturb
  `hydration-time`.
- **Event loop.** `observability/event-loop.ts`, started and stopped with the
  `Syncer`. The delay histogram is reset after each observation and utilization
  is differenced against the previous one, so both describe the last collection
  interval instead of the process lifetime. Values have a 10 ms floor: the
  monitor measures the interval between its own timer fires, so an idle loop
  reads as one sampling resolution rather than zero.

## Live capture

Rig: `zcbaseline` Postgres created from the goblins template and seeded with the
wave-replay fixture (973 problem trackers, 973 conversations, 957 mastery
assessments, 136 students, 5 classes), the goblins transform server on 49800,
and zero-cache from this branch on 49700 with `ZERO_NUM_SYNC_WORKERS=1`,
exporting OTLP/JSON every 5 s. N fresh client groups each register the six
assignment-page roots in one same-tick batch. Full output in `capture/`.

Three runs at each concurrency, so 3, 12, and 24 waves respectively:

| N | `wave.wall-time` avg | `hydration-time` avg | wall / CPU | `slice-queue-depth` avg / max | `slice-wait-time` avg | `lock-hold-time` avg | `lock-wait-time` avg | utilization peak |
|---|---|---|---|---|---|---|---|---|
| 1 | 541 ms | 437 ms | 1.24x | 0.00 / 0 | 0.9 ms | 155 ms | 0.1 ms | 0.15 |
| 4 | 1883 ms | 415 ms | 4.5x | 2.74 / 3 | 43.7 ms | 527 ms | 0.1 ms | 0.50 |
| 8 | 3635 ms | 397 ms | 9.2x | 6.24 / 7 | 97.6 ms | 1174 ms | 0.1 ms | 0.74 |

CPU per wave is flat while wall time grows 6.7x, and queue depth tracks N-1
exactly. That is the mechanism the diagnosis inferred, now visible directly.
The lock columns settle the question the diagnosis flagged: hold time grows
with N while wait time stays at a tenth of a millisecond, so the client-group
lock is held through descheduling and is never contended.

`zero.sync.active-client-groups` peaks at 1, 4, and 8 respectively, which is the
per-worker load shape the operational conversation needs.

The advance path was exercised separately by holding one client group open and
mutating its rows upstream (`capture/metrics-advance.txt`):

```
zero.sync.ivm.advance-time{table=problem_tracker,type=edit}      count=2
zero.sync.ivm.advance-time{table=problem_tracker,type=remove}    count=1
zero.sync.ivm.advance-time{table=problem_tracker,type=add}       count=1
zero.sync.ivm.advance-time{table=conversation,type=edit}         count=1
zero.sync.ivm.advance-time{table=mastery_assessment,type=remove} count=1
zero.sync.wave.wall-time{type=advance}                           count=4
zero.sync.wave.rows{type=advance}                                14
```

Before the fix all six of those series were one series labelled
`type=undefined`.

## Overhead

Measured against `origin/main` in a second worktree, alternating arms and
alternating which arm went first, four pairs of 24 client samples each at N=8
(`capture/ab-overhead.txt`):

| pair | order | main median | branch median | delta |
|---|---|---|---|---|
| 7 | branch first | 4.821 s | 4.964 s | +3.0% |
| 8 | branch first | 4.847 s | 4.872 s | +0.5% |
| 9 | main first | 4.943 s | 4.781 s | -3.3% |
| 10 | main first | 4.790 s | 4.747 s | -0.9% |

Pooled, main 4.875 s against branch 4.813 s over 96 samples per arm, a delta of
-1.3%. The sign flips between pairs, so the effect is inside the cell-to-cell
noise of the harness. Server-side over the same 96 waves per arm,
`zero.sync.hydration-time` averages 385.6 ms on main and 383.2 ms on the branch,
and `zero.sync.view_syncer_hydration` 3606.7 ms against 3593.5 ms.

This is what the placement predicts. The added work is two `performance.now()`
calls and two histogram records per time slice, the capture shows about 27
slices per wave, and all of it runs while the `TimeSliceTimer` lap is stopped,
so it is outside the interval `hydration-time` measures.

## Validation

```bash
pnpm --filter zero-cache check-types
pnpm --filter zero-cache exec vitest --project='*no-pg*' run \
  src/services/view-syncer/ src/workers/ src/observability/
pnpm --filter zero-cache exec vitest --project='*pg-16*' run src/services/view-syncer/
pnpm exec oxlint --quiet --config oxlint.config.ts packages/zero-cache/src
pnpm exec oxfmt --check packages/zero-cache/src
git diff --check
```

New tests:

- `services/view-syncer/pipeline-driver.metrics.test.ts` drives real
  transactions through an in-memory OTel exporter and asserts the exported
  `{table, type}` label sets, including that a primary-key change records one
  remove and one add. Both cases fail on the pre-fix code with
  `comments/undefined`.
- `services/view-syncer/view-syncer.metrics.test.ts` asserts an uncontended
  slice reports depth 0 and that two `TimeSliceTimer`s started in the same tick
  produce exactly one sample of depth 1.
- `observability/event-loop.test.ts` saturates the loop and asserts the delay
  reported is the loop's, not the monitor's own sampling resolution, and that
  stopping the monitor removes both callbacks.

## Rerunning the capture

```bash
docker exec goblins-postgres psql -U postgres \
  -c 'CREATE DATABASE zcbaseline TEMPLATE goblins;'
# harness from the fork's capy/zc-baseline-harness branch
git archive origin/capy/zc-baseline-harness packages/zero-cache/bench/wave-replay | tar -x -C /tmp/
bash /tmp/packages/zero-cache/bench/wave-replay/seed/apply-seed.sh \
  'postgresql://postgres:postgres@localhost:5432/zcbaseline?sslmode=disable' 16

# scripts used for this capture, on the run machine
~/work/zcbench/run-transform-server.sh   # goblins server on 49800, dev secrets
~/work/zcbench/otlp-sink.mjs             # OTLP/JSON sink -> jsonl
~/work/zcbench/run-matrix.sh <label> <checkout> <clients> <runs>
~/work/zcbench/run-advance-demo.sh       # holds a group open and mutates upstream
node ~/work/zcbench/summarize-metrics.mjs metrics-<label>.jsonl 'zero\.'
```

zero-cache needs `OTEL_METRICS_EXPORTER=otlp`,
`OTEL_EXPORTER_OTLP_PROTOCOL=http/json`,
`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://localhost:4318/v1/metrics` and
`OTEL_METRIC_EXPORT_INTERVAL=5000`; `OTEL_METRICS_EXPORTER=console` also works
for a quick look but ignores the interval and does not show resource
attributes.
