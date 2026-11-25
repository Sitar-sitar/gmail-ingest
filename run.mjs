import { lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { approveCleanup, autoCleanup, createCleanupPlan, executeCleanup, retainVerifiedArtifacts } from './lib/cleanup.mjs';
import { assertUnredirected, buildChildEnv, resolveChildPaths } from './lib/env.mjs';
import { runNodeStep } from './lib/exec.mjs';
import { acquireImportLock, ImportLockError } from './lib/lock.mjs';
import { saveLog } from './lib/log.mjs';
import { createRestoreSet } from './lib/restore-set.mjs';
import { approveFailure, consumeFailureApproval, isBlocked, jstDay, latestSlot, loadState, recordTarget, saveState, targetState } from './lib/state.mjs';
import { VerificationError } from './lib/verify.mjs';
import { executeAmazon, executeCard, listJobs } from './jobs.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MINUTE = 60_000;
const HASH = /^[a-f0-9]{64}$/;

export function optionsFrom(args) {
  const { values, tokens } = parseArgs({ args, tokens: true, options: {
    job: { type: 'string' }, profile: { type: 'string' }, 'gap-only': { type: 'boolean' },
    'clear-failure': { type: 'string' }, 'register-account': { type: 'boolean' },
    'expected-account-fingerprint': { type: 'string' }, 'cleanup-plan': { type: 'boolean' },
    'enable-cleanup': { type: 'boolean' }, 'plan-id': { type: 'string' },
    'restore-set': { type: 'boolean' }, 'ids-only': { type: 'boolean' }, 'test-weekly': { type: 'boolean' },
    'include-legacy-state': { type: 'boolean' },
  } });
  if (new Set(tokens.map(({ name }) => name)).size !== tokens.length) throw new Error('INVALID_MODE');
  const { job, profile, 'gap-only': gapOnly, 'clear-failure': clearFailure, 'plan-id': planId,
    'expected-account-fingerprint': expectedFingerprint, 'ids-only': idsOnly, 'test-weekly': testWeekly,
    'include-legacy-state': includeLegacy } = values;
  const modes = [clearFailure && 'clear', values['register-account'] && 'account', values['cleanup-plan'] && 'plan',
    values['enable-cleanup'] && 'approve', values['restore-set'] && 'restore', planId && !values['enable-cleanup'] && 'cleanup'].filter(Boolean);
  const mode = modes[0] ?? 'import';
  if (modes.length > 1 || (job && !['amazon', 'credit-card'].includes(job)) ||
      (mode === 'clear' && (!job || !HASH.test(clearFailure))) ||
      (mode !== 'import' && mode !== 'clear' && job) ||
      (mode !== 'import' && (idsOnly || gapOnly)) || (idsOnly && (job !== 'amazon' || gapOnly)) ||
      (mode === 'account' ? !HASH.test(expectedFingerprint ?? '') : Boolean(expectedFingerprint)) ||
      ((mode === 'approve' || mode === 'cleanup') && !HASH.test(planId ?? '')) ||
      (testWeekly && (!profile || mode !== 'import' || job || gapOnly || idsOnly)) ||
      (includeLegacy && mode !== 'restore')) throw new Error('INVALID_MODE');
  return { mode, job, profile, gapOnly, clearFailure, expectedFingerprint, idsOnly, planId, testWeekly, includeLegacy };
}

function underneath(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function layout(options) {
  const production = path.dirname(ROOT);
  let base = production;
  if (options.profile) {
    base = assertUnredirected(path.resolve(options.profile));
    if (underneath(base, production) || !lstatSync(base).isDirectory() ||
        ['amazon-tracker', 'credit-card-tracker', 'gmail-ingest/state', 'gmail-ingest/data', 'gmail-ingest/logs']
          .some((name) => underneath(path.join(production, name), base))) throw new Error('OUTPUT_MISMATCH');
  }
  const runner = options.profile ? path.join(base, 'gmail-ingest') : ROOT;
  const amazon = path.join(base, 'amazon-tracker');
  const card = path.join(base, 'credit-card-tracker');
  const stateDir = path.join(runner, 'state');
  const logDir = path.join(runner, 'logs');
  return { roots: { runner, amazon, card }, stateDir, logDir, stateFile: path.join(stateDir, 'last-run.json'),
    lockFiles: { runner: path.join(stateDir, '.lock'), amazon: path.join(amazon, 'data', '.import.lock'),
      'credit-card': path.join(card, 'data', '.import.lock') } };
}

function validateOutputs(config, checkAuth) {
  const { roots, stateDir, logDir, lockFiles, stateFile } = config;
  for (const output of [stateDir, stateFile, logDir, path.join(roots.runner, 'data', 'gmail-auth'),
    ...Object.values(lockFiles), path.join(stateDir, 'restore-sets'), path.join(stateDir, 'cleanup-plans'),
    path.join(stateDir, 'verified-artifacts.json'), path.join(stateDir, 'auto-cleanup-enabled'), path.join(stateDir, 'cleanup-enabled'),
    path.join(roots.amazon, 'backups', 'orders'), path.join(roots.amazon, 'data', 'gmail-staging', 'amazon'),
    path.join(roots.card, 'data', 'gmail-staging'), path.join(roots.card, 'data', 'credit-card.db-wal'),
    path.join(roots.card, 'data', 'credit-card.db-shm'), path.join(roots.card, 'quarantine', 'gmail-import'),
    path.join(roots.card, 'logs', 'gmail-import')]) assertUnredirected(output);
  return resolveChildPaths({ amazonRoot: roots.amazon, cardRoot: roots.card, checkAuth,
    authFile: path.join(roots.runner, 'data', 'gmail-auth', 'oauth.json') });
}

function classifyExit(result) {
  if (result.pending || result.locked) return 3;
  if (['transient', 'permanent', 'partial', 'not_run'].includes(result.outcome)) return 2;
  return result.outcome === 'gap_pending' ? 6 : 0;
}

function legacyFiles(roots) {
  const logDir = assertUnredirected(path.join(roots.card, 'logs', 'gmail-import'));
  const card = readdirSync(logDir).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)).sort().slice(-3);
  if (!card.length) throw new Error('LEGACY_STATE_MISSING');
  return [['legacy-amazon.md', assertUnredirected(path.join(roots.amazon, 'gmail-import-rules.md'))],
    ...card.map((name, index) => [`legacy-card-${index + 1}.md`, assertUnredirected(path.join(logDir, name))])];
}

export async function run(args, { now = () => new Date(), spawnStep = runNodeStep, wait = sleep, uptime = () => performance.now() } = {}) {
  let options;
  try { options = optionsFrom(args); } catch { return { exitCode: 1, code: 'invalid_mode' }; }
  let config;
  try { config = layout(options); } catch { return { exitCode: 4, code: 'output_mismatch' }; }
  const start = now();
  const today = jstDay(start);
  const normal = options.mode === 'import' && !options.job && (!options.profile || options.testWeekly) && !options.gapOnly;
  const slot = normal ? latestSlot(start) : '';
  const entries = [];
  const leases = new Map();
  const retained = new Set();
  const runDeadline = uptime() + 90 * MINUTE;
  let exitCode = 0;
  let data;
  let paths;

  function acquire(job) {
    const lease = acquireImportLock(config.lockFiles[job], job);
    leases.set(job, lease);
    if (lease.recovered) entries.push({ job, step: 'lock', checks: { stale_lock_recovered: true } });
  }

  function release(job) {
    const lease = leases.get(job);
    if (lease && !retained.has(job)) lease.release();
    leases.delete(job);
  }

  function retain(job) {
    for (const key of new Set([job, 'runner'])) {
      if (!leases.has(key) || retained.has(key)) continue;
      retained.add(key);
      leases.get(key).retainForReview();
      entries.push({ job: key, step: 'lock', checks: { pending_lock: true } });
    }
  }

  function stepFor(jobDeadline) {
    return async (job, script, argv) => {
      const remaining = Math.floor(Math.min(runDeadline, jobDeadline) - uptime());
      if (remaining <= 0) return { exitCode: null, treeStopped: true, failure: 'timeout' };
      const cwd = job === 'amazon' ? paths.amazonRoot : paths.cardRoot;
      const lease = leases.get(job);
      let childPid;
      const result = await spawnStep({ cwd, entry: assertUnredirected(path.join(cwd, 'tools', script)), args: argv,
        env: buildChildEnv(paths, { lockToken: lease?.ownerToken }), timeoutMs: Math.min(30 * MINUTE, remaining),
        onSpawn(pid) { childPid = pid; lease?.addPid(pid); leases.get('runner').addPid(pid); } });
      if (!result.treeStopped) retain(job);
      else if (childPid) { lease?.forgetPid(childPid); leases.get('runner').forgetPid(childPid); }
      if (!argv.includes('--check-auth')) entries.push({ job, step: script === 'gmail-fetch-local.mjs' ? 'fetch' : 'apply',
        exit_code: result.exitCode, code: result.failure === 'lock' || result.exitCode === 3 ? 'lock' : undefined });
      return result;
    };
  }

  async function perform() {
    const checksAuth = options.mode === 'import' || options.mode === 'account';
    try { paths = validateOutputs(config, false); }
    catch { entries.push({ job: 'runner', step: 'prepare', code: 'output_mismatch' }); return 4; }
    acquire('runner');
    const { stateFile, stateDir, roots } = config;
    if (options.mode === 'plan') {
      data = createCleanupPlan(stateDir, roots, start);
      return 0;
    }
    if (options.mode === 'approve') {
      approveCleanup(stateDir, options.planId, start);
      return 0;
    }
    if (options.mode === 'cleanup' || options.mode === 'restore') {
      acquire('amazon');
      acquire('credit-card');
      data = options.mode === 'cleanup' ? executeCleanup(stateDir, roots, options.planId, start)
        : await createRestoreSet({ ...paths, stateDir, stateFile, at: start, lockHeld: { amazon: true, card: true },
          legacyFiles: options.includeLegacy ? legacyFiles(roots) : [] });
      return 0;
    }
    const state = loadState(stateFile);
    if (options.mode === 'clear') {
      approveFailure(state, options.job, options.clearFailure, start);
      saveState(stateFile, state);
      return 0;
    }
    if (slot && state.last_run.completed_slot >= slot) return 0;

    const jobs = listJobs(state, options, today).filter(({ ranges }) => Object.values(ranges).some(Boolean) || options.idsOnly);
    const available = jobs.filter(({ job, targets }) => {
      const blocked = targets.filter((provider) => isBlocked(state, job, provider));
      for (const provider of blocked) entries.push({ job, provider, step: 'prepare', outcome: 'permanent',
        failure_id: targetState(state, job, provider).failure.failure_id, checks: { skipped: true } });
      return options.idsOnly || blocked.length === 0;
    });
    if (options.mode === 'import' && jobs.length && !available.length) return 5;
    if (options.mode === 'import' && !available.length) return 0;
    if (options.mode === 'import' && !options.idsOnly) {
      for (const job of new Set(available.map((item) => item.job))) acquire(job);
    }
    if (checksAuth) {
      try { paths = validateOutputs(config, true); }
      catch { entries.push({ job: 'runner', step: 'auth', code: 'auth' }); return 4; }
      const auth = await stepFor(runDeadline)('amazon', 'gmail-fetch-local.mjs', ['--check-auth', '--auth-file', paths.authFile]);
      if (!auth.treeStopped) return 3;
      const fingerprint = auth.result?.account_fingerprint;
      if (auth.exitCode !== 0 || auth.failure || auth.result?.gmail_profile_ok !== true || typeof fingerprint !== 'string' ||
          !HASH.test(fingerprint) || fingerprint !== (options.expectedFingerprint ?? state.account_fingerprint)) {
        entries.push({ job: 'runner', step: 'auth', code: 'auth', checks: { account: false } });
        return 4;
      }
      entries.push({ job: 'runner', step: 'auth', checks: { account: true, output: true } });
      if (options.mode === 'account') {
        state.account_fingerprint = fingerprint;
        saveState(stateFile, state);
        return 0;
      }
    }

    const deadlines = new Map();
    let resultCode = 0;
    for (const spec of available) {
      const { job, targets, ranges } = spec;
      if (!deadlines.has(job)) deadlines.set(job, uptime() + 45 * MINUTE);
      const deadline = Math.min(runDeadline, deadlines.get(job));
      const pending = targets.filter((provider) => ranges[provider]);
      for (const provider of pending) {
        if (consumeFailureApproval(state, job, provider)) saveState(stateFile, state);
      }
      const execute = job === 'amazon' ? executeAmazon : executeCard;
      let result;
      let retries = 0;
      for (const delay of [60_000, 300_000, null]) {
        try {
          result = await execute({ paths, step: stepFor(deadline), ranges, today, idsOnly: options.idsOnly,
            provider: targets[0], range: ranges[targets[0]], state });
        } catch (error) {
          if (error instanceof ImportLockError || retained.size) result = { outcome: 'not_run', locked: true, code: 'lock' };
          else if (error instanceof VerificationError || error instanceof SyntaxError || error.code === 'ENOENT') {
            result = { outcome: 'permanent', code: 'verify_mismatch' };
          } else throw error;
        }
        if (result.outcome !== 'transient' || result.pending || delay === null || uptime() + delay >= deadline) break;
        release(job);
        await wait(delay);
        if (!options.idsOnly) acquire(job);
        retries++;
      }
      const code = classifyExit(result);
      const combinedAmazon = job === 'amazon' && !options.idsOnly;
      for (const provider of options.idsOnly ? [] : pending) {
        const prior = targetState(state, job, provider).confirmed_through;
        if (code !== 3) {
          recordTarget(state, job, provider, { outcome: result.outcome, code: result.code, range: ranges[provider],
            verifiedThrough: result.verified ? ranges[provider].to : '', at: start });
        }
        const next = targetState(state, job, provider);
        entries.push({ job, provider, step: 'verify', retries, outcome: result.outcome, code: result.code,
          http_status: result.httpStatus, failure_id: next.failure?.failure_id,
          confirmed_before: prior, confirmed_after: next.confirmed_through, counts: combinedAmazon ? undefined : result.counts });
      }
      if (options.idsOnly || (combinedAmazon && result.counts)) {
        entries.push({ job, step: options.idsOnly ? 'fetch' : 'verify', retries,
          outcome: result.outcome, code: result.code, counts: result.counts });
      }
      if (code === 3) return 3;
      if (!options.idsOnly) {
        saveState(stateFile, state);
        if (result.verified && result.artifacts?.length) retainVerifiedArtifacts(stateDir, roots, result.artifacts, start);
      }
      if (code === 2 || (code === 6 && resultCode === 0)) resultCode = code;
    }
    if (!options.idsOnly) {
      if (slot) {
        const completed = resultCode === 0 && available.length === jobs.length ? slot : state.last_run.completed_slot;
        state.last_run = { started_at: start.toISOString(), finished_at: now().toISOString(),
          exit_code: resultCode, attempted_slot: slot, completed_slot: completed };
        saveState(stateFile, state);
      }
      const eligibleRoots = ['runner', ...(leases.has('amazon') ? ['amazon'] : []), ...(leases.has('credit-card') ? ['card'] : [])];
      const counts = autoCleanup(stateDir, roots, now(), eligibleRoots);
      entries.push({ job: 'runner', step: 'cleanup', counts });
    }
    return resultCode;
  }

  try { exitCode = await perform(); }
  catch (error) {
    exitCode = error instanceof ImportLockError || retained.size ? 3 : 1;
    entries.push({ job: 'runner', step: exitCode === 3 ? 'lock' : 'state', code: exitCode === 3 ? 'lock' : 'unknown' });
  } finally {
    for (const job of ['credit-card', 'amazon']) {
      try { release(job); } catch { exitCode = 3; }
    }
    if (leases.has('runner')) {
      const finish = now();
      try {
        assertUnredirected(path.join(config.logDir, 'summary.json'));
        assertUnredirected(path.join(config.logDir, `${jstDay(finish)}.json`));
        const dailyFile = path.join(config.logDir, `${jstDay(finish)}.json`);
        saveLog(config.logDir, { started_at: start.toISOString(), finished_at: finish.toISOString(),
          duration_ms: Math.max(0, finish - start), exit_code: exitCode, slot, entries });
        if (!options.idsOnly && lstatSync(config.stateFile, { throwIfNoEntry: false })?.isFile() && options.mode === 'import') {
          retainVerifiedArtifacts(config.stateDir, config.roots, [{ root: 'runner', file: dailyFile }], finish);
        }
      } catch { if (exitCode === 0) exitCode = 1; }
      try { release('runner'); } catch { exitCode = 3; }
    }
  }
  return { exitCode, ...(data ? { data } : {}) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await run(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.exitCode;
}
