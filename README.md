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
| 削除計画の作成 | `node run.mjs --cleanup-plan` |
| 照合済み分の承認 | `node run.mjs --enable-cleanup --plan-id <id>` |
| 過去分も含めた承認 | `node run.mjs --enable-cleanup --plan-id <id> --include-legacy` |
| 承認済みの削除実行 | `node run.mjs --plan-id <id>` |

手動の取得を行う場合は人が端末で起動する。AI や自動化の診断は `logs/summary.json` と定常ログの件数・分類・時刻を参照する。状態の正本は `state/last-run.json`。業務データや認証ファイル、取得成果物、削除計画、復元セットには個人データが入り得るためローカルに保管する。

終了コードは `0` 成功または枠完了済み、`1` 設定・状態・実行エラー、`2` 一部または全部の失敗、`3` 排他・プロセス停止確認待ち、`4` 認証・アカウント・出力先の照合失敗、`5` 全対象が確定失敗の解除待ち、`6` 欠落回収の残り。`3` で `pending_lock` がある場合はスケジュールを止め、対象の親・子プロセスの不在と業務データの整合性を確認してから管理者が該当ロックを退避する。

両アプリの直接起動とランナーは同じロック形式を使う。アプリの単独起動を保つため、それぞれの既存 CLI にロック処理を置いている。ロック形式を修正する場合は、両アプリとランナーを同じ変更で検証する。

Type B の旧サマリに見える行は保留される。独立した取得元の証拠がある場合は、人が当該行の CSV ヘッダーと全フィールドを照合し、`data/gmail-staging/amazon/verified-summary-rows.json` に `[ヘッダー配列, 行配列]` の UTF-8 JSON の SHA-256 を配列で登録する。検索状態は再実行で照合を通過してから進む。

### 確定失敗の解除

解除は失敗ごとに行う。`failure_id` は失敗時にログとサマリへ出る識別子で、`node run.mjs --clear-failure <failure_id> --job <job>` はその失敗・対象・期間だけを承認する。確認済み期間やデータは変更しない。効果は 1 回だけで、同じ対象が再び確定失敗になれば再度の承認が必要。

Amazon は Type A/B を共通 CSV へ適用する 1 ジョブだが、**ブロックされていない型だけで実行する**。片方が未承認の確定失敗でも、残る型の検索・適用・確認済み期間は進む。見送った型があった回の週次枠は未完了のまま残るため、承認後の再実行でその型を処理してから枠が閉じる。両型が処理対象だった回に共通の確定失敗が起きると**型ごとに別の `failure_id`** が記録されるため、原因と両型への影響を確認し、未承認の ID **それぞれ**に対して `--clear-failure` を実行する。両型ともブロック中の回は子 CLI を起動せず終了コード `5` になる。詳細は設計書 [§4.5-2](docs/修正設計書_Gmail取り込み非AI一本化_Phase1_2026-11-25.md)、型単位の選別は [後続の修正設計 §5.2](docs/修正設計書_Gmail取り込み実装レビュー反映_Phase1_2026-11-26.md) を参照。

Amazon 側の子 CLI へは `--types typeA,typeB` で選択型を渡す。非選択型は検索も本文取得も行わず、`<type>-ids.json` も作らない。ランナーはその不在も含めて照合する。

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

## 取得元識別の対応表

`amazon-tracker/public/data/orders.csv` は Amazon 公式 CSV 由来の行と Gmail 由来の行が混在し、28 列のどこにも取得元の欄がありません。列を増やす代わりに、Gmail 由来行の識別キーのハッシュだけを `amazon-tracker/data/gmail-origin.json` に持ちます（決定は [取得元識別の修正設計](docs/修正設計書_Gmail取得元識別_Phase1_2026-11-26.md)）。

- 取り込みの適用が成功した後に、追記された行のキーを加算し、旧サマリ置換で消えた行のキーを減算する。重複スキップ・除外・隔離の行は入れない。
- ランナーは適用前後の対応表を読み、期待した加減算と一致しない場合は `permanent` / `verify_mismatch` として確認済み期間を進めない。
- 過去分は `cd amazon-tracker && node tools/gmail-origin.mjs` で被覆報告を出す（既定はドライラン。書き込みは `--apply`）。バックアップ世代の差分と `gmail-import-rules.md` の追記件数が一致しない世代は報告して中断するため、人が原因を判断する。
- 平文の商品名・金額・注文番号は保存しない。対応表と決定記録は Git 管理外で、権限取り消し手順の完了後に削除する。

## 保存期限と権限取り消し

2026-11-25 のユーザー判断で、取得元識別に使う元データを保持しています。一括削除と定常の自動削除は保留中です。

`node run.mjs --cleanup-plan` で計画を作成し、ローカルの `state/cleanup-plans/<id>.json` を確認する。適用成功が証明できた対象を承認する場合は `node run.mjs --enable-cleanup --plan-id <id>`、同じ ID の実行は `node run.mjs --plan-id <id>` を使う。承認は一回限り。定常清掃を有効にする場合は、その後に人が `state/auto-cleanup-enabled` を配置する。

計画出力の `excluded` には、清掃対象の種別に該当してもファイル検査で除外した件数をルート・種別・理由ごとに表示する。`multiple_hardlinks` があれば、非公開の計画で対象を確認する。

### 過去分の一括削除（方式 A）

定常の照合済み台帳に記録が無い過去分は、別立ての証跡台帳 `state/cleanup-evidence.json` を人が用意し、`--include-legacy` を付けた承認の範囲内でだけ削除できます。台帳は新たに Gmail へ問い合わせず、ローカルの記録だけから作ります。

- Amazon の先行条件は §10-10 の決定記録 `state/origin-policy.json`。この記録が無い、または台帳の `origin_policy_id` と一致しない間は Amazon の過去分を削除できない。
- 1 項目は計画の同一性フィールド（`root` / `path` / `kind` / `size` / `mtime` / `sha256`）の書き写しに `origin_released` と `applied_proof` を添える。`applied_proof.kind` は `amazon_backup`（当時のバックアップ CSV 名。対象の日付ディレクトリと世代日付が一致すること）、`amazon_run_log`（`gmail-import-rules.md` の実行日。その項目に書かれたバックアップが実在すること）、`card_import_run`（`import_runs` の行 ID。SQLite を読み取り専用で開き、成功・provider・期間が対象の payload 名と一致すること）のいずれか。
- 未解決隔離、`parse-failures.json` を含むディレクトリ、`orders.csv`（`public` / `dist`）、SQLite 本体と WAL / SHM、`gmail-import-rules.md`、バックアップ CSV、復元セットは証跡があっても削除しない。
- 承認時に全条件を検査し、削除の直前にも同じ条件と証跡台帳のハッシュを再検証する。承認後に差し替えられた項目と承認に無いパスは削除しない。承認は 1 回の実行で消費し、`cleanup-enabled`・計画台帳・証跡台帳を削除する。中断後の再開には再棚卸しと新規承認が必要。
- 定常の自動削除は引き続き照合済み台帳だけを対象とし、`state/verified-artifacts.json` を遡及して書き換えない。
- `card_import_run` の照合に標準モジュール `node:sqlite` を使うため、必要な Node.js は 22.5 以上（運用環境は 24）。

アクセス権限を取り消すときは、設計書 §4.6-3 の順で実施する。

1. 取得を停止して認証を取り消す。新旧の定期実行と手動の取得入口を止め、ランナーと両アプリの `oauth.json` を対象に含める。
2. 本文・候補・ID・マニフェスト・隔離・解析失敗ファイルを対象に含める。年月別の過去取得と実行別の中間ディレクトリも確認する。
3. 公式エクスポートの参照と再構築を先に試す。必要な入力が欠けていれば業務データ変更の前に中止する。変更前に復元セットを作り、処分対象にも登録する。
4. 確定した取得元識別方針で Gmail 由来の Amazon 行を除去する。対応表のキーと一致する行だけを対象とし、`count` を超える一致は削除しない。対応表に無い行は原則残し、被覆報告の `unresolved`（2026-05-02 の差分 13 行）を削除側に寄せるかは人が決めて記録する。手順の完了後に対応表と決定記録自体も削除する。カード SQLite の独立データ有無を確認し、必要に応じて clean DB を再構築する。`email_messages`、`transaction_sources`、`gmail_fetch_messages`、`parse_failures`、`import_runs` の ID・診断欄と WAL / SHM も確認する。
5. Gmail 由来のバックアップ・復元セット、`dist/data/orders.csv` と他の派生物を対象に含める。公式データを保持して再ビルドする。
6. 所有者が同期先の複製、版履歴、ごみ箱、共有先から復元可能な複製を確認する。バックアップ・復元セットは各世代を確認する。承認範囲で処分した後、ローカルと同期先の結果を件数で記録する。未確認や残存があればデータ処分は未完了とする。
