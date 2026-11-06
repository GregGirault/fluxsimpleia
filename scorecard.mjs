const REQUIRED_FIELDS = [
  'date_utc', 'provider', 'model', 'client_version', 'workload_id',
  'attempts', 'successful_jobs', 'failed_jobs', 'api_spend_usd',
  'median_latency_ms', 'p95_latency_ms', 'notes'
];

export function parseCSV(text) {
  if (typeof text !== 'string') throw new TypeError('CSV input must be text.');
  if (text.length > 2_000_000) throw new Error('CSV exceeds the 2 MB limit.');
  const input = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let afterQuote = false;
  const finishField = () => {
    row.push(field);
    field = '';
    afterQuote = false;
  };
  const finishRow = () => {
    finishField();
    if (row.some(cell => cell.trim() !== '')) rows.push(row);
    if (rows.length > 5001) throw new Error('CSV exceeds the 5,000 data-row limit.');
    row = [];
  };
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        field += char;
      }
    } else if (char === ',' || char === '\r' || char === '\n') {
      if (char === ',') {
        finishField();
      } else {
        finishRow();
        if (char === '\r' && input[i + 1] === '\n') i += 1;
      }
    } else if (char === '"') {
      if (field !== '' || afterQuote) throw new Error('Unexpected quote in CSV.');
      quoted = true;
    } else if (afterQuote && (char === ' ' || char === '\t')) {
      // Harmless whitespace outside a quoted value.
    } else if (afterQuote) {
      throw new Error('Unexpected text after closing CSV quote.');
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error('Unclosed quoted value in CSV.');
  if (row.length || field !== '' || afterQuote) finishRow();
  if (rows.length === 0) throw new Error('CSV is empty.');
  const headers = rows.shift().map(x => x.trim());
  if (new Set(headers).size !== headers.length) throw new Error('Duplicate CSV column names.');
  const missing = REQUIRED_FIELDS.filter(key => !headers.includes(key));
  if (missing.length) throw new Error('Missing required columns: ' + missing.join(', '));
  return rows.map((cells, index) => {
    if (cells.length !== headers.length) {
      throw new Error('CSV row ' + (index + 2) + ': expected ' + headers.length + ' values; got ' + cells.length + '.');
    }
    return Object.fromEntries(headers.map((header, i) => [header, cells[i]]));
  });
}

function numeric(value, name, rowNumber, integer = false, optional = false) {
  const raw = String(value ?? '').trim();
  if (optional && raw === '') return null;
  const valid = integer ? /^\d+$/ : /^(?:\d+(?:\.\d*)?|\.\d+)$/;
  const result = Number(raw);
  if (!valid.test(raw) || !Number.isFinite(result) || (integer && !Number.isSafeInteger(result))) {
    throw new Error('CSV row ' + rowNumber + ': invalid non-negative ' + name + '.');
  }
  return result;
}

export function summarizeScorecard(csvText) {
  const records = parseCSV(csvText);
  if (!records.length) throw new Error('Add at least one measurement row below the header.');
  const groups = new Map();
  let completed = 0;
  let totalSpend = 0;
  records.forEach((raw, index) => {
    const rowNumber = index + 2;
    const data = {};
    for (const key of ['provider', 'model', 'workload_id', 'client_version']) {
      data[key] = raw[key].trim();
      if (!data[key]) throw new Error('CSV row ' + rowNumber + ': ' + key + ' is required.');
    }
    if (!raw.date_utc.trim() || Number.isNaN(Date.parse(raw.date_utc.trim()))) {
      throw new Error('CSV row ' + rowNumber + ': date_utc is not a valid date.');
    }
    data.attempts = numeric(raw.attempts, 'attempts', rowNumber, true);
    data.successful_jobs = numeric(raw.successful_jobs, 'successful_jobs', rowNumber, true);
    data.failed_jobs = numeric(raw.failed_jobs, 'failed_jobs', rowNumber, true);
    data.api_spend_usd = numeric(raw.api_spend_usd, 'api_spend_usd', rowNumber);
    data.median_latency_ms = numeric(raw.median_latency_ms, 'median_latency_ms', rowNumber, false, true);
    data.p95_latency_ms = numeric(raw.p95_latency_ms, 'p95_latency_ms', rowNumber, false, true);
    const finishedJobs = data.successful_jobs + data.failed_jobs;
    if (finishedJobs === 0 || data.attempts < finishedJobs) {
      throw new Error('CSV row ' + rowNumber + ': attempts must cover at least one completed or failed job.');
    }
    if (data.median_latency_ms !== null && data.p95_latency_ms !== null &&
        data.p95_latency_ms < data.median_latency_ms) {
      throw new Error('CSV row ' + rowNumber + ': p95 latency cannot be below the median.');
    }
    const key = JSON.stringify([data.workload_id, data.model, data.client_version, data.provider]);
    if (!groups.has(key)) {
      groups.set(key, {
        provider: data.provider, model: data.model, workload_id: data.workload_id,
        client_version: data.client_version, attempts: 0, successful_jobs: 0,
        failed_jobs: 0, api_spend_usd: 0, rows: 0, p95_samples_ms: []
      });
    }
    const group = groups.get(key);
    group.rows += 1;
    group.attempts += data.attempts;
    group.successful_jobs += data.successful_jobs;
    group.failed_jobs += data.failed_jobs;
    group.api_spend_usd += data.api_spend_usd;
    if (data.p95_latency_ms !== null) group.p95_samples_ms.push(data.p95_latency_ms);
    completed += finishedJobs;
    totalSpend += data.api_spend_usd;
    if (!Number.isSafeInteger(group.attempts) || !Number.isSafeInteger(group.successful_jobs) ||
        !Number.isSafeInteger(group.failed_jobs) || !Number.isFinite(group.api_spend_usd) ||
        !Number.isSafeInteger(completed) || !Number.isFinite(totalSpend)) {
      throw new Error('CSV aggregation overflow; use smaller batches.');
    }
  });
  const results = [...groups.values()].map(group => {
    const finishedJobs = group.successful_jobs + group.failed_jobs;
    const p95Samples = group.p95_samples_ms;
    return {
      ...group,
      retry_attempts: group.attempts - finishedJobs,
      failure_rate: group.failed_jobs / finishedJobs,
      cost_per_success_usd: group.successful_jobs === 0 ? null : group.api_spend_usd / group.successful_jobs,
      p95_observed_range_ms: p95Samples.length
        ? [Math.min(...p95Samples), Math.max(...p95Samples)] : null,
      p95_samples_ms: undefined
    };
  });
  results.sort((a, b) =>
    [a.workload_id, a.model, a.client_version, a.provider].join('\u0000')
      .localeCompare([b.workload_id, b.model, b.client_version, b.provider].join('\u0000')));
  return { rows: records.length, cohorts: results.length, finished_jobs: completed, observed_spend_usd: totalSpend, results };
}
