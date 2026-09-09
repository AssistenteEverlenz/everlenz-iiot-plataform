import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const baseUrl = (process.env.LOAD_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const deviceId = process.env.LOAD_DEVICE_ID ?? '33333333-3333-4333-8333-333333333333';
const dashboardId = process.env.LOAD_DASHBOARD_ID ?? '55555555-5555-4555-8555-555555555555';
const stageSeconds = positiveNumber(process.env.LOAD_STAGE_SECONDS, 10);
const timeoutMs = positiveNumber(process.env.LOAD_TIMEOUT_MS, 5000);
const latencyLimitMs = positiveNumber(process.env.LOAD_P95_LIMIT_MS, 1500);
const errorLimit = positiveNumber(process.env.LOAD_ERROR_LIMIT_PERCENT, 2) / 100;
const warmupRequests = positiveNumber(process.env.LOAD_WARMUP_REQUESTS, 8);
const stages = (process.env.LOAD_RPS_STAGES ?? '5,10,20,40,80,160')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);

if (stages.length === 0)
  throw new Error('LOAD_RPS_STAGES must contain at least one positive value');

const paths = [
  `/api/devices/${deviceId}/latest`,
  `/api/dashboards/${dashboardId}`,
  `/api/devices/${deviceId}/statistics?hours=24`,
  `/api/telemetry?deviceId=${deviceId}&limit=250`,
];

const report = {
  startedAt: new Date().toISOString(),
  target: baseUrl,
  configuration: {
    stages,
    stageSeconds,
    timeoutMs,
    latencyLimitMs,
    errorLimitPercent: errorLimit * 100,
    warmupRequests,
  },
  stages: [],
  saturation: null,
};

await Promise.all(
  Array.from({ length: warmupRequests }, (_, index) => request(paths[index % paths.length])),
);

for (const rps of stages) {
  const measurements = [];
  const started = performance.now();

  for (let second = 0; second < stageSeconds; second += 1) {
    const tick = performance.now();
    await Promise.all(
      Array.from({ length: rps }, (_, index) =>
        request(paths[(second * rps + index) % paths.length]),
      ),
    ).then((values) => measurements.push(...values));
    const remaining = 1000 - (performance.now() - tick);
    if (remaining > 0) await new Promise((done) => setTimeout(done, remaining));
  }

  const elapsedMs = performance.now() - started;
  const successful = measurements.filter((item) => item.ok);
  const failures = measurements.length - successful.length;
  const errorRate = measurements.length === 0 ? 1 : failures / measurements.length;
  const latencies = measurements.map((item) => item.durationMs).sort((a, b) => a - b);
  const stage = {
    requestedRps: rps,
    achievedRps: round((measurements.length * 1000) / elapsedMs),
    requests: measurements.length,
    successful: successful.length,
    failures,
    errorPercent: round(errorRate * 100),
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    p99Ms: percentile(latencies, 99),
    statusCounts: Object.fromEntries(
      Object.entries(
        measurements.reduce((counts, item) => {
          counts[item.status] = (counts[item.status] ?? 0) + 1;
          return counts;
        }, {}),
      ).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };

  report.stages.push(stage);
  process.stdout.write(`${JSON.stringify(stage)}\n`);

  if (errorRate > errorLimit || stage.p95Ms > latencyLimitMs) {
    report.saturation = {
      requestedRps: rps,
      reason: errorRate > errorLimit ? 'error_rate' : 'p95_latency',
    };
    break;
  }
}

report.finishedAt = new Date().toISOString();
report.safeCapacityRps = report.saturation
  ? (report.stages.at(-2)?.requestedRps ?? 0)
  : report.stages.at(-1)?.requestedRps;

if (process.env.LOAD_REPORT_FILE) {
  const output = resolve(process.env.LOAD_REPORT_FILE);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

process.stdout.write(`${JSON.stringify({ summary: report }, null, 2)}\n`);

async function request(path) {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'everlenz-load-test/1.0',
      },
    });
    await response.arrayBuffer();
    return {
      ok: response.ok,
      status: String(response.status),
      durationMs: performance.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      status: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network_error',
      durationMs: performance.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function percentile(values, percentage) {
  if (values.length === 0) return 0;
  return round(values[Math.ceil((percentage / 100) * values.length) - 1]);
}

function round(value) {
  return Math.round(value * 100) / 100;
}
