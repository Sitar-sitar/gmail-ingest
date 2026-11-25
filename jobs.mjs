import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { AMAZON_TYPES, CARD_PROVIDERS, cardRange, jstDayStartSeconds, offsetDay, targetState } from './lib/state.mjs';
import { expectAmazonRows, readJsonLines, strictIds, verifyAmazonApplied, verifyAmazonSource, verifyCardSets, VerificationError } from './lib/verify.mjs';

function verifiedFile(root, file) {
  if (!path.isAbsolute(file)) throw new VerificationError();
  const actual = realpathSync.native(file);
  const relative = path.relative(root, actual);
  const stat = lstatSync(file);
  const matches = process.platform === 'win32' ? actual.toLowerCase() === file.toLowerCase() : actual === file;
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
      !matches || !stat.isFile() || stat.nlink !== 1) throw new VerificationError();
  return actual;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function failed(response) {
  if (!response.treeStopped) return { outcome: 'transient', code: 'timeout', pending: true };
  if (response.exitCode === 3 || response.failure === 'lock') return { outcome: 'not_run', code: 'lock', locked: true };
  if (response.failure === 'timeout') return { outcome: 'transient', code: 'timeout' };
  if (response.result?.status === 'verify_mismatch') return { outcome: 'permanent', code: 'verify_mismatch' };
  if (response.result?.validation?.ok === false) return { outcome: 'permanent', code: 'validation' };
  if (Array.isArray(response.result?.imports) && response.result.imports.some(({ failure_count: count }) => count > 0)) return { outcome: 'permanent', code: 'parse' };
  if ([429, 500, 502, 503, 504].includes(response.result?.http_status)) return { outcome: 'transient',
    code: response.result.http_status === 429 ? 'rate_limit' : 'network', httpStatus: response.result.http_status };
  if (response.result?.status === 'network_error') return { outcome: 'transient', code: 'network' };
  return { outcome: 'transient', code: 'unknown' };
}

export function listJobs(state, options, today) {
  const jobs = [];
  if (options.job !== 'amazon') {
    for (const provider of CARD_PROVIDERS) {
      const { confirmed_through: confirmed, last_outcome: outcome } = targetState(state, 'credit-card', provider);
      const range = cardRange(confirmed, state.business_from, today, options.gapOnly, outcome === 'gap_pending');
      jobs.push({ job: 'credit-card', targets: [provider], ranges: { [provider]: range } });
    }
  }
  if (options.job !== 'credit-card') {
    const previous = offsetDay(today, -1);
    const ranges = {};
    for (const type of AMAZON_TYPES) {
      const { confirmed_through: confirmed } = targetState(state, 'amazon', type);
      const from = confirmed ? offsetDay(confirmed, 1) : state.business_from;
      ranges[type] = from > previous ? null : { from, to: previous };
    }
    jobs.push({ job: 'amazon', targets: AMAZON_TYPES, ranges });
  }
  return jobs;
}

export async function executeCard({ step, paths, provider, range, state }) {
  const staging = path.join(paths.cardRoot, 'data', 'gmail-staging');
  mkdirSync(staging, { recursive: true });
  const out = path.join(staging, `run-${randomUUID()}`);
  const response = await step('credit-card', 'gmail-import-incremental.mjs', [
    '--provider', provider, '--mode', 'incremental', '--auth-file', paths.authFile,
    '--from', range.from, '--to', range.to, '--business-from', state.business_from, '--ingest-run-dir', out,
  ]);
  if (response.exitCode !== 0 || response.failure) return failed(response);
  const result = response.result;
  const [report] = Array.isArray(result?.imports) ? result.imports : [];
  if (result?.status !== 'success' || report?.provider !== provider || result.imports.length !== 1 ||
      report.failure_count !== 0 || result.log_validation?.status !== 'success' ||
      result.ingest_bounds?.business_from !== state.business_from || result.from_day !== range.from || result.to_day !== range.to ||
      result.ingest_bounds?.after !== jstDayStartSeconds(range.from) - 1 ||
      result.ingest_bounds?.before !== jstDayStartSeconds(offsetDay(range.to, 1))) throw new VerificationError();
  verifyCardSets(report.evidence ?? {});
  if (report.evidence.classifications.some(({ outcome }) => outcome === 'failed')) throw new VerificationError();
  const raw = verifiedFile(out, report.raw_path);
  const payload = verifiedFile(out, report.import_path);
  const ids = verifiedFile(out, path.join(path.dirname(raw), 'ids.json'));
  const expectedSearch = strictIds(report.evidence.searched);
  const actualSearch = strictIds(readJson(ids).message_ids);
  if (expectedSearch.size !== actualSearch.size || [...actualSearch].some((id) => !expectedSearch.has(id))) throw new VerificationError();
  verifyCardSets({ ...report.evidence, fetched: readJsonLines(raw).map(({ id }) => id),
    payload: readJson(payload).messages?.map(({ id }) => id) });
  return {
    outcome: range.hasMore ? 'gap_pending' : 'success', verified: true,
    counts: { searched: report.searched_message_count, fetched: report.fetched_message_count,
      inserted: report.inserted_count, duplicate: report.duplicate_count, excluded: report.ignored_count, failed: report.failure_count },
    artifacts: [raw, payload, ids].map((file) => ({ root: 'card', file })),
  };
}

export async function executeAmazon({ step, paths, ranges, today, idsOnly = false }) {
  const staging = path.join(paths.amazonRoot, 'data', 'gmail-staging', 'amazon');
  mkdirSync(staging, { recursive: true });
  const out = path.join(staging, today, `run-${randomUUID()}`);
  mkdirSync(out, { recursive: true });
  const rangeStart = (type) => jstDayStartSeconds(ranges[type]?.from ?? today) - 1;
  const dates = { typeA: rangeStart('type_a'), typeB: rangeStart('type_b') };
  const fetched = await step('amazon', 'gmail-fetch-local.mjs', [
    '--type-a-after', String(dates.typeA), '--type-b-after', String(dates.typeB),
    '--auth-file', paths.authFile, '--out', out, '--ingest-status', ...(idsOnly ? ['--ids-only'] : []),
  ]);
  if (!fetched.treeStopped || fetched.exitCode === 3) return failed(fetched);
  if (existsSync(path.join(out, 'parse-failures.json'))) return { outcome: 'permanent', code: 'parse' };
  if (fetched.exitCode !== 0 || fetched.failure) return failed(fetched);
  if (fetched.result?.ok !== true || fetched.result.ids_only !== idsOnly) throw new VerificationError();
  if (idsOnly) return { outcome: 'success', counts: { searched: fetched.result.typeA?.id_count + fetched.result.typeB?.id_count } };

  const candidatesFile = verifiedFile(out, path.join(out, 'candidates.json'));
  const candidates = readJson(candidatesFile);
  const messageFiles = [];
  const sources = {};
  for (const [type, after] of Object.entries(dates)) {
    const idsFile = verifiedFile(out, path.join(out, `${type}-ids.json`));
    const messagesFile = path.join(out, `${type}-messages.jsonl`);
    const ids = readJson(idsFile);
    const messages = existsSync(messagesFile) ? readJsonLines(verifiedFile(out, messagesFile)) : [];
    sources[type] = { after, ids, messages };
    messageFiles.push(idsFile);
    if (existsSync(messagesFile)) messageFiles.push(messagesFile);
  }
  verifyAmazonSource(candidates, sources);
  const before = readFileSync(paths.ordersCsv, 'utf8');
  const proofs = path.join(staging, 'verified-summary-rows.json');
  const proof = existsSync(proofs) ? readJson(verifiedFile(staging, proofs)) : [];
  if (!Array.isArray(proof) || !proof.every((value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) throw new VerificationError();
  const expected = expectAmazonRows(before, candidates, proof);
  const isolated = path.join(out, 'isolated.json');
  const applied = await step('amazon', 'gmail-import-run.mjs', [
    '--candidates-file', candidatesFile, '--isolated-out', isolated, ...(proof.length ? ['--summary-proof', proofs] : []),
  ]);
  if (applied.exitCode !== 0 || applied.failure) return failed(applied);
  const stats = applied.result;
  if (stats?.isolated_file !== isolated) throw new VerificationError();
  verifyAmazonApplied({ expected, csvBefore: before, csvAfter: readFileSync(paths.ordersCsv, 'utf8'),
    backup: readFileSync(verifiedFile(path.join(paths.amazonRoot, 'backups', 'orders'), stats.backup?.path ?? ''), 'utf8'),
    isolation: readJson(verifiedFile(out, isolated)), stats, candidateCount: candidates.rows.length });
  const counts = { candidates: candidates.rows.length, inserted: expected.appended,
    duplicate: expected.outcome.duplicate, excluded: expected.outcome.excluded + expected.outcome.pending, isolated: expected.outcome.isolated };
  if (expected.outcome.pending) return { outcome: 'permanent', code: 'verify_mismatch', counts };
  return { outcome: 'success', verified: true, counts,
    artifacts: [candidatesFile, isolated, ...messageFiles].map((file) => ({ root: 'amazon', file })) };
}
