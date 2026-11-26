#!/usr/bin/env node
// 週次実行の読み取り専用診断。CLAUDE.md §7 に従い、Gmail API・取得・適用・状態更新・失敗解除・削除は一切起動しない。
// 読む対象は logs/<YYYY-MM-DD>.json、logs/summary.json、state/last-run.json、amazon-tracker の対応表のみ。
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const AMAZON_ORIGIN = path.resolve(ROOT, '..', 'amazon-tracker', 'data', 'gmail-origin.json');
const TARGETS = [
  ['amazon', 'type_a'],
  ['amazon', 'type_b'],
  ['credit_card', 'smbc'],
  ['credit_card', 'rakuten_card'],
  ['credit_card', 'jcb_ekenet'],
];

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function readJson(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined; // 壊れている場合は異常として扱う。
  }
}

function dayKeys(sinceDays) {
  const keys = [];
  const now = Date.now();
  for (let i = 0; i <= sinceDays; i += 1) {
    keys.push(new Date(now - i * 86400000).toISOString().slice(0, 10));
  }
  return keys;
}

function collectRuns(sinceDays) {
  const runs = [];
  for (const day of dayKeys(sinceDays)) {
    const value = readJson(path.join(ROOT, 'logs', `${day}.json`));
    if (value === undefined) {
      runs.push({ day, broken: true });
      continue;
    }
    if (!Array.isArray(value)) continue;
    for (const run of value) if (run && typeof run === 'object') runs.push({ day, ...run });
  }
  return runs;
}

// 対象実行＝取得対象の枠を持つ実行。枠が無い実行は認証確認だけの起動なので受入判定から外す。
function pickSlotRun(runs) {
  const slotted = runs.filter((run) => typeof run.slot === 'string' && run.slot);
  if (!slotted.length) return null;
  return slotted.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at))).at(-1);
}

function targetLines(run, state, issues) {
  const lines = [];
  for (const [group, name] of TARGETS) {
    const stored = state?.[group]?.[name] ?? null;
    const entry = (run?.entries ?? []).find((item) => item?.step === 'verify' && item?.provider === name) ?? null;
    const outcome = entry?.outcome ?? '(実行なし)';
    const counts = entry?.counts ? Object.entries(entry.counts).map(([key, value]) => `${key}=${value}`).join(' ') : '-';
    lines.push(`  ${group}/${name}: 実行=${outcome} 確認済み=${stored?.confirmed_through ?? '-'}`
      + ` 前回結果=${stored?.last_outcome ?? '-'} 件数 ${counts}`);
    if (!stored) issues.push(`状態に ${group}/${name} が無い`);
    else if (stored.last_outcome !== 'success') issues.push(`${group}/${name} の前回結果が ${stored.last_outcome}`);
    if (entry && entry.outcome !== 'success') issues.push(`${group}/${name} の実行結果が ${entry.outcome}`);
  }
  return lines;
}

function main() {
  const sinceDays = Number(arg('--since-days') ?? 7);
  const issues = [];
  const out = [];
  const runs = collectRuns(Number.isFinite(sinceDays) && sinceDays >= 0 ? sinceDays : 7);
  for (const run of runs) if (run.broken) issues.push(`日次ログ ${run.day}.json が読めない`);

  out.push(`# 週次実行の読み取り診断 ${new Date().toISOString()}`);
  out.push(`対象リポジトリ: ${ROOT}`);
  out.push(`参照した日次ログ: 直近 ${sinceDays} 日 / 実行記録 ${runs.filter((run) => !run.broken).length} 件`);

  const state = readJson(path.join(ROOT, 'state', 'last-run.json'));
  if (state === undefined || state === null) issues.push('state/last-run.json を読めない');

  const run = pickSlotRun(runs.filter((item) => !item.broken));
  out.push('');
  out.push('## 終了コードと枠');
  if (!run) {
    out.push('  枠を持つ実行が見つからない');
    issues.push('直近の日次ログに枠を持つ実行が無い');
  } else {
    out.push(`  実行 ${run.started_at} → ${run.finished_at} / 枠=${run.slot} / 終了コード=${run.exit_code}`);
    if (run.exit_code !== 0) issues.push(`実行の終了コードが ${run.exit_code}`);
  }
  const last = state?.last_run ?? null;
  if (last) {
    out.push(`  状態の枠: 試行=${last.attempted_slot ?? '-'} 完了=${last.completed_slot ?? '-'} 終了コード=${last.exit_code ?? '-'}`);
    if (last.exit_code !== 0) issues.push(`状態の終了コードが ${last.exit_code}`);
    // 設計 §4.6: 型単位のスキップが起きた枠は completed_slot が進まない。
    if (last.attempted_slot && last.attempted_slot !== last.completed_slot) {
      issues.push(`枠 ${last.attempted_slot} が未完了のまま（スキップ発生）`);
    }
  }

  out.push('');
  out.push(`## 対象5件（検出 ${TARGETS.length} 件）`);
  out.push(...targetLines(run, state, issues));

  out.push('');
  out.push('## Amazon 取得元対応表の照合');
  const origin = readJson(AMAZON_ORIGIN);
  if (origin === null) {
    out.push('  対応表が無い');
    issues.push('amazon-tracker の対応表が無い');
  } else if (origin === undefined || !Array.isArray(origin.entries)) {
    out.push('  対応表が読めない');
    issues.push('amazon-tracker の対応表が読めない');
  } else {
    const rows = origin.entries.reduce((sum, item) => sum + (Number(item?.count) || 0), 0);
    out.push(`  version=${origin.version ?? '-'} 更新=${origin.updated_at ?? '-'} 項目=${origin.entries.length} 行=${rows}`);
    const amazonVerified = (run?.entries ?? []).filter((item) => item?.job === 'amazon' && item?.step === 'verify');
    out.push(`  実行側の Amazon 検算: ${amazonVerified.length ? amazonVerified.map((item) => `${item.provider}=${item.outcome}`).join(' ') : '(実行なし)'}`);
  }

  const cleared = Array.isArray(state?.cleared_failures) ? state.cleared_failures : [];
  out.push('');
  out.push(`## 失敗解除の記録: ${cleared.length} 件`);

  out.push('');
  out.push(issues.length ? `## 要確認 ${issues.length} 件` : '## 要確認なし');
  for (const issue of issues) out.push(`  - ${issue}`);

  const text = `${out.join('\n')}\n`;
  process.stdout.write(text);
  const target = arg('--out');
  if (target) {
    const file = path.isAbsolute(target) ? target : path.join(ROOT, target);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text, 'utf8');
  }
  process.exitCode = issues.length ? 1 : 0;
}

main();
