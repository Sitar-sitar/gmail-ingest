import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { AMAZON_TYPES, CARD_PROVIDERS, ERROR_CODES, OUTCOMES, isDay, isTimestamp, jstDay, replaceJson } from './state.mjs';

const JOBS = ['credit-card', 'amazon', 'runner'];
const STEPS = ['prepare', 'auth', 'fetch', 'apply', 'verify', 'state', 'cleanup', 'restore', 'lock'];
const COUNTS = ['searched', 'fetched', 'candidates', 'inserted', 'duplicate', 'excluded', 'isolated', 'failed', 'removed', 'retained', 'gap_days'];
const CHECKS = ['output', 'account', 'coverage', 'sets', 'csv_columns', 'amounts', 'preserved', 'log', 'state_saved', 'stale_lock_recovered', 'changed', 'skipped', 'pending_lock'];

function count(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function select(record, allowed, valid) {
  return Object.fromEntries(allowed.filter((key) => valid(record?.[key])).map((key) => [key, record[key]]));
}

function safeEntry(entry) {
  const result = {
    ...select(entry, ['job'], (value) => JOBS.includes(value)),
    ...select(entry, ['step'], (value) => STEPS.includes(value)),
    ...select(entry, ['provider'], (value) => [...CARD_PROVIDERS, ...AMAZON_TYPES].includes(value)),
    ...select(entry, ['outcome'], (value) => OUTCOMES.includes(value)),
    ...select(entry, ['code'], (value) => ERROR_CODES.includes(value)),
    ...select(entry, ['confirmed_before', 'confirmed_after'], isDay),
    ...select(entry, ['exit_code', 'retries'], count),
    ...select(entry, ['http_status'], (value) => Number.isInteger(value) && value >= 100 && value <= 599),
    ...select(entry, ['failure_id'], (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)),
  };
  return { ...result, counts: select(entry?.counts, COUNTS, count), checks: select(entry?.checks, CHECKS, (value) => typeof value === 'boolean') };
}

function safeSummary(run) {
  return {
    ...select(run, ['started_at', 'finished_at'], isTimestamp),
    ...select(run, ['slot'], isDay),
    ...select(run, ['exit_code', 'duration_ms'], count),
    entries: Array.isArray(run.entries) ? run.entries.map(safeEntry) : [],
  };
}

export function saveLog(logDir, run) {
  const summary = safeSummary(run);
  if (!summary.finished_at) throw new Error('INVALID_LOG_TIME');
  mkdirSync(logDir, { recursive: true });
  const daily = path.join(logDir, `${jstDay(new Date(summary.finished_at))}.json`);
  let previous = [];
  try {
    const saved = JSON.parse(readFileSync(daily, 'utf8'));
    if (!Array.isArray(saved)) throw new Error('INVALID_LOG_HISTORY');
    previous = saved.map(safeSummary);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  replaceJson(daily, [...previous, summary]);
  replaceJson(path.join(logDir, 'summary.json'), summary);
  return summary;
}
