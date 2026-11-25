import { execFile, spawn } from 'node:child_process';
import path from 'node:path';

const STEP_TIMEOUT_MS = 30 * 60 * 1000;
const STOP_TIMEOUT_MS = 15_000;
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;

function isGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

async function stopTree(child, env) {
  if (!child.pid) return true;
  if (child.exitCode !== null || child.signalCode !== null) return false;

  const systemRoot = env.SystemRoot ?? '';
  if (process.platform !== 'win32' || !path.isAbsolute(systemRoot)) {
    child.kill();
    return false;
  }

  const taskkill = path.join(systemRoot, 'System32', 'taskkill.exe');
  const stopped = await new Promise((resolve) => {
    execFile(taskkill, ['/pid', String(child.pid), '/t', '/f'], {
      env,
      windowsHide: true,
      timeout: STOP_TIMEOUT_MS,
    }, (error) => resolve(!error));
  });
  return stopped && isGone(child.pid);
}

export function runNodeStep({ entry, args = [], cwd, env, timeoutMs = STEP_TIMEOUT_MS, onSpawn }) {
  if (!path.isAbsolute(entry) || !path.isAbsolute(cwd) || !env ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > STEP_TIMEOUT_MS) {
    throw new TypeError('INVALID_CHILD_CONFIGURATION');
  }

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd,
      env,
      shell: false,
      detached: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    let size = 0;
    let spawnError = false;
    let stopping = false;

    function finish(exitCode, result, failure, treeStopped) {
      clearTimeout(timer);
      resolve({ exitCode, result, failure, treeStopped });
    }

    async function stop(failure) {
      if (stopping) return;
      stopping = true;
      const treeStopped = await stopTree(child, env).catch(() => false);
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      finish(child.exitCode, null, failure, treeStopped);
    }

    const timer = setTimeout(() => void stop('timeout'), timeoutMs);
    child.on('spawn', () => {
      try {
        // The caller records the PID in its lock before awaiting the result.
        onSpawn?.(child.pid);
      } catch {
        void stop('lock');
      }
    });
    child.on('error', () => { spawnError = true; });
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_STDOUT_BYTES) stdout.push(chunk);
    });
    child.stderr.resume();
    child.on('close', (exitCode) => {
      if (stopping) return;
      if (spawnError) return finish(exitCode, null, 'spawn', !child.pid);

      let result = null;
      if (size <= MAX_STDOUT_BYTES) {
        try {
          const parsed = JSON.parse(Buffer.concat(stdout).toString('utf8'));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) result = parsed;
        } catch {
          // A truncated or decorated stdout cannot prove a successful write.
        }
      }
      finish(exitCode, result, result ? null : 'invalid_stdout', true);
    });
  });
}
