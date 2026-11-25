import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

export const CARD_PROVIDERS = Object.freeze(['smbc', 'rakuten_card', 'jcb_ekenet']);
export const AMAZON_TYPES = Object.freeze(['type_a', 'type_b']);
export const OUTCOMES = Object.freeze(['success', 'gap_pending', 'partial', 'transient', 'permanent', 'not_run']);
export const ERROR_CODES = Object.freeze([
  'auth', 'network', 'rate_limit', 'parse', 'validation', 'verify_mismatch',
  'output_mismatch', 'timeout', 'lock', 'unknown',
]);

const DAY = 86_400_000;
const JST_OFFSET = 9 * 3_600_000;
const SHA256 = /^[a-f0-9]{64}$/;

export function isDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
}

export function isTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const at = Date.parse(value);
  return Number.isFinite(at) && new Date(at).toISOString() === value;
}

export function offsetDay(day, offset) {
  if (!isDay(day)) throw new Error('INVALID_DAY');
  return new Date(Date.parse(day) + offset * DAY).toISOString().slice(0, 10);
}

export function jstDay(at) {
  return new Date(at.valueOf() + JST_OFFSET).toISOString().slice(0, 10);
}

export function jstDayStartSeconds(day) {
  if (!isDay(day)) throw new Error('INVALID_DAY');
  return (Date.parse(day) - JST_OFFSET) / 1000;
}

export function latestSlot(at) {
  const jst = new Date(at.valueOf() + JST_OFFSET);
  const daysSinceSunday = jst.getUTCDay();
  const shift = daysSinceSunday === 0 && jst.getUTCHours() < 22 ? 7 : daysSinceSunday;
  return offsetDay(jst.toISOString().slice(0, 10), -shift);
}

export function cardRange(confirmedThrough, businessFrom, today, gapOnly = false, unfinishedRecovery = false) {
  const from = confirmedThrough ? offsetDay(confirmedThrough, 1) : businessFrom;
  const cutoff = offsetDay(today, -1);
  if (from > cutoff) return null;
  const needsRecovery = unfinishedRecovery || !confirmedThrough || from < offsetDay(today, -45);
  if (gapOnly && !needsRecovery) return null;
  const to = [offsetDay(from, 44), cutoff].sort()[0];
  return { from, to, recovery: needsRecovery, hasMore: to < cutoff };
}

function validRange(range) {
  return isDay(range?.from) && isDay(range?.to) && range.from <= range.to;
}

function validFailure(failure) {
  return Boolean(failure && SHA256.test(failure.failure_id) && ERROR_CODES.includes(failure.code) &&
    validRange(failure.range));
}

function validTarget(target) {
  return Boolean(target && (!target.confirmed_through ? target.confirmed_through === '' : isDay(target.confirmed_through)) &&
    (target.last_success === '' || isTimestamp(target.last_success)) &&
    (target.last_outcome === '' || OUTCOMES.includes(target.last_outcome)) &&
    (target.last_outcome !== 'permanent' || validFailure(target.failure)) &&
    (target.failure === undefined || (target.last_outcome === 'permanent' && validFailure(target.failure))));
}

function validApproval(approval) {
  return Boolean(approval && SHA256.test(approval.failure_id) &&
    ((approval.job === 'amazon' && AMAZON_TYPES.includes(approval.provider)) ||
      (approval.job === 'credit-card' && CARD_PROVIDERS.includes(approval.provider))) &&
    validRange(approval.range) && isTimestamp(approval.cleared_at));
}

export function validateState(state) {
  const run = state?.last_run;
  if (!state || state.schema_version !== 2 ||
      (state.account_fingerprint !== '' && !SHA256.test(state.account_fingerprint)) ||
      !isDay(state.business_from) ||
      !AMAZON_TYPES.every((key) => validTarget(state.amazon?.[key])) ||
      !CARD_PROVIDERS.every((key) => validTarget(state.credit_card?.[key])) || !run ||
      ![run.started_at, run.finished_at].every((value) => value === '' || isTimestamp(value)) ||
      ![run.attempted_slot, run.completed_slot].every((value) => value === '' || isDay(value)) ||
      ![null, 0, 1, 2, 3, 4, 5, 6].includes(run.exit_code) ||
      !Array.isArray(state.cleared_failures) || !state.cleared_failures.every(validApproval)) {
    throw new Error('INVALID_STATE');
  }
  return state;
}

export function loadState(file) {
  try {
    return validateState(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    throw new Error('INVALID_STATE');
  }
}

export function replaceJson(file, value, verify) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    verify?.(JSON.parse(readFileSync(temporary, 'utf8')));
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export function saveState(file, state) {
  validateState(state);
  replaceJson(file, state, validateState);
}

export function targetState(state, job, provider) {
  return job === 'amazon' ? state.amazon[provider] : state.credit_card[provider];
}

export function recordTarget(state, job, provider, { outcome, code, range, verifiedThrough = '', at }) {
  const target = targetState(state, job, provider);
  if (verifiedThrough) {
    const expectedFrom = target.confirmed_through ? offsetDay(target.confirmed_through, 1) : state.business_from;
    if (!['success', 'gap_pending'].includes(outcome) || !validRange(range) || !isDay(verifiedThrough) ||
        range.from > expectedFrom || verifiedThrough < expectedFrom || verifiedThrough > range.to ||
        verifiedThrough >= jstDay(at)) throw new Error('NONCONTIGUOUS_RANGE');
    target.confirmed_through = verifiedThrough;
  }
  target.last_outcome = outcome;
  if (outcome === 'success') target.last_success = at.toISOString();
  delete target.failure;
  if (outcome === 'permanent') {
    const failureId = createHash('sha256').update(JSON.stringify([job, provider, code, range, at.toISOString()])).digest('hex');
    target.failure = { failure_id: failureId, code, range };
  }
}

function approvalIndex(state, job, provider, failure) {
  if (!failure) return -1;
  return state.cleared_failures.findIndex((approval) =>
    approval.job === job && approval.provider === provider && approval.failure_id === failure.failure_id &&
    approval.range.from === failure.range.from && approval.range.to === failure.range.to);
}

export function isBlocked(state, job, provider) {
  const { failure, last_outcome: outcome } = targetState(state, job, provider);
  return outcome === 'permanent' && approvalIndex(state, job, provider, failure) < 0;
}

export function approveFailure(state, job, failureId, at) {
  const providers = job === 'amazon' ? AMAZON_TYPES : CARD_PROVIDERS;
  const provider = providers.find((key) => targetState(state, job, key).failure?.failure_id === failureId);
  if (!provider) throw new Error('FAILURE_NOT_FOUND');
  const { failure } = targetState(state, job, provider);
  if (approvalIndex(state, job, provider, failure) < 0) {
    state.cleared_failures.push({
      failure_id: failureId, job, provider, range: failure.range, cleared_at: at.toISOString(),
    });
  }
}

export function consumeFailureApproval(state, job, provider) {
  const index = approvalIndex(state, job, provider, targetState(state, job, provider).failure);
  if (index < 0) return false;
  state.cleared_failures.splice(index, 1);
  return true;
}
