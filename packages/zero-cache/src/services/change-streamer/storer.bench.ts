import {bench, describe, use} from '../../../../shared/src/bench.ts';
import {BigIntJSON} from '../../../../shared/src/bigint-json.ts';
import type {ChangeStreamData} from '../change-source/protocol/current/downstream.ts';
import {extractChangeSubstring} from './storer.ts';

const ROWS = 1000;
const messages: ChangeStreamData[] = [
  ['begin', {tag: 'begin'}, {commitWatermark: '03'}],
  ...Array.from(
    {length: ROWS},
    (_, id) =>
      [
        'data',
        {
          tag: 'insert',
          relation: {
            schema: 'public',
            name: 'issues',
            rowKey: {type: 'default', columns: ['id']},
          },
          new: {
            id,
            big: BigInt(Number.MAX_SAFE_INTEGER) + BigInt(id),
            text: `issue ${id}`,
            json: {id, tags: ['replication', 'benchmark']},
          },
        },
      ] satisfies ChangeStreamData,
  ),
  ['commit', {tag: 'commit'}, {watermark: '03'}],
];

function stringifyAndExtract() {
  let totalLength = 0;
  for (const message of messages) {
    const json = BigIntJSON.stringify(message);
    totalLength += extractChangeSubstring(json, message[1].tag).length;
  }
  return totalLength;
}

function stringifyStreamAndChangeSeparately() {
  let totalLength = 0;
  for (const message of messages) {
    totalLength += BigIntJSON.stringify(message).length;
    totalLength += BigIntJSON.stringify(message[1]).length;
  }
  return totalLength;
}

describe('change-streamer storer serialization benchmark', () => {
  bench(
    'single stringify plus substring extraction',
    () => use(stringifyAndExtract()),
    {min_cpu_time: 500_000_000, min_samples: 20},
  );

  bench(
    'separate stream and change stringification',
    () => use(stringifyStreamAndChangeSeparately()),
    {min_cpu_time: 500_000_000, min_samples: 20},
  );
});
