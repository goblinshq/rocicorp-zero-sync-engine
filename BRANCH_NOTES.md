# `capy/streamer-batch` — hydration streaming allocation cuts

Three changes in `packages/zero-cache/src/services/view-syncer/pipeline-driver.ts`
that reduce per-row work in the `Streamer` path, plus a microbench that isolates
it. Output is byte-identical.

## Why this path

The 8-group CPU profile of the syncer shows `Streamer.stream` at 38.8% inclusive
and `Streamer.#streamNodes` at 36.2% inclusive, with GC at 7.6% self time. Almost
all of that is initial hydration, not push: one-group inclusive time for
`hydrateInternal` is 0.446 s against 0.444 s for `Streamer.stream`, so the two
frames are effectively the same stack. That also means the
`streamer.accumulate(queryID, schema, [change])` one-element array in the push
callback is *not* on the hot path — it costs one array per pushed change on a
path the profile barely reaches. It was left alone.

Most of the 36.2% inclusive is the lazy `fetch`/join work pulled *through*
`#streamNodes`, which no edit here can remove. What the Streamer itself owns is
per-row allocation and generator layering, and that is what these changes cut.

## The changes

**`getRowKey` builds the key with a loop.** It was
`Object.fromEntries(cols.map(col => [col, must(row[col])]))`: one array for the
pairs, one two-element array per primary-key column, then `Object.fromEntries`.
The loop allocates only the result object. This runs for every streamed row,
parent and child, so it is the broadest of the three.

**The relationship walk uses `Object.keys` instead of `Object.entries`.**
`Object.entries` allocates the outer array plus a two-element array per
relationship; `Object.keys` allocates only the outer array. Key order is
identical, so the recursion order into child relationships is unchanged.

**Initial hydration streams nodes without wrapping them in `Change` tuples.**
`hydrate`/`hydrateInternal` ran the fetched nodes through `toAdds`, which built a
`[ChangeType.ADD, node, null]` tuple per node, and `#streamChanges` then unwrapped
each tuple back into a fresh `() => [node]` one-element iterable for
`#streamNodes`. The new `Streamer.accumulateAdds` hands the node stream straight
to `#streamNodes` with `op = ADD`. Per top-level row this drops the tuple, the
closure, the one-element array and its iterator; and because `#streamChanges`
leaves the delegation chain, *every* row (child rows included) crosses one fewer
generator frame. `toAdds` is deleted.

This required hoisting the `system === 'permissions'` early return in
`#streamNodes` above the `#primaryKeys`/`#tableSpecs` lookups, so the new entry
point skips a permissions schema exactly as `#streamChanges` did. For a
non-permissions schema nothing changes; for a permissions schema both orders
return without emitting.

## Numbers

Microbench, `packages/zero-cache/src/services/view-syncer/streamer.bench.ts`.
Synthetic `Input`, node tree built once outside the loop, so this is Streamer
work only. 5000 rows per shape, median of 25+ samples, node v24.18.0.

| shape                        | before  | after    | change |
| ---------------------------- | ------- | -------- | ------ |
| 5000 rows, 0 children/parent | 2.82 ms | 0.94 ms  | −66.7% |
| 5000 rows, 1 child/parent    | 4.91 ms | 2.51 ms  | −48.9% |
| 5000 rows, 4 children/parent | 2.71 ms | 1.32 ms  | −51.3% |
| 5000 rows, 19 children/parent| 1.99 ms | 1.12 ms  | −43.7% |

End-to-end hydration through the real `PipelineDriver` against a seeded 61 MB
replica (20327 `problem` rows, 973 trackers, 973 conversations), 41 reps per
query, median / min wall time. This includes SQLite, joins and planning, so it
is the honest ceiling.

| query                              | rows  | before median | after median | change | before min | after min | change |
| ---------------------------------- | ----: | ------------: | -----------: | -----: | ---------: | --------: | -----: |
| flat scan of `problem`             | 20327 |     186.74 ms |    184.70 ms |  −1.1% |  179.84 ms | 174.44 ms |  −3.0% |
| tracker + conversations            |  1946 |      40.12 ms |     39.12 ms |  −2.5% |   36.06 ms |  35.25 ms |  −2.2% |
| tracker + problem + conversations  |  2919 |      63.57 ms |     58.66 ms |  −7.7% |   58.28 ms |  55.26 ms |  −5.2% |
| tracker WHERE EXISTS conversations |  1946 |      66.09 ms |     59.97 ms |  −9.3% |   61.59 ms |  56.68 ms |  −8.0% |
| assignment + problems + problem    |    71 |       2.08 ms |      1.94 ms |  −6.7% |    1.98 ms |   1.85 ms |  −6.6% |

Every shape improved on both median and min. The flat scan gains least because a
20327-row SQLite scan over a wide table dominates it; the nested and EXISTS
shapes, which are closer to the profiled workload, gain 5-9%.

## Equality proof

A scratch harness hydrated the five query shapes above through the real
`PipelineDriver` against the seeded replica, wrote every `RowChange` as one
canonical JSON line (recursively key-ordered, bigints stringified), and hashed
the stream. `'yield'` is skipped because its interleaving is wall-clock
dependent and never reaches the wire.

```
before: 27209 row changes  sha256 b788ab1ba2e17f2d42147ab715dd914bd6712efdf7be1aea988148f587458a9f
after:  27209 row changes  sha256 b788ab1ba2e17f2d42147ab715dd914bd6712efdf7be1aea988148f587458a9f
```

`diff before.jsonl after.jsonl` is empty. Since `RowChange` is what
`view-syncer.#processChanges` consumes, identical streams mean identical poke
content, ordering, chunking and CVR effects.

## Tests

- `pnpm --filter zero-cache run check-types` — clean
- `pnpm --filter zero-cache exec vitest run --project='*no-pg*'` — 132 files,
  1971 tests passed
- `pnpm --filter zero-cache exec vitest run --project='*pg-17*' src/services/view-syncer`
  — passed
- `pnpm --filter zero-cache run lint`, `oxfmt` — clean

## Rerunning

```bash
pnpm --filter zero-cache run bench streamer
```

The equality and end-to-end harnesses are scratch scripts, kept out of the
commit; they live with the numbers in `~/.capy/work/zc-streamer-results/`. Drop
`equality.ts`, `realistic.ts` and `queries.ts` into `packages/zero-cache/.scratch/`,
copy the seeded replica to `/tmp/assignment-replica.db`, then:

```bash
cd packages/zero-cache
node --experimental-strip-types .scratch/equality.ts /tmp/after.jsonl
node --experimental-strip-types .scratch/realistic.ts 41
```

## Risk

Low. One file, +38/−21, no public API change beyond a new method on a
module-private class. The one non-mechanical change is the reordered permissions
check described above; it is strictly more permissive and matches what
`#streamChanges` already did.
