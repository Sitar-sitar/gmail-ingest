# gmail-ingest

Amazon とクレジットカードの Gmail 取り込みを Windows タスクスケジューラから順に実行する CLI です。ランナーの追加依存とポート予約は不要です。運用環境は Node.js 24 とし、カード側には既存 CLI の依存環境が必要です。

Phase 1 の進捗は [実装ログ](docs/実装ログ.md)、実行・切替・復元の仕様は [Phase 1 設計書](docs/修正設計書_Gmail取り込み非AI一本化_Phase1_2026-11-25.md) を参照してください。

## 実行と診断

| 操作 | コマンド |
|---|---|
| 通常実行 | `node run.mjs` |
| 対象を限定 | `node run.mjs --job amazon` または `node run.mjs --job credit-card` |
| 未回収区間を処理 | `node run.mjs --gap-only`。必要に応じて `--job` を併用する |
| Amazon の検索件数だけ確認 | `node run.mjs --job amazon --ids-only` |
| 確定失敗を確認後に一回解除 | `node run.mjs --clear-failure <failure_id> --job <job>` |
| 復元セット作成 | `node run.mjs --restore-set` |

手動の取得を行う場合は人が端末で起動する。AI や自動化の診断は `logs/summary.json` と定常ログの件数・分類・時刻を参照する。状態の正本は `state/last-run.json`。業務データや認証ファイル、取得成果物、削除計画、復元セットには個人データが入り得るためローカルに保管する。

終了コードは `0` 成功または枠完了済み、`1` 設定・状態・実行エラー、`2` 一部または全部の失敗、`3` 排他・プロセス停止確認待ち、`4` 認証・アカウント・出力先の照合失敗、`5` 全対象が確定失敗の解除待ち、`6` 欠落回収の残り。`3` で `pending_lock` がある場合はスケジュールを止め、対象の親・子プロセスの不在と業務データの整合性を確認してから管理者が該当ロックを退避する。

両アプリの直接起動とランナーは同じロック形式を使う。アプリの単独起動を保つため、それぞれの既存 CLI にロック処理を置いている。ロック形式を修正する場合は、両アプリとランナーを同じ変更で検証する。

Type B の旧サマリに見える行は保留される。独立した取得元の証拠がある場合は、人が当該行の CSV ヘッダーと全フィールドを照合し、`data/gmail-staging/amazon/verified-summary-rows.json` に `[ヘッダー配列, 行配列]` の UTF-8 JSON の SHA-256 を配列で登録する。検索状態は再実行で照合を通過してから進む。

### 確定失敗の解除

解除は失敗ごとに行う。`failure_id` は失敗時にログとサマリへ出る識別子で、`node run.mjs --clear-failure <failure_id> --job <job>` はその失敗・対象・期間だけを承認する。確認済み期間やデータは変更しない。効果は 1 回だけで、同じ対象が再び確定失敗になれば再度の承認が必要。

Amazon は Type A/B を共通 CSV へ適用する 1 ジョブで、どちらかに未承認の確定失敗があればジョブ全体を見送る。両型が処理対象だった回に共通の確定失敗が起きると**型ごとに別の `failure_id`** が記録されるため、原因と両型への影響を確認し、未承認の ID **それぞれ**に対して `--clear-failure` を実行してから再取込する。片方の承認だけでは、もう片方が未承認の間は再開しない。詳細は設計書 [§4.5-2](docs/修正設計書_Gmail取り込み非AI一本化_Phase1_2026-11-25.md)、型単位での再開は [後続の修正設計 §5.2](docs/修正設計書_Gmail取り込み実装レビュー反映_Phase1_2026-11-26.md) を参照。

AI 経路からは解除できない。人が端末で実行する。

## 隔離試験と切替

`npm test` は合成データを使用する。実プロセスを試験するときは `--profile <試験用ディレクトリ>` を指定し、その直下に `gmail-ingest`、`amazon-tracker`、`credit-card-tracker` を用意する。試験用の認証・状態・ログ、CSV・SQLite と実行 CLI をこの配下に配置する。週次枠を再現する試験用タスクには `scripts/register-task.ps1 -ProfilePath <試験用ディレクトリ>` を使う。

1. 隔離試験を完了し、`scripts/preflight-cutover.ps1 -Stage ConfirmIsolation -Confirmed` で記録する。
2. Codex の画面で、ユーザーが旧 Automation 2 本の新規起動を無効化する。親プロジェクトの `/amazon-import` と取込スキルを診断専用へ切り替え、反映を確認したら `ConfirmOldDisabled` を記録する。
3. ユーザーが Codex で受理済みキュー・実行中ジョブの不在を確認し、`ConfirmOldDrained` を記録する。PowerShell が確認できるのは Windows タスク側の状態まで。
4. 旧側の最終状態を再照合する。Amazon の正本と旧 `last-run.json`、カード各社の日次ログと SQLite の取得・適用履歴を利用する。旧 Amazon ログが古い場合は判断を記録し、カードの確定末を特定できない社は空のまま欠落回収へ回す。`schema_version: 2` と `business_from` を含む状態の形式は設計書 §4.4 を参照する。
5. `data/gmail-auth/oauth.json` に正本を配置する。正しいアカウントを別途確認した人が、正規化したアドレスの SHA-256 を用意し `node run.mjs --register-account --expected-account-fingerprint <SHA-256>` を実行する。本人確認の入力はチャットや永続ログに記録しない。`Snapshot` で復元セットを作る。
6. 人が初回の `node run.mjs` を実行する。保存ポリシーの承認フラグはまだ置かない。取り込みの受入を確認したら `ConfirmFirstRun`、次いで `Enable` を記録する。タスクは `\my-app2\GmailIngest-Weekly`。登録内容は `scripts/register-task.ps1 -XmlOnly` でも確認できる。

切戻しでは `Rollback` で新タスクを無効化し、実行中インスタンスの終了後に解除する。旧 Codex Automation の再有効化は、2027-02-01 より前で人が明示承認した場合のみ、画面から行う。それ以降は人が直接 CLI を起動する。

## 保存期限と権限取り消し

2026-11-25 のユーザー判断で、取得元識別に使う元データを保持しています。一括削除と定常の自動削除は保留中です。

初回取り込みの受入後に、設計書 §10-10 の取得元識別方針を決める。`node run.mjs --cleanup-plan` で計画を作成し、ローカルの `state/cleanup-plans/<id>.json` を確認する。適用成功が証明できた対象を承認する場合は `node run.mjs --enable-cleanup --plan-id <id>`、同じ ID の実行は `node run.mjs --plan-id <id>` を使う。承認は一回限り。定常清掃を有効にする場合は、その後に人が `state/auto-cleanup-enabled` を配置する。

アクセス権限を取り消すときは、設計書 §4.6-3 の順で実施する。

1. 取得を停止して認証を取り消す。新旧の定期実行と手動の取得入口を止め、ランナーと両アプリの `oauth.json` を対象に含める。
2. 本文・候補・ID・マニフェスト・隔離・解析失敗ファイルを対象に含める。年月別の過去取得と実行別の中間ディレクトリも確認する。
3. 公式エクスポートの参照と再構築を先に試す。必要な入力が欠けていれば業務データ変更の前に中止する。変更前に復元セットを作り、処分対象にも登録する。
4. 確定した取得元識別方針で Gmail 由来の Amazon 行を除去する。カード SQLite の独立データ有無を確認し、必要に応じて clean DB を再構築する。`email_messages`、`transaction_sources`、`gmail_fetch_messages`、`parse_failures`、`import_runs` の ID・診断欄と WAL / SHM も確認する。
5. Gmail 由来のバックアップ・復元セット、`dist/data/orders.csv` と他の派生物を対象に含める。公式データを保持して再ビルドし、実施日時と対象別件数を記録する。
