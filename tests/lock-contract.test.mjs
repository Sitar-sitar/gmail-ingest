import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// 修正設計書_Gmail取り込み実装レビュー反映_Phase1_2026-11-26.md §5.3 / §5.3-1
// ロック本体は3リポジトリへ複製されている。片側だけを変えた配備を検出する。
// 期待値を更新するときは3リポジトリの対象コミットを同じリリース作業で揃える。

const START = '// Keep the on-disk contract identical in direct import entry points.';
const EXPECTED_SHA256 = '992f0a21709e1bee3348f442faf7861072788800ddbffa94ef50ba3e3707500f';
const EXPECTED_BYTES = 5115;

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, '..', 'lib', 'lock.mjs');

export function extractLockContract(text) {
  const normalized = text.replace(/\r\n/g, '\n');
  const start = normalized.indexOf(START);
  assert.notEqual(start, -1, 'ロック契約の開始行が見つからない');
  assert.equal(normalized.indexOf(START, start + START.length), -1, 'ロック契約の開始行が重複している');
  // ランナーは契約がファイル末尾まで続く。
  return `${normalized.slice(start).replace(/\n+$/, '')}\n`;
}

test('the shared lock contract matches the released hash and length', () => {
  const body = Buffer.from(extractLockContract(readFileSync(target, 'utf8')), 'utf8');
  assert.equal(body.length, EXPECTED_BYTES);
  assert.equal(createHash('sha256').update(body).digest('hex'), EXPECTED_SHA256);
});

test('a single edited copy fails the contract', () => {
  const edited = readFileSync(target, 'utf8').replace('pending_human_review', 'pending_review');
  const body = Buffer.from(extractLockContract(edited), 'utf8');
  assert.notEqual(createHash('sha256').update(body).digest('hex'), EXPECTED_SHA256);
});

test('a missing or duplicated start marker is a failure', () => {
  assert.throws(() => extractLockContract('export const a = 1;\n'));
  assert.throws(() => extractLockContract(`${START}\n${START}\n`));
});
