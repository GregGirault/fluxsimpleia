import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, summarizeScorecard } from '../scorecard.mjs';

const H = 'date_utc,provider,model,client_version,workload_id,attempts,successful_jobs,failed_jobs,api_spend_usd,median_latency_ms,p95_latency_ms,notes';
const row = (provider, successes, failures, attempts, spend, p95, workload = 'coding') =>
  ['2026-11-06T00:00:00Z', provider, 'model-a', 'v1', workload, attempts, successes, failures, spend, 150, p95, '"test, repeat"'].join(',');

test('parses BOM, CRLF, quoted commas, escaped quotes and blank lines', () => {
  const csv = '\uFEFF' + H + '\r\n' + row('Provider A',2,1,4,'3.50',300).replace('"test, repeat"', '"test, ""repeat"""') + '\r\n\r\n';
  const parsed = parseCSV(csv);
  assert.equal(parsed.length,1);
  assert.equal(parsed[0].notes,'test, "repeat"');
});

test('cost, attempts, retries and failure ratio are weighted across batches', () => {
  const csv = [H,row('Provider A',2,1,4,'3.50',300),row('Provider A',4,0,5,'2.50',450),row('Provider B',3,2,5,'9.00',600)].join('\n');
  const report = summarizeScorecard(csv);
  assert.equal(report.rows,3);
  assert.equal(report.cohorts,2);
  assert.equal(report.observed_spend_usd,15);
  const a = report.results.find(x => x.provider === 'Provider A');
  assert.equal(a.successful_jobs,6);
  assert.equal(a.retry_attempts,2);
  assert.equal(a.api_spend_usd,6);
  assert.equal(a.cost_per_success_usd,1);
  assert.equal(a.failure_rate,1/7);
  assert.deepEqual(a.p95_observed_range_ms,[300,450]);
});

test('separates workload cohorts rather than misranking incomparable jobs', () => {
  const csv = [H,row('A',1,0,1,'1',250,'coding'),row('A',1,0,1,'20',250,'media')].join('\n');
  const report = summarizeScorecard(csv);
  assert.equal(report.cohorts,2);
  assert.equal(report.finished_jobs,2);
});

test('zero successes remain unavailable rather than division by zero', () => {
  const csv = [H,row('A',0,2,3,'4.5',250)].join('\n');
  const report = summarizeScorecard(csv);
  assert.equal(report.results[0].cost_per_success_usd,null);
  assert.equal(report.results[0].failure_rate,1);
});

test('rejects malformed or inconsistent input', () => {
  const bad = [
    [H,row('A',2,1,2,'1',250)].join('\n'),
    [H,row('A',2,1,3,'-1',250)].join('\n'),
    [H,row('A',2,1,3,'1',120)].join('\n'),
    [H.replace('provider','date_utc'),row('A',2,1,3,'1',250)].join('\n'),
    [H,row('A',1,0,9007199254740991,'1',250),row('A',1,0,9007199254740991,'1',250)].join('\n'),
    H,
    H + '\n"unclosed',
  ];
  bad.forEach(x => assert.throws(() => summarizeScorecard(x)));
});
