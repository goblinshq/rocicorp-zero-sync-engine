/* oxlint-disable no-console */
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {BigIntJSON} from '../../shared/src/bigint-json.ts';
import {createSilentLogContext} from '../../shared/src/logging-test-utils.ts';
import {Broadcast} from '../src/services/change-streamer/broadcast.ts';
import type {WatermarkedChange} from '../src/services/change-streamer/change-streamer-service.ts';
import {PROTOCOL_VERSION} from '../src/services/change-streamer/change-streamer.ts';
import {Subscriber} from '../src/services/change-streamer/subscriber.ts';
import {Subscription} from '../src/types/subscription.ts';
import {
  argValue,
  envFlag,
  envInt,
  envNumber,
  envString,
  formatRate,
  percentile,
  sum,
  writeJsonSummary,
} from './perf-utils.ts';

type Strategy = {
  readonly name: string;
  readonly paddingMs: number;
  readonly monitorIntervalMs: number | undefined;
};

type Consumer = {
  readonly sub: Subscriber;
  readonly stop: () => void;
  readonly done: Promise<void>;
  readonly samplePending: () => void;
  readonly stats: () => {
    readonly processed: number;
    readonly maxPending: number;
    readonly avgPending: number;
  };
};

type ScenarioSummary = {
  readonly strategy: string;
  readonly subscriberCount: number;
  readonly slowSubscribers: number;
  readonly flushes: number;
  readonly effectiveFlushesPerSec: number;
  readonly p50WaitMs: number;
  readonly p95WaitMs: number;
  readonly maxWaitMs: number;
  readonly maxPendingLag: number;
  readonly avgPendingLag: number;
  readonly processedMessages: number;
  readonly flowControlConsensusPaddingMs: number;
  readonly monitorIntervalMs: number | undefined;
  readonly fastAckDelayMs: number;
  readonly slowAckDelayMs: number;
  readonly elapsedMs: number;
};

type Summary = {
  readonly name: 'zero-cache-fanout-flow-control';
  readonly mode: 'smoke' | 'full';
  readonly generatedAt: string;
  readonly scenarios: readonly ScenarioSummary[];
};

const lc = createSilentLogContext();
const initialWatermark = '000000000000';
const strategies: readonly Strategy[] = [
  {
    name: 'polling-1s-monitor-1s-padding',
    paddingMs: 1000,
    monitorIntervalMs: 1000,
  },
  {
    name: 'polling-1s-monitor-100ms-padding',
    paddingMs: 100,
    monitorIntervalMs: 1000,
  },
  {
    name: 'precise-100ms-padding',
    paddingMs: 100,
    monitorIntervalMs: undefined,
  },
];

function watermarkFor(seq: number) {
  return seq.toString().padStart(12, '0');
}

function makeChange(seq: number): WatermarkedChange {
  const watermark = watermarkFor(seq + 1);
  return [
    watermark,
    'commit',
    BigIntJSON.stringify(['commit', {tag: 'commit'}, {watermark}]),
  ];
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      {once: true},
    );
  });
}

function makeConsumer(id: string, ackDelayMs: number): Consumer {
  const controller = new AbortController();
  const downstream = Subscription.create<string>();
  const sub = new Subscriber(
    PROTOCOL_VERSION,
    id,
    initialWatermark,
    downstream,
    () => ({tag: 'status'}),
  );
  let processed = 0;
  let maxPending = 0;
  let totalPending = 0;
  let samples = 0;
  const samplePending = () => {
    const pending = sub.numPending;
    maxPending = Math.max(maxPending, pending);
    totalPending += pending;
    samples++;
  };
  const done = (async () => {
    for await (const _message of downstream) {
      await delay(ackDelayMs, controller.signal);
      if (controller.signal.aborted) {
        break;
      }
      processed++;
      samplePending();
    }
  })();
  sub.setCaughtUp();
  return {
    sub,
    done,
    samplePending,
    stop: () => {
      controller.abort();
      sub.close();
    },
    stats: () => ({
      processed,
      maxPending,
      avgPending: samples === 0 ? 0 : totalPending / samples,
    }),
  };
}

function makeConsumers(
  subscriberCount: number,
  fastAckDelayMs: number,
  slowAckDelayMs: number,
): Consumer[] {
  return Array.from({length: subscriberCount}, (_, i) =>
    makeConsumer(
      `sub-${i}`,
      i === subscriberCount - 1 ? slowAckDelayMs : fastAckDelayMs,
    ),
  );
}

async function runScenario(
  strategy: Strategy,
  subscriberCount: number,
  flushes: number,
  fastAckDelayMs: number,
  slowAckDelayMs: number,
): Promise<ScenarioSummary> {
  const consumers = makeConsumers(
    subscriberCount,
    fastAckDelayMs,
    slowAckDelayMs,
  );
  const subscribers = consumers.map(({sub}) => sub);
  const waitTimes: number[] = [];
  let current: Broadcast | undefined;
  const monitor =
    strategy.monitorIntervalMs === undefined
      ? undefined
      : setInterval(() => {
          current?.checkProgress(lc, strategy.paddingMs, performance.now());
        }, strategy.monitorIntervalMs);
  const start = performance.now();
  try {
    for (let i = 0; i < flushes; i++) {
      const broadcast = new Broadcast(
        subscribers,
        makeChange(i),
        strategy.monitorIntervalMs === undefined
          ? {lc, flowControlConsensusPaddingMs: strategy.paddingMs}
          : undefined,
      );
      current = broadcast;
      const waitStart = performance.now();
      await broadcast.done;
      waitTimes.push(performance.now() - waitStart);
      for (const consumer of consumers) {
        consumer.samplePending();
      }
      current = undefined;
    }
  } finally {
    clearInterval(monitor);
    for (const consumer of consumers) {
      consumer.stop();
    }
    await Promise.all(consumers.map(({done}) => done));
  }
  const elapsedMs = performance.now() - start;
  const stats = consumers.map(consumer => consumer.stats());
  const maxPendingLag = Math.max(0, ...stats.map(({maxPending}) => maxPending));
  const totalPending = sum(stats.map(({avgPending}) => avgPending));
  return {
    strategy: strategy.name,
    subscriberCount,
    slowSubscribers: 1,
    flushes,
    effectiveFlushesPerSec: (flushes * 1000) / elapsedMs,
    p50WaitMs: percentile(waitTimes, 50),
    p95WaitMs: percentile(waitTimes, 95),
    maxWaitMs: Math.max(0, ...waitTimes),
    maxPendingLag,
    avgPendingLag: stats.length === 0 ? 0 : totalPending / stats.length,
    processedMessages: sum(stats.map(({processed}) => processed)),
    flowControlConsensusPaddingMs: strategy.paddingMs,
    monitorIntervalMs: strategy.monitorIntervalMs,
    fastAckDelayMs,
    slowAckDelayMs,
    elapsedMs,
  };
}

function parseSubscriberCounts(fallback: readonly number[]) {
  const value = envString('ZERO_FANOUT_SUBSCRIBERS');
  if (value === undefined) {
    return [...fallback];
  }
  return value.split(',').map(part => {
    const parsed = Number.parseInt(part, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`Invalid subscriber count ${part}`);
    }
    return parsed;
  });
}

function printScenario(summary: ScenarioSummary) {
  console.log(
    [
      summary.strategy,
      `${summary.subscriberCount} subs`,
      `${summary.flushes} flushes`,
      `${formatRate(summary.effectiveFlushesPerSec)} flushes/s`,
      `p95 wait ${summary.p95WaitMs.toFixed(1)} ms`,
      `max wait ${summary.maxWaitMs.toFixed(1)} ms`,
      `max lag ${summary.maxPendingLag}`,
    ].join(' | '),
  );
}

export async function main() {
  const full = envFlag('ZERO_FANOUT_FULL');
  const flushes = envInt('ZERO_FANOUT_FLUSHES', full ? 10 : 3);
  const fastAckDelayMs = envNumber('ZERO_FANOUT_FAST_ACK_DELAY_MS', 0);
  const slowAckDelayMs = envNumber('ZERO_FANOUT_SLOW_ACK_DELAY_MS', 5000);
  const subscriberCounts = parseSubscriberCounts(
    full ? [4, 8, 16, 32] : [4, 8, 16],
  );
  const output = argValue('out') ?? process.env.ZERO_BENCH_OUT;
  const scenarios: ScenarioSummary[] = [];

  for (const subscriberCount of subscriberCounts) {
    for (const strategy of strategies) {
      const summary = await runScenario(
        strategy,
        subscriberCount,
        flushes,
        fastAckDelayMs,
        slowAckDelayMs,
      );
      scenarios.push(summary);
      printScenario(summary);
    }
  }

  const summary: Summary = {
    name: 'zero-cache-fanout-flow-control',
    mode: full ? 'full' : 'smoke',
    generatedAt: new Date().toISOString(),
    scenarios,
  };
  await writeJsonSummary(summary, output);
  console.log(JSON.stringify(summary));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
