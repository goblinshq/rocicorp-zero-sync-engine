# Current-main Zero assignment-wave latency diagnosis

Date: 2026-08-27  
Zero source: [`rocicorp/mono@ac5eb2311268f1f2a8b68f2411874348b602967d`](https://github.com/rocicorp/mono/tree/ac5eb2311268f1f2a8b68f2411874348b602967d)  
Goblins source: `goblinshq/goblins@ef4d043faec1d2e7db0e0aa75d5af733726d05d1`

## Verdict

The assignment page's six desired roots become one client message and one server query wave. Current main then transforms the set, hydrates eight pipelines serially under one client-group lock (six requested queries plus two internal queries), starts one poke before hydration, may stream poke parts while the wave is processed, and sends `pokeEnd` only after every pipeline, the CVR flush, and catch-up finish. One expensive tracker graph therefore withholds the committed result of every cheap root in that wave.

The first capacity limit under concurrent client groups is the single sync-worker event loop's query hydration and planning path, not custom-query HTTP, CVR PostgreSQL, WebSocket `pokeEnd`, or contention on one shared client-group mutex. Each client group owns a different mutex, but all ViewSyncers on a worker share one cooperative `timeSliceQueue`. Across the per-N medians, CPU-ish query time stays about 0.63--0.73 seconds while query-wave wall time rises from 0.82 seconds at one group to 12.08 seconds at 16 groups. The matching eight-group CPU profile attributes 60% of all samples inclusively to `generateRowChanges`, 55% to `PipelineDriver.#addQueryImpl`, 39% to hydration/streaming, and 14% to planning. Those inclusive paths overlap and must not be added.

The local absolute times are not production estimates. The fixture and query shapes are production-shaped, but the experiment uses local hardware, a warm local transform server, and one sync worker. The scaling law and serialization mechanism are the useful results.

## What was reproduced

The local fixture contains:

- 136 students in five classes
- 24 problems
- 973 problem trackers
- 973 latest-conversation rows
- 957 mastery-assessment rows

The idempotent seeder generated and applied 3,365 SQL statements. The replay registered these six assignment-page desired roots:

1. `assignment.basic`
2. `assignment.summary`
3. `assignment.roster`
4. `assignment.with_problems`
5. `problem_trackers.for_assignment`
6. `misconduct.for_assignment_count`

A fresh client group also hydrates Zero's `lmids` and `mutationResults` internal queries, so server stage logs correctly report eight additions for the six-root client wave.

The replay was run in four registration modes, three times each:

| Mode | Registration | First-content median | Total-settle median | What it isolates |
|---|---|---:|---:|---|
| wave | all six in one same-tick batch | 1.424 s | 1.425 s | Current page-shaped behavior |
| wave control | all except the tracker query | 0.659 s | 0.660 s | Cost of the tracker graph |
| two tier | five-root control first, tracker after it settles | 0.571 s | 1.331 s | Whether one heavy root gates useful content |
| staggered | register roots one at a time | 0.182 s | 1.520 s | Earliest possible content with extra round trips |

Ranges were: wave settle 1.327--1.468 seconds, control 0.568--0.660 seconds, two-tier 1.318--1.397 seconds, and staggered 1.439--1.625 seconds. Splitting only the tracker root improved first content by 0.853 seconds, or 60%, and did not increase median total settle in this fixture. Fully staggering all roots improved first content further but made total settle 7% slower than the wave. This supports two cost tiers, not a one-query-per-round-trip waterfall.

All six roots in wave runs 1 and 2 share a completion millisecond. Wave 3 spans 1 ms, so all six completed within a 1-ms span. This is expected from one group poke: no root becomes committed to the client until the serial hydration loop and `pokers.end(finalVersion)` finish.

## One-group stage attribution

The stage table below uses the later concurrency series' one-group median over three client groups. Rows overlap where noted; they are not additive.

| Interval | Median | Relationship |
|---|---:|---|
| Client total settle | 1,263.0 ms | End-to-end replay |
| Config-update body | 6.2 ms | Separate first lock task; bookkeeping, config CVR flush, config poke, and query-sync branch |
| Custom transform | 16.6 ms | Inside query sync and query lock |
| Query wave wall | 818.2 ms | Inside query sync and query lock |
| Query processing | 730.6 ms | Inside query wave; `TimeSliceTimer` excludes cooperative-yield waits |
| Tracker hydration | 537.7 ms | One query inside query processing; 74% of timed processing |
| CVR flush | 11.2 ms | Inside query wave |
| `pokeEnd` | 0.19 ms | Inside query wave; local downstream only |
| Query-lock work through release probe | 841.6 ms | Contains transform, query wave, and reconciliation overhead; probe fires before auth-maintenance scheduling and actual unlock |

A representative warm wave recorded these per-pipeline CPU-ish hydration times:

| Pipeline | Hydration time | Pipeline row events |
|---|---:|---:|
| `lmids` | 0.8 ms | 0 |
| `mutationResults` | 0.4 ms | 0 |
| `assignment.basic` | 31.5 ms | 5 |
| `assignment.summary` | 45.6 ms | 0 |
| `assignment.roster` | 59.1 ms | 1,118 |
| `assignment.with_problems` | 22.9 ms | 53 |
| `problem_trackers.for_assignment` | 562.0 ms | 7,768 |
| `misconduct.for_assignment_count` | 98.5 ms | 0 |

"Pipeline row events" is the lifecycle counter before downstream batch deduplication. It is not a count of unique socket rows. The tracker graph itself contains real tracker, latest-conversation, and assessment data; a prior wire check found no duplicate tracker payload to delete.

Custom transform, CVR flush, and `pokeEnd` together are tens of milliseconds, not the missing second. The dominant root is the tracker graph. More important for load, current main repeats the whole materialization independently for every eligible client group.

## Concurrent-group scaling

The same six-root wave was started concurrently in distinct fresh client groups against one current-main sync worker. N=1, 2, 4, and 8 have three runs each. N=16 has two runs. The table reports medians over all client samples for each N.

| Concurrent groups | Client samples | Settle median | Settle / N=1 | Query-wave wall | Wave / N=1 | Query-lock work to probe | Work / N=1 | Timed query processing | Tracker hydration |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 3 | 1,263.0 ms | 1.00x | 818.2 ms | 1.00x | 841.6 ms | 1.00x | 730.6 ms | 537.7 ms |
| 2 | 6 | 2,035.5 ms | 1.61x | 1,430.8 ms | 1.75x | 1,488.3 ms | 1.77x | 642.1 ms | 464.8 ms |
| 4 | 12 | 3,679.0 ms | 2.91x | 2,784.9 ms | 3.40x | 2,840.6 ms | 3.38x | 632.8 ms | 450.3 ms |
| 8 | 24 | 7,181.0 ms | 5.69x | 5,616.2 ms | 6.86x | 5,674.7 ms | 6.74x | 646.0 ms | 448.2 ms |
| 16 | 32 | 14,746.0 ms | 11.68x | 12,080.2 ms | 14.76x | 12,178.3 ms | 14.47x | 685.0 ms | 484.8 ms |

This is queueing around a stable unit of CPU work:

- Across the per-N medians, timed query processing stays within 0.63--0.73 seconds because `TimeSliceTimer` stops while a ViewSyncer yields.
- Across the per-N medians, tracker hydration stays within 0.45--0.54 seconds for the same reason.
- Query-wave wall time and query-lock work through the release probe grow nearly in proportion to concurrent groups because each group waits for turns on the sync worker's event loop and global time-slice queue.
- CVR flush rises from 11 to 83 ms by N=16, but it remains small relative to the 12.08-second query wave.
- The per-group ViewSyncer lock is not shared across these groups. Calling the result "lock contention" without that qualifier would be wrong. The measured lock-work interval expands because the lock remains held while its work is descheduled.

The first clear saturation is present by N=2 in query-wave wall time: it grows 1.75x while the per-N median of the CPU-ish timer falls slightly. Config-update wall time also rises later, but these probes do not isolate scheduler delay from CVR or downstream delay; it is not the first or dominant interval.

## CPU profiles

Profiles were captured from the matching syncer process around one group and eight concurrent groups.

| Inclusive stack | One group | Eight groups | Eight-group share of all samples |
|---|---:|---:|---:|
| `generateRowChanges` | 0.700 s | 5.039 s | 59.9% |
| `PipelineDriver.#addQueryImpl` | 0.633 s | 4.635 s | 55.1% |
| `hydrateInternal` | 0.446 s | 3.275 s | 38.9% |
| `Streamer.stream` | 0.444 s | 3.264 s | 38.8% |
| `Streamer.#streamNodes` | 0.413 s | 3.050 s | 36.2% |
| `TableSource.#fetch` | 0.330 s | 2.400 s | 28.5% |
| `FlippedJoin.fetch` | 0.229 s | 1.683 s | 20.0% |
| planner `plan` | 0.155 s | 1.187 s | 14.1% |

The one-group profile sampled 1.974 seconds, including 0.946 seconds idle. The eight-group profile sampled 8.418 seconds, including 1.370 seconds idle. Top eight-group self-time frames include native iterator `next` (10.6%), SQLite `Statement` (7.9%), garbage collection (7.6%), SQL formatting (3.0%), and `zqlite` iterator `next` (2.2%). Transform HTTP and CVR code do not appear as dominant paths.

Inclusive rows overlap. For example, `generateRowChanges` contains `#addQueryImpl`, which contains hydration and streaming. The safe conclusion is that serial query construction/materialization dominates, with meaningful sub-cost in SQLite traversal, flipped joins, streaming, planning, and allocation. It is not valid to add their percentages.

## Why current main behaves this way

The serialization chain is explicit in current code:

1. **Same-tick client registrations become one message.** [`QueryManager.#queueQueryChange` and `flushBatch`](https://github.com/rocicorp/mono/blob/ac5eb2311268f1f2a8b68f2411874348b602967d/packages/zero-client/src/client/query-manager.ts#L445-L473) collect pending operations and send one `changeDesiredQueries` patch.
2. **One WebSocket processes messages serially.** [`Connection.#proxyInbound`](https://github.com/rocicorp/mono/blob/ac5eb2311268f1f2a8b68f2411874348b602967d/packages/zero-cache/src/workers/connection.ts#L362-L375) invokes the stream callback only after `#handleMessage` resolves, and [`changeDesiredQueries`](https://github.com/rocicorp/mono/blob/ac5eb2311268f1f2a8b68f2411874348b602967d/packages/zero-cache/src/workers/syncer-ws-message-handler.ts#L188-L194) awaits the ViewSyncer.
3. **One client group has one decisive mutex.** [`#runInLockWithCVR`](https://github.com/rocicorp/mono/blob/ac5eb2311268f1f2a8b68f2411874348b602967d/packages/zero-cache/src/services/view-syncer/view-syncer.ts#L483-L547) holds the group lock across CVR access and the whole callback.
4. **The server reconciles the whole desired set.** [`#syncQueryPipelineSet`](https://github.com/rocicorp/mono/blob/ac5eb2311268f1f2a8b68f2411874348b602967d/packages/zero-cache/src/services/view-syncer/view-syncer.ts#L1972-L2211) transforms and computes additions, then calls one `#addAndRemoveQueries`.
5. **Additions hydrate one at a time.** [`generateRowChanges`](https://github.com/rocicorp/mono/blob/ac5eb2311268f1f2a8b68f2411874348b602967d/packages/zero-cache/src/services/view-syncer/view-syncer.ts#L2357-L2425) loops through `addQueries` and exhausts `pipelines.addQuery` before starting the next query. [`PipelineDriver.#addQueryImpl`](https://github.com/rocicorp/mono/blob/ac5eb2311268f1f2a8b68f2411874348b602967d/packages/zero-cache/src/services/view-syncer/pipeline-driver.ts#L622-L729) builds the operator pipeline and runs hydration.
6. **One poke commits the group wave.** The same method starts pokers before hydration, flushes the CVR, catches clients up, and only then calls `pokers.end(finalVersion)` at [`view-syncer.ts:2444-2461`](https://github.com/rocicorp/mono/blob/ac5eb2311268f1f2a8b68f2411874348b602967d/packages/zero-cache/src/services/view-syncer/view-syncer.ts#L2444-L2461). [`ClientHandler.end`](https://github.com/rocicorp/mono/blob/ac5eb2311268f1f2a8b68f2411874348b602967d/packages/zero-cache/src/services/view-syncer/client-handler.ts#L328-L354) flushes the final body and sends `pokeEnd`.
7. **Distinct groups are fair-scheduled, not parallel within one worker.** The module-level [`timeSliceQueue`](https://github.com/rocicorp/mono/blob/ac5eb2311268f1f2a8b68f2411874348b602967d/packages/zero-cache/src/services/view-syncer/view-syncer.ts#L2951-L2968) runs one IVM slice per event-loop iteration. [`TimeSliceTimer`](https://github.com/rocicorp/mono/blob/ac5eb2311268f1f2a8b68f2411874348b602967d/packages/zero-cache/src/services/view-syncer/view-syncer.ts#L3048-L3105) excludes the wait between slices from its total.
8. **Parallel capacity comes from sync workers in normal multiprocess mode.** The dispatcher hashes each `taskID/clientGroupID` to one worker at [`worker-dispatcher.ts:66-80`](https://github.com/rocicorp/mono/blob/ac5eb2311268f1f2a8b68f2411874348b602967d/packages/zero-cache/src/server/worker-dispatcher.ts#L66-L80). In normal multiprocess mode, Zero starts `numSyncWorkers` forked sync workers at [`server/main.ts:154-174`](https://github.com/rocicorp/mono/blob/ac5eb2311268f1f2a8b68f2411874348b602967d/packages/zero-cache/src/server/main.ts#L154-L174); when unset, current main defaults to `max(1, availableParallelism() - 1)` at [`config/normalize.ts:169-174`](https://github.com/rocicorp/mono/blob/ac5eb2311268f1f2a8b68f2411874348b602967d/packages/zero-cache/src/config/normalize.ts#L169-L174). Single-process mode runs worker instances in-process and does not add per-core CPU capacity.

Removing the group lock or global yielding is not a supported conclusion. The group lock protects CVR and pipeline invariants. The global queue supplies fairness and bounds I/O delay. The measured issue is more CPU work than one worker can serve concurrently, plus all-or-nothing completion of a multi-query wave.

## Mapping to the established production signatures

The three production signatures below were supplied as established facts. They were not re-measured locally.

| Production signature | Current-main mapping | What it does not prove |
|---|---|---|
| 23.1 seconds / 8 roots | A single desired-query patch can become one serial hydration wave and one final poke. One expensive root or a sync-worker backlog can therefore hold all eight completions together. This matches the local lockstep completion mechanism. | Eight roots do not mean eight equal costs, and this local test does not predict 23.1 seconds. |
| 16.2 seconds / 5 roots | Root count is a poor load proxy. Locally, removing only the tracker root changed a six-root wave from 1.425 seconds to a five-root wave at 0.660 seconds. A five-root production wave can still be very expensive if one graph has many rows or costly relations. | The signature alone cannot distinguish expensive materialization from worker queueing. It needs per-query CPU/rows plus wave wall time. |
| 6.2 seconds / 47 roots | Forty-seven cheap, cached, unchanged, or narrow roots can finish faster than five large roots. Current main serializes additions, but the work per root, whether it needs hydration, and worker backlog determine duration. | This is not evidence that serial hydration is harmless; one batch still gates on its slowest cumulative wave and one worker still has finite CPU. |

Together, the signatures are consistent with wave-level gating plus variable per-query materialization cost. They contradict a simple "latency equals a constant multiplied by root count" model. To assign any production sample to hydration versus worker queueing, capture both CPU-ish query time and query-wave wall time for that sample.

## Ranked change candidates

### 1. Put the tracker graph in a second registration tier on this page

**Where:** Goblins assignment route registration, with no Zero protocol change. Same-tick client batching occurs in `zero-client/query-manager.ts`.

**Mechanism:** Let the small shell/summary/roster/problem roots commit first. Register `problem_trackers.for_assignment` after the first tier is stamped, while the performance section keeps its existing loading state. This changes user-perceived latency, not raw tracker CPU.

**Measured expectation:** First content improved from a 1.424-second median to 0.571 seconds in the two-tier replay. Total settle was 1.331 instead of 1.425 seconds. The exact product render point must be checked because the performance grid itself requires roster, problems, and trackers.

**Risk:** Two CVR/poke cycles, an intentional intermediate UI state, and possible regression to a waterfall if more than two tiers are introduced. The route was deliberately coalesced after an older dependent-wave problem, so preserve one compact first tier and one heavy tier.

**Validation:** Repeat cold and warm page runs, assert header/summary settle before performance, verify no false empty roster, and compare total server CPU plus CVR writes.

### 2. Reduce or replace the initial raw tracker graph

**Where:** Goblins `problem_trackers.for_assignment` contract and the assignment performance data model.

**Mechanism:** The tracker graph consumes 74% of median timed query processing and carries 973 trackers, 973 conversations, and 957 assessments. A compact per-student/per-assignment aggregate for initial sorting and mastery, followed by visible/detail tracker reads, would reduce both critical latency and sync-worker CPU. Merely deleting a duplicate query will not help the wire: the current related rows are real data.

**Expected effect:** This is the only page-specific candidate that reduces the dominant unit of work rather than only scheduling it. The upper bound is large, but no exact gain is claimed without a replacement query.

**Risk:** New materialized aggregates or windowed reads must preserve live mastery, solved counts, whiteboard-head selection, sorting, filtering, and access control. Query windows must also avoid large `IN` lists.

**Validation:** Benchmark the exact replacement AST at 136 students / 24 problems and at a 500-student boundary. Compare lifecycle row events, unique poke rows/bytes, timed materialization, and update fanout.

### 3. Spread concurrent client groups across more sync-worker CPU

**Where:** `ZERO_NUM_SYNC_WORKERS`, task CPU allocation, and the existing `taskID/clientGroupID` dispatcher.

**Mechanism:** The local N-series deliberately pinned all groups to one worker and exposed nearly linear queueing. In multiprocess mode, more worker processes or tasks distribute distinct groups across cores. This does not accelerate one client's six-root wave. Raising the count in single-process mode does not provide the same per-core capacity.

**Expected effect:** For independent groups and spare cores, reduce queue depth toward groups-per-worker rather than total groups. It is an operational mitigation, not an algorithmic reduction.

**Risk:** More replica readers, memory, CVR/upstream connections, and possible hash skew. Production may already use the default near-maximum worker count, so verify execution mode, actual worker count, and per-worker CPU before changing it.

**Validation:** Run the same N=8 and N=16 replay at 1, 2, 4, and 8 workers. Record dispatcher distribution, per-worker CPU/event-loop delay, query-wave wall, CVR latency, and database load.

### 4. Share identical pipeline work across client groups

**Where:** Syncer-level pipeline ownership in `workers/syncer.ts`, `PipelineDriver.addQuery/advance`, and per-group CVR/poke projection in `view-syncer.ts`.

**Mechanism:** Current main already reports `pipelines_total`, `pipelines_unique`, and a dedup factor keyed by `(clientSchema, transformationHash)` as "available to shared pipeline advancement," but every ViewSyncer still builds and hydrates its own pipeline. A shared immutable plan, materialized row set, or live pipeline for exactly matching schema and transformed AST could compute once and project results into each group's CVR.

**Expected effect:** High for bursts of identical assignment/query/auth shapes, including this controlled concurrent replay. Low when literals, auth transformation, or client schemas differ. The existing dedup gauges can size the eligible fraction before implementation.

**Risk:** High. Auth isolation, schema identity, query TTL, row-set signatures, pipeline lifetime, per-group cookies, recovery, and push ordering must remain correct. Start with immutable plan reuse or cold-hydration result reuse before shared mutable advancement.

**Validation:** Require byte-for-byte equivalent pokes and CVRs under connect/disconnect, auth changes, schema changes, mutations, and pipeline reset. Benchmark only the eligible dedup fraction and report memory as well as CPU.

### 5. Cache/reuse query planning separately from stateful hydration

**Where:** `packages/zql` planner/builder and `PipelineDriver.#addQueryImpl`.

**Mechanism:** Planning is 14.1% inclusive in the eight-group profile, and identical groups rebuild equivalent operator plans. Cache an immutable planner decision/blueprint with a key that includes normalized query shape, schema/index state, and planner configuration, then instantiate fresh stateful operators per ViewSyncer.

**Expected effect:** Smaller than sharing materialization, but lower risk and useful even when row sets cannot be shared. The eight-group profile gives a rough ceiling around the measured planning share, not a promised 14% end-to-end gain.

**Risk:** Stale cost decisions after schema/index/stat changes and accidental sharing of stateful operators. Do not cache a live operator graph.

**Validation:** Add exact tracker and roster ASTs to planner benchmarks, compare plans/results before and after schema changes, and profile `buildPipeline`/`plan` again under N=8.

### 6. Generalize two-tier completion in Zero only after page-level proof

**Where:** `ViewSyncer.#addAndRemoveQueries` and poke/CVR versioning.

**Mechanism:** A server-side row/CPU budget could close a first poke after cheap queries and continue expensive additions in a later version. This would make the measured two-tier benefit available without app-specific registration timing.

**Expected effect:** Better time to partial data; little or no raw CPU reduction.

**Risk:** High protocol and product complexity. Query-set consumers may assume one stamped cohort, and cost is unknown before a cold hydration. Page-level explicit tiers are safer and easier to reason about.

**Validation:** Specify partial-query readiness semantics first. Then test query removal, reconnect, catch-up, and failure between versions before performance work.

## Observability needed before a production rollout

Current main has useful aggregate metrics, but it cannot join a slow production sample to a worker, group, query, and scheduler wait:

- `zero.sync.view_syncer_hydration` covers transform through `pokeEnd`, but has no group/query attribution.
- Per-query materialization is an inspector metric/manual synthetic span. Its `TimeSliceTimer` excludes yield waits.
- `zero.sync.lock-wait-time` records acquisition wait, not lock-hold/work time or queue depth.
- CVR and poke metrics have no group/client attribution.
- No event-loop delay or utilization monitor exists in the scoped zero-cache/otel source.
- `zero.sync.ivm.advance-time` currently declares a `type` label from a local variable that is never assigned. This affects change advancement attribution, not this initial hydration, but should be fixed.

Add low-cardinality production metrics for worker-index query-wave wall, query CPU-ish time, rows, query name, lock hold, CVR, and poke. Put client-group IDs only in sampled traces or structured diagnostic logs, not metric labels. Add event-loop utilization/delay per sync worker so production can distinguish "expensive query on an idle worker" from "ordinary query waiting behind N peers."

## Benchmark calibration result

Neither available general harness produced a valid calibration number for this diagnosis:

- Current-main `apps/zero-throughput` targets steady-state write fanout rather than this cold assignment hydration. The attempted one-user relational run failed during query-plan analysis with `Unexpected token 'o', "[object ArrayBuffer]" is not valid JSON` before it emitted a benchmark result.
- `rocicorp/mono#6417` adds a broader pipeline harness, but it is open and unmerged relative to the tested commit. Its local smoke attempt printed startup output and left databases/profiles but no valid benchmark metric. The profiles were 98--99% idle over roughly 61 seconds, which proves the intended load did not run. They are not used in any conclusion above.

The custom six-query replay is therefore the calibration artifact. It exercises the current running WebSocket path, the production-shaped ASTs, current query transformation, current PipelineDriver, CVR, and poke path directly.

## Evidence and reproducibility

Primary artifacts:

- `current-run/mode-runs/*.txt` -- three runs of each registration control
- `current-run/wave-2-stage-events.json` -- representative stage and lifecycle events
- `current-run/concurrency/summary.json` -- raw client rows and per-N medians
- `current-run/profiles/single-wave.cpuprofile`
- `current-run/profiles/eight-groups.cpuprofile`
- `current-run/profiles/profile-summary.txt` -- self and inclusive profile attribution
- `instrumentation.diff` -- temporary stage probes
- `worktree-inventory.txt` -- final checkout state

The temporary instrumentation typechecks with `pnpm --filter zero-cache check-types`, and `git diff --check` passes. No diagnosis code was committed, pushed, or deployed.

The mono worktree is intentionally not clean. Fifteen staged `packages/zero-cache/bench/pipeline/*` files are the imported unmerged benchmark reference, not current-main baseline and not diagnosis instrumentation. The only diagnosis edit is an unstaged 73-line `view-syncer.ts` diff that adds temporary stage logs. All source conclusions and line references above were checked with `git show HEAD:` against `ac5eb231`, so neither working-tree category is mistaken for current code.

## Limitations

- This is a production-shaped reconstruction, not a copied production database. Counts, timestamps, query shapes, and relationships are preserved where needed; nonessential columns were not independently compared.
- Absolute local time depends on this machine. The one-worker setup is deliberate and only establishes per-worker capacity behavior.
- Transform was local and warm. A slow production query API can add another independent stage, but it was not the bottleneck here.
- Fresh client groups force cold ViewSyncer pipeline hydration. Persisted/warm client groups can take different paths.
- CPU-profile sampling and inclusive stack attribution are approximate. The stage events provide the wall/CPU separation.
- No valid general throughput-harness result is available, so this report does not extrapolate a requests-per-second capacity number.
