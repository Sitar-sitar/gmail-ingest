import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';

// Keep the on-disk contract identical in direct import entry points.
const WAIT_WORD = new Int32Array(new SharedArrayBuffer(4));

function waitForFile(operation) {
  for (let attempt = 0; ; attempt++) {
    try { return operation(); }
    catch (error) {
      if (!['EACCES', 'EPERM', 'EBUSY'].includes(error.code) || attempt >= 40) throw error;
      Atomics.wait(WAIT_WORD, 0, 0, 25);
    }
  }
}

export class ImportLockError extends Error {
  constructor() {
    super('IMPORT_LOCKED');
    this.code = 'IMPORT_LOCKED';
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function readLock(file) {
  let record;
  try {
    record = JSON.parse(waitForFile(() => readFileSync(file, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new ImportLockError();
  }
  if (!record || !/^[a-f0-9-]{36}$/.test(record.owner_token) || record.host !== hostname() ||
      !Array.isArray(record.pids) || !record.pids.length ||
      !record.pids.every((pid) => Number.isSafeInteger(pid) && pid > 0) ||
      typeof record.pending_human_review !== 'boolean') {
    throw new ImportLockError();
  }
  return record;
}

function removeIfPresent(file) {
  try {
    waitForFile(() => unlinkSync(file));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function createLockFile(file, record) {
  const fd = openSync(file, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(record)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function changeLock(file, token, mutate) {
  // A single guard for the observed generation prevents a stale contender from
  // deleting a replacement generation or racing the registration of a child.
  const guard = `${file}.${token}.guard`;
  let fd;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      fd = openSync(guard, 'wx', 0o600);
      break;
    } catch (error) {
      if (!['EEXIST', 'EACCES', 'EPERM', 'EBUSY'].includes(error.code)) throw error;
      Atomics.wait(WAIT_WORD, 0, 0, 25);
    }
  }
  if (fd === undefined) throw new ImportLockError();
  const temporary = `${guard}.tmp`;
  try {
    const record = readLock(file);
    if (record?.owner_token !== token) throw new ImportLockError();
    const next = mutate(record);
    if (next === null) waitForFile(() => unlinkSync(file));
    if (next) {
      createLockFile(temporary, next);
      waitForFile(() => renameSync(temporary, file));
    }
  } finally {
    closeSync(fd);
    removeIfPresent(temporary);
    removeIfPresent(guard);
  }
}

export function acquireImportLock(file, entry) {
  mkdirSync(path.dirname(file), { recursive: true });
  const ownerToken = randomUUID();
  const record = {
    owner_token: ownerToken, pids: [process.pid], started_at: new Date().toISOString(),
    host: hostname(), entry, pending_human_review: false,
  };
  let recovered = false;
  try {
    createLockFile(file, record);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = readLock(file);
    if (existing) {
      changeLock(file, existing.owner_token, (current) => {
        if (current.pending_human_review || current.pids.some(alive)) throw new ImportLockError();
        return null;
      });
      recovered = true;
    }
    try {
      createLockFile(file, record);
    } catch (conflict) {
      if (conflict.code === 'EEXIST') throw new ImportLockError();
      throw conflict;
    }
  }

  return {
    ownerToken,
    recovered,
    addPid(pid) {
      changeLock(file, ownerToken, (current) => {
        if (current.pending_human_review) throw new ImportLockError();
        return { ...current, pids: [...new Set([...current.pids, pid])] };
      });
    },
    forgetPid(pid) {
      changeLock(file, ownerToken, (current) => ({ ...current, pids: current.pids.filter((value) => value !== pid || value === process.pid) }));
    },
    retainForReview() {
      changeLock(file, ownerToken, (current) => ({ ...current, pending_human_review: true }));
    },
    release() {
      changeLock(file, ownerToken, (current) => {
        if (current.pids[0] !== process.pid || current.pending_human_review ||
            current.pids.slice(1).some(alive)) throw new ImportLockError();
        return null;
      });
    },
  };
}

export function joinImportLock(file, entry, token = process.env.GMAIL_INGEST_LOCK_TOKEN) {
  const current = token ? readLock(file) : null;
  if (current?.owner_token !== token || !current) return acquireImportLock(file, entry);
  if (current.pending_human_review) throw new ImportLockError();
  if (!current.pids.includes(process.pid)) {
    changeLock(file, token, (record) => {
      if (record.pending_human_review || !record.pids.some(alive)) throw new ImportLockError();
      if (record.pids.includes(process.pid)) return undefined;
      return { ...record, pids: [...record.pids, process.pid] };
    });
  }
  // Leave the registered PID in the record until the process really exits.
  return { ownerToken: token, recovered: false, release() {} };
}
