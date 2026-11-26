import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createHash as hashOf } from 'node:crypto';
import { rowKeys, verifyAmazonSource } from '../lib/verify.mjs';

// 修正設計書_Gmail取り込み実装レビュー反映_Phase1_2026-11-26.md §5.4 / §5.4-1
// amazon-tracker 側はパーサへ、こちらは照合器へ同じ合成メールを通す。
// 他リポジトリを import せず、同一バイトのフィクスチャで突き合わせる。

const EXPECTED_SHA256 = '894d11c5bae93189901a15787f9001f03b2450dc1cb03692065eec849cac483e';
const EXPECTED_BYTES = 6343;

const here = path.dirname(fileURLToPath(import.meta.url));
// 改行は LF に正規化してから照合する（Git の改行変換でハッシュが変わらないようにする）
const text = readFileSync(path.join(here, 'fixtures', 'amazon-mail-contract.json'), 'utf8').replace(/\r\n/g, '\n');
const raw = Buffer.from(text, 'utf8');
const fixture = JSON.parse(text);
const token = String(fixture.query_after).replaceAll('-', '/');
const queries = { typeA: `contract type a after:${token}`, typeB: `contract type b after:${token}` };
const ofType = (type) => fixture.messages.filter((message) => message.type === type);

function contract() {
  // 改変試験が元のフィクスチャを壊さないよう複製する。
  const rows = fixture.messages.flatMap((message) =>
    message.expected_rows.map((row) => ({ type: message.type, message_id: message.id, row: structuredClone(row) })));
  const candidates = {
    selected_types: ['typeA', 'typeB'],
    typeA_query: queries.typeA,
    typeB_query: queries.typeB,
    typeA_message_count: ofType('typeA').length,
    typeB_message_count: ofType('typeB').filter((message) => !message.preorder_excluded).length,
    typeB_fetched_message_count: ofType('typeB').length,
    excluded_typeB_preorder_messages: ofType('typeB').filter((message) => message.preorder_excluded).length,
    rows,
    parse_failures: [],
  };
  const sources = Object.fromEntries(['typeA', 'typeB'].map((type) => [type, {
    selected: true, after: fixture.query_after, messages: ofType(type),
    ids: { type, id_source: 'query', query: queries[type], message_ids: ofType(type).map(({ id }) => id) },
  }]));
  return { candidates, sources };
}

test('the shared mail fixture is byte identical across both repositories', () => {
  assert.equal(raw.length, EXPECTED_BYTES);
  assert.equal(createHash('sha256').update(raw).digest('hex'), EXPECTED_SHA256);
  assert.ok(fixture.messages.length >= 3);
});

test('the verifier accepts the rows the Amazon parser produces', () => {
  const { candidates, sources } = contract();
  verifyAmazonSource(candidates, sources, ['typeA', 'typeB']);
  assert.equal(candidates.excluded_typeB_preorder_messages, 1);
  assert.equal(candidates.rows.length, 4);
});

test('the verifier rejects altered quantities, amounts and preorder rows', () => {
  const quantity = contract();
  quantity.candidates.rows[0].row['Original Quantity'] = '3';
  assert.throws(() => verifyAmazonSource(quantity.candidates, quantity.sources, ['typeA', 'typeB']), /VERIFY_MISMATCH/);

  const amount = contract();
  const digital = amount.candidates.rows.find(({ type }) => type === 'typeB');
  digital.row['Total Amount'] = String(Number(digital.row['Total Amount']) + 1);
  assert.throws(() => verifyAmazonSource(amount.candidates, amount.sources, ['typeA', 'typeB']), /VERIFY_MISMATCH/);

  const unitPrice = contract();
  const item = unitPrice.candidates.rows.find(({ type }) => type === 'typeA');
  item.row['Unit Price'] = String(Number(item.row['Unit Price']) - 100);
  assert.throws(() => verifyAmazonSource(unitPrice.candidates, unitPrice.sources, ['typeA', 'typeB']), /VERIFY_MISMATCH/);

  const preorder = contract();
  const excluded = fixture.messages.find(({ preorder_excluded: value }) => value === true);
  preorder.candidates.rows.push({ type: 'typeB', message_id: excluded.id,
    row: { ...preorder.candidates.rows.at(-1).row, 'Order ID': 'D01-0000000-0000000' } });
  assert.throws(() => verifyAmazonSource(preorder.candidates, preorder.sources, ['typeA', 'typeB']), /VERIFY_MISMATCH/);
});

test('the verifier checks only the selected type and demands no artifacts for the other', () => {
  const { candidates, sources } = contract();
  const onlyB = { ...candidates, selected_types: ['typeB'],
    rows: candidates.rows.filter(({ type }) => type === 'typeB'),
    typeA_query: undefined, typeA_message_count: undefined };
  delete onlyB.typeA_query;
  delete onlyB.typeA_message_count;
  verifyAmazonSource(onlyB, { ...sources, typeA: { selected: false, files: [path.join(here, 'fixtures', 'absent-typeA-ids.json')] } }, ['typeB']);
  // 非選択型のキーが残っていれば不一致として扱う
  assert.throws(() => verifyAmazonSource({ ...onlyB, typeA_message_count: 1 },
    { ...sources, typeA: { selected: false, files: [] } }, ['typeB']), /VERIFY_MISMATCH/);
  // 非選択型の生成物が残っていれば不一致として扱う
  assert.throws(() => verifyAmazonSource(onlyB,
    { ...sources, typeA: { selected: false, files: [path.join(here, 'fixtures', 'amazon-mail-contract.json')] } }, ['typeB']), /VERIFY_MISMATCH/);
});

test('the identification key matches the mapping key the Amazon tool writes', () => {
  // 取得元識別 §5.2: key_sha256 は rowKeys(row).exact の UTF-8 文字列の SHA-256
  assert.equal(fixture.key_spec, 'rowkeys_exact_v1');
  for (const message of fixture.messages) {
    const hashes = message.expected_rows.map((row) =>
      hashOf('sha256').update(rowKeys(row).exact, 'utf8').digest('hex'));
    assert.deepEqual(hashes, message.expected_key_sha256, message.id);
  }
});
