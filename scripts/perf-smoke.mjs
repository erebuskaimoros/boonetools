#!/usr/bin/env node

import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';

const DEFAULT_BASE = 'http://127.0.0.1:8787/functions/v1';
const rapidNow = new Date();
const RAPID_RANGE_FROM = Math.floor(Date.UTC(
  rapidNow.getUTCFullYear(),
  rapidNow.getUTCMonth(),
  rapidNow.getUTCDate() - 6
) / 1000);
const RAPID_RANGE_TO = Math.floor(Date.now() / 1000);
const ENDPOINTS = [
  { name: 'status', path: '/status-dashboard', maxMs: 750, maxBytes: 25_000 },
  { name: 'status-live', path: '/status-live', maxMs: 500, maxBytes: 5_000 },
  { name: 'treasury', path: '/treasury-snapshot', maxMs: 1_500, maxBytes: 200_000 },
  { name: 'app-live', path: '/app-layer-live-state', maxMs: 1_000, maxBytes: 200_000 },
  { name: 'app-earnings', path: '/app-layer-base-layer-earnings', maxMs: 1_000, maxBytes: 150_000 },
  { name: 'app-fees', path: '/app-layer-base-fees', maxMs: 1_000, maxBytes: 100_000 },
  { name: 'app-reserve', path: '/app-layer-reserve-payments', maxMs: 1_000, maxBytes: 150_000 },
  { name: 'node-votes', path: '/node-votes-summary', maxMs: 1_000, maxBytes: 150_000 },
  {
    name: 'rapid-swaps',
    path: `/rapid-swaps-summary?include_all=false&limit=20&offset=0&sort=date&direction=desc&chart_from=${RAPID_RANGE_FROM}&chart_to=${RAPID_RANGE_TO}`,
    maxMs: 1_000,
    maxBytes: 150_000
  },
  {
    name: 'rapid-market',
    path: `/rapid-swaps-swap-history?interval=hour&from=${RAPID_RANGE_FROM}&to=${RAPID_RANGE_TO}`,
    maxMs: 1_000,
    maxBytes: 150_000
  },
  { name: 'tc-fee', path: '/tc-fee-dash', maxMs: 1_000, maxBytes: 250_000 },
  { name: 'pol-tracker', path: '/pol-tracker', maxMs: 1_000, maxBytes: 500_000 },
  { name: 'pool-dislocation', path: '/pool-dislocation', maxMs: 1_000, maxBytes: 750_000 }
];

function parseArgs(argv) {
  const options = {
    base: DEFAULT_BASE,
    concurrency: 1,
    endpoint: '',
    requests: 1,
    requireCompression: false,
    allowStale: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--base') options.base = argv[++index];
    else if (value === '--concurrency') options.concurrency = Number(argv[++index]);
    else if (value === '--endpoint') options.endpoint = String(argv[++index] || '');
    else if (value === '--requests') options.requests = Number(argv[++index]);
    else if (value === '--require-compression') options.requireCompression = true;
    else if (value === '--allow-stale') options.allowStale = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  options.base = String(options.base || DEFAULT_BASE).replace(/\/$/, '');
  options.concurrency = Math.max(1, Math.trunc(options.concurrency) || 1);
  options.requests = Math.max(1, Math.trunc(options.requests) || 1);
  return options;
}

function percentile(values, percentileValue) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1);
  return sorted[Math.max(0, index)];
}

function requestRaw(url) {
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const request = transport.request(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'zstd, gzip'
      },
      timeout: 30_000
    }, (response) => {
      let bytes = 0;
      response.on('data', (chunk) => { bytes += chunk.length; });
      response.on('end', () => {
        const cacheState = String(response.headers['x-boone-cache'] || '');
        const explicitStale = String(response.headers['x-boone-read-model-stale'] || '') === '1';
        resolve({
          status: response.statusCode || 0,
          durationMs: performance.now() - startedAt,
          bytes,
          encoding: String(response.headers['content-encoding'] || 'identity'),
          contentType: String(response.headers['content-type'] || ''),
          cacheState,
          stale: explicitStale || cacheState.toLowerCase().includes('stale')
        });
      });
    });
    request.on('timeout', () => request.destroy(new Error(`Timed out: ${url}`)));
    request.on('error', reject);
    request.end();
  });
}

async function runPool(total, concurrency, operation) {
  let next = 0;
  const results = [];
  async function worker() {
    while (next < total) {
      const current = next;
      next += 1;
      results[current] = await operation(current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(total, concurrency) }, () => worker()));
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const failures = [];
  const endpoints = options.endpoint
    ? ENDPOINTS.filter((endpoint) => endpoint.name === options.endpoint)
    : ENDPOINTS;
  if (endpoints.length === 0) {
    throw new Error(`Unknown endpoint: ${options.endpoint}`);
  }
  console.log(`Performance smoke: ${options.base} (${options.requests} request(s), concurrency ${options.concurrency})`);

  for (const endpoint of endpoints) {
    const url = new URL(`${options.base}${endpoint.path}`);
    let samples;
    try {
      samples = await runPool(options.requests, options.concurrency, () => requestRaw(url));
    } catch (error) {
      failures.push(`${endpoint.name}: ${error.message}`);
      console.log(`${endpoint.name.padEnd(12)} ERROR ${error.message}`);
      continue;
    }

    const p95 = percentile(samples.map((sample) => sample.durationMs), 0.95);
    const maxBytes = Math.max(...samples.map((sample) => sample.bytes));
    const errors = samples.filter((sample) => sample.status < 200 || sample.status >= 300);
    const stale = samples.filter((sample) => sample.stale);
    const compressed = samples.every((sample) => sample.encoding !== 'identity');
    const jsonResponses = samples.every((sample) => sample.contentType.toLowerCase().includes('application/json'));
    const checks = [
      errors.length === 0,
      options.allowStale || stale.length === 0,
      p95 <= endpoint.maxMs,
      maxBytes <= endpoint.maxBytes,
      !options.requireCompression || compressed,
      jsonResponses
    ];

    console.log(
      `${endpoint.name.padEnd(12)} ${checks.every(Boolean) ? 'PASS' : 'FAIL'} `
      + `p95=${p95.toFixed(0)}ms bytes=${maxBytes} encoding=${samples[0].encoding} `
      + `cache=${samples[0].cacheState || 'unreported'} stale=${stale.length} errors=${errors.length}`
    );

    if (errors.length) failures.push(`${endpoint.name}: ${errors.length} non-2xx response(s)`);
    if (!options.allowStale && stale.length) failures.push(`${endpoint.name}: ${stale.length} stale response(s)`);
    if (p95 > endpoint.maxMs) failures.push(`${endpoint.name}: p95 ${p95.toFixed(0)}ms > ${endpoint.maxMs}ms`);
    if (maxBytes > endpoint.maxBytes) failures.push(`${endpoint.name}: ${maxBytes} bytes > ${endpoint.maxBytes}`);
    if (options.requireCompression && !compressed) failures.push(`${endpoint.name}: response was not compressed`);
    if (!jsonResponses) failures.push(`${endpoint.name}: response content type was not JSON`);
  }

  if (failures.length) {
    console.error(`\n${failures.length} performance budget failure(s):`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  }
}

await main();
