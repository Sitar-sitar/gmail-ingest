# 設計書：Gmail 取り込みを非AIの単一ランナー（gmail-ingest）へ一本化する（Phase 1）

Google Workspace API の規約変更により、2027-02-01 から AI エージェントが Workspace データへアクセスする場合は REST API 直接利用ではなく MCP の利用が求められる。現在 `amazon-tracker` / `credit-card-tracker` の Gmail 取り込みは Codex Automation（AI 実行基盤）から起動されているため、取得経路から AI を実際に外し、Windows タスクスケジューラから実行される単一の非AIランナーへ移行する。

- **作成日**: 2026-11-25
- **対象アプリ**: `gmail-ingest`（新規）/ `amazon-tracker` / `credit-card-tracker` / 親リポ共通ルール
- **種別**: 修正設計書（新規 CLI `gmail-ingest` の機能設計書を兼ねる）
- **対象バージョン**: `gmail-ingest` v0.1.0 / `amazon-tracker` v0.2.0 / `credit-card-tracker` v0.1.2
- **前提コミット**: `amazon-tracker` `f273aa3` / `credit-card-tracker` `573607c` / 親リポ `1272450`
- **ステータス**: **実装済み・本番切替済み（F #27 清掃保留）**。反映コミットは `gmail-ingest` `992ef85` / `amazon-tracker` `1303592` / `credit-card-tracker` `2eeb55b` / 親リポ `fb849f2`。受入と残課題は [実装ログ](実装ログ.md) を参照。
- **関連**:
  - レビュー（初回）: [Gmail取り込み非AI一本化 Phase 1 設計レビュー](設計レビュー_Gmail取り込み非AI一本化_Phase1_2026-11-25.md)（P1 8 件 / P2 5 件。反映済み）
  - レビュー（第2回・追加レビュー含む）: [Gmail取り込み非AI一本化 Phase 1 設計再レビュー](設計再レビュー_Gmail取り込み非AI一本化_Phase1_2026-11-25.md)（R2-01〜R2-15。P1 9 件 / P2 6 件。全件反映済み）
  - レビュー（第3回）: [Gmail取り込み非AI一本化 Phase 1 設計レビュー（第3回）](設計レビュー_Gmail取り込み非AI一本化_Phase1_第3回_2026-11-25.md)（判定 **条件付き着手可**。R3-01〜R3-06。P1 3 件 / P2 3 件。全件反映済み。反映内容は §変更履歴 の第3回レビュー反映の行を参照）
  - 後続: Phase 2 設計書（Gmail REST 呼び出しコアの共通化）— 未起票
  - 実装後: [2026-11-26 実装レビュー](実装レビュー_Gmail取り込み非AI一本化_Phase1_2026-11-26.md)・[レビュー対応の修正設計](修正設計書_Gmail取り込み実装レビュー反映_Phase1_2026-11-26.md)。稼働中の仕様と F #27 の保留条件は本書に反映した。
  - `credit-card-tracker/docs/実装設計書_Gmail週次Automation効率化_2026-07-10.md`（別リポジトリのため §4.1 によりリンクせず名称で参照。本設計は同設計の「Automation 入口＝`npm run gmail:import-incremental`」を温存し、その起動元だけを差し替える）
  - `amazon-tracker/gmail-import-rules.md`（別リポジトリ。取り込みルールの正本。本設計により §Codex Automation 運用と §Gmail API 認証の一部を改訂する）
  - 根拠とした外部資料: Google Cloud Platform 通知メール「[Pricing Update] Changes to Google Workspace API usage limits starting Feb 2027 and new AI policies」（受信 2026-11-25、対象プロジェクト `credit-card-tracker-496602`）および同日付の影響調査報告書。要点は §1.1 / §1.2 に書き写す（§4.1 に従い外部ファイルへのリンクは置かない）

---

## 1. 目的・背景

### 1.1 Google 通知の要点（本設計で前提とする範囲）

| 日付 | 内容 |
|---|---|
| 2026-11-24 | Workspace API に Standard / Scaled の 2 階層を導入。**新規の上限引き上げ申請には Scaled が必要**（ただし条件を満たす組織内利用には、一部 REST API のプロジェクト上限について例外申請経路がある。§1.1.1。本件の適格性は未確認） |
| 2027-02-01 | **Workspace AI Tools Addendum の発効**と、**AI エージェント等に対する MCP 利用要件の技術的適用開始**。この日に始まるのはこの 2 つで、全プロジェクトへの上限適用・課金は含まない |
| 2027-04-01 | **全プロジェクトに対する Standard 上限の適用開始**と、Scaled 対象利用への課金開始。未対応プロジェクトは Standard 上限へ移行（追加料金なし） |

> **訂正（2026-11-25・レビュー指摘）**: 起票時は 2027-02-01 に「利用制限の適用開始」を併記していたが、公開ロードマップ（Usage tiers and quotas for Google Workspace APIs and MCP servers、2026-11-25 確認）は **2027-02-01 の AI 向け MCP 要件と、2027-04-01 の全プロジェクトへの Standard 上限適用・課金開始を区別**している。上の表はこれに合わせて訂正した。本設計の期限設定（2027-01-31 までに非AI化）は MCP 要件の日付に依拠するため変わらない。
>
> また、条件を満たす組織内利用には、一部 REST API のプロジェクト上限について例外申請経路がある。**本件の例外適格性と実使用量はいずれも未確認**で、上限内かどうかは §8.4 の実測で判断する（§10.2）。

- Standard は無料で、公開された利用上限が適用される。上限内であれば対応不要。
- **AI エージェント等が Workspace データへアクセスする場合は、REST API 直接利用ではなく MCP を使うことが求められる。**
- 通常の非AIプログラムによる REST API 利用が一律禁止されたわけではない。
- AI によるスクレイピング、および取得データの長期保存に関する制限が Workspace AI Tools Addendum で導入される。

AI 実行基盤が REST API を呼び出す既存スクリプトを「起動する」構成が適用対象になるかについて、Google から個別の確定回答は得ていない。本設計は、適用されても問題にならない側へ寄せる（AI を実行経路から実際に外す）という方針を取る。

#### 1.1.1 Workspace AI Tools Addendum の原文確認（2026-11-25 追記）

公開ページ（`workspace.google.com/terms/ai-tools/`、Last modified: November 24, 2026 / 効力発生 2027-02-01）と利用階層ページ（`developers.google.com/workspace/guides/quota-usage-tiers`、Last updated 2026-11-24）を読み、本設計に関係する条項を確認した。要点のみ書き写す（§4.1 によりリンクは置かない）。

| 論点 | 原文確認の結果 |
|---|---|
| MCP 要件の適用対象 | Addendum 項目 1 の MCP 要件は、`GWS Access Tool` が **AI Agent / AI Harness / AI model またはそれを使うサービスである場合、またはそれらに駆動される場合**に限られる。**cron やタスクスケジューラから起動される非AIスクリプトには MCP 要件が直接かからない。** 本設計の方針（AI を実行経路から外す）はこの条項に対して有効 |
| 制限条項の適用対象 | 一方で禁止事項 2(a)–(g) は `GWS Access Tool` 全般にかかり、その定義は `any AI Agent, AI Harness, software, application, ...` と広い。**非AIスクリプトも 2(a)–(g) の対象と読める**（Addendum に「非AIスクリプトも対象」と明記した文言はないため、これは解釈） |
| 30 日の保存上限 | 2(b) に `Store any Google Technical Information for more than 30 days` とある。**30 日上限は `Google Technical Information` に対するもの**で、Addendum は `Google Technical Information does not include any user data.` と明記している。定義は vector embeddings / memory indexes / user profiles / organizational graphs / findings / failure patterns 等の、アクセスや相互作用から派生した情報 |
| user data の保存 | 2(a) は user data を**期間ではなく目的で制限**する（`active, user-authorized tasks` を満たす目的以外での処理の禁止）。**数値の保存期間は定められていない** |
| 権限取り消し後 | 2(d) は、`GWS Access Tool` を切断またはアクセスを取り消した後に user data および `Google Technical Information` を**保持することを禁止**している。削除期限や手続きの具体的記述はない |
| スクレイピング | 2(e) は `user-authorized task` に必要な範囲を超えた scraping / systematic probing を禁止 |
| Standard 上限 | 利用階層ページには、GA の Google Workspace MCP servers について `capped at 5,000 requests per day, per project, per product`（加えて分あたり上限あり）と記載。**REST の Gmail API の 1 日／1 分あたりの具体値は同ページには記載されていない**。また MCP ツールは複数の API 呼び出しを行う場合に複数リクエストとして数えられる旨の記載がある |

**本設計への帰結:**

1. **`orders.csv` の購入履歴と SQLite の取引明細は `user data` であり、`Google Technical Information` ではない。したがって 30 日の保存上限は適用されない。** 影響調査報告書が留保していた「一律 30 日の保存上限が課されるとは判断しない」は、原文確認により裏付けられた。家計簿・購入履歴管理という利用目的が 2(a) の `active, user-authorized tasks` に該当する限り、保存期間の数値制約は生じない。
2. **2(d) により、OAuth のアクセスを取り消した場合は Gmail 由来の user data を保持できない。** 権限取り消し時の手順整備が必須となる（§4.6-3）。Amazon 公式 CSV エクスポート由来のデータは Workspace API 経由で取得していないため 2(d) の対象外であり、両者の区別が必要になる（§10-10）。
3. 中間ファイル（メール本文 JSONL・候補 JSON）は user data だが、取り込み完了後は利用目的を終えているため、2(a) の観点から速やかに削除するのが妥当。§4.6 の削除規則はこの根拠に基づく。
4. 非AI運用へ移行すれば MCP 要件は直接かからないが、2(a)–(g) の制限は残るため、保存ポリシーの実装は非AI化と独立に必要である。

### 1.2 現状構成と、調査で確定した事実

本設計の起票前に、両リポジトリのコードとローカル設定を静的に確認した結果：

| 確認項目 | 結果 |
|---|---|
| OAuth クライアント | **両アプリの `client_id` が完全一致**（値は記載しない。SHA-256 先頭 8 桁の一致で確認）。すなわち両アプリは同一の Google Cloud プロジェクトを共用しており、通知対象が `credit-card-tracker-496602` 1 件だけだった理由と整合する。API 使用量は Google 側で既に合算されている |
| amazon 側の認証フォールバック | `amazon-tracker/tools/gmail-fetch-local.mjs` が、既定 `oauth.json` が `invalid_grant` の場合に `credit-card-tracker` 側の `oauth.json` を検証してから自分側へ**コピー上書き**する（同ファイル L10 / L100-110 / L163-190）。リポジトリ間の絶対パス依存であり、最も脆い箇所 |
| `credit-card-tracker` の取得構成 | `npm run gmail:import-incremental` で 検索→本文取得→payload 生成→DB 登録まで一括実行済み。`--auth-file` を受け取れる。`tools/lib/` に認証・パーサ・provider 定義が分離済み。**永続的な検索状態を持たない** |
| `credit-card-tracker` の 45 日ルックバックの限界 | **訂正（レビュー P1-01）**: 起票時は「45 日ルックバックで未実行期間を自動回収できる」としたが誤り。`tools/lib/provider-config.mjs:95–104` は**実行日から検索開始日を算出し、前回成功日を参照しない**（2026-11-25 を与えると 3 社とも検索開始日は 2026-10-11）。前回成功が 45 日より前の場合、その間に着信した対象メールは検索されないまま**3 社すべて `status=success` を返す**。Amazon 側の検索状態を保っても回復しない。したがって **`credit-card-tracker` にも確認済み期間の保持が必要**（§4.4） |
| `amazon-tracker` の取得構成 | `gmail:fetch-local`（704 行。Gmail API 取得と Type A/B パース・金額按分・候補生成が同一ファイル）と `gmail:import:apply`（653 行）の **2 コマンドに分かれており、一括実行スクリプトが無い**。`--auth-file` / `--out` / `--candidates-file` を受け取れる |
| `amazon-tracker` の検索状態 | `gmail-import-rules.md` の「次回検索開始日」（Type A / Type B 別、現在値はいずれも 2026-11-20）が正本。Markdown のみで機械可読ファイルは非正本（`logs/gmail-import/last-run.json` は補助） |
| 定期実行 | `credit-card-tracker` = Codex Automation 毎週土曜 22:00（README L67）/ `amazon-tracker` = Codex Automation 毎週日曜（`gmail-import-rules.md`）。**2 本の AI 実行経路が存在する** |
| 共通ルール | 親リポ `.claude/CLAUDE.md` §7 に「定期的な自動取り込みは **Codex オートメーション側が主担当**」と明記。本設計により改訂が必要 |

### 1.3 解決したい問題

1. **規約リスク**: Gmail 取得の実行経路に AI エージェントが存在する（2 本）。
2. **認証の脆さ**: リポジトリ間の絶対パス参照による `oauth.json` の自動コピー。どちらかのディレクトリを移すと壊れ、どちらが正本か不明になる。
3. **`amazon-tracker` の一括実行の不在**: 2 コマンドを人間または AI が順序立てて実行し、開始日を Markdown から読み、成功後に Markdown を書き戻す運用になっている。非AI の定期実行に載せられない。
4. **保存データの管理**: 取得した本文 JSONL・中間 JSON の削除規則が未整備。Addendum の長期保存制限に対する備えがない。
5. **使用量の確認箇所が分散**: 同一プロジェクトなのに実行経路が 2 本で、ピーク時の合算が追いにくい。

---

## 2. スコープ

### 2.1 IN

- 新規 CLI プロジェクト `gmail-ingest` の作成（UI なし、サーバなし、**ポート不要**）。
- `oauth.json` の正本を 1 箇所へ集約し、両アプリへ `--auth-file` で明示的に渡す。
- `amazon-tracker` の 2 コマンドを `gmail-ingest` が順序制御する（fetch → 検証 → apply）。
- `amazon-tracker` の検索状態（Type A / Type B の次回検索開始日）を機械可読ファイルへ移管。
- 逐次実行・排他制御・ジョブ単位リトライ・終了コード集約・実行サマリ出力。
- 取得本文・中間ファイル・隔離データの削除規則の実装（`gmail-ingest` 側で実施）。
- Windows タスクスケジューラ `\my-app2\GmailIngest-Weekly` への登録と、`register` / `unregister` スクリプト。
- **既存の残存中間データの棚卸し**（§4.6-2）。ランナーの成功記録がない過去分は検出して保持する。一括削除の方式は未決で、F #27 の再開には §10-10 の取得元識別方針と [後続の修正設計](修正設計書_Gmail取り込み実装レビュー反映_Phase1_2026-11-26.md) §5.1 の決定が必要。
- **アクセス権限取り消し（revocation）時のデータ取り扱い手順**の整備（Addendum 2(d) 対応。§4.6-3）。
- **`/amazon-import` と Codex 取込スキルの診断専用化**（取得・適用・状態更新の手順を削除。§4.9-1。レビュー P1-08）。
- **既存 CLI の変更**（第2回レビューにより 2 ファイル → 5 ファイルに拡大。いずれも **§2.2「既存挙動を保つ」の明示的な例外**。判定・按分・検証のロジックは変更しない）:

| ファイル | 変更 | 根拠 |
|---|---|---|
| `amazon-tracker/tools/gmail-fetch-local.mjs` | 認証自動コピー経路の削除。`--check-auth` の出力に `account_fingerprint`（正規化＋SHA-256）を追加 | P1-04 / R2-04 |
| `amazon-tracker/tools/gmail-import-run.mjs` | **既存 CSV を読む前**のロック取得。`replaced_typeB_summary_rows` と置換した実行の出力。旧サマリと確定できない行の保留 | P1-05 / R2-03 / R2-13 |
| `credit-card-tracker/tools/gmail-import-apply.mjs` | DB 書込み前のロック取得。`import_runs.note` の例外本文を分類コードへ置換 | P1-05 / R2-03 / R2-15 |
| `credit-card-tracker/tools/gmail-raw-payload.mjs` | 取得履歴書込み前のロック取得。**利用日の下限を受ける引数の追加**。集合照合用の ID 出力 | R2-02 / R2-03 / R2-12 |
| `credit-card-tracker/tools/gmail-import-incremental.mjs` | **利用日の下限を受ける引数の追加**（`--from` の意味は変えず、省略時は現状と同じ挙動） | R2-02 |
- Codex Automation 2 本の停止と、親リポ `.claude/CLAUDE.md` §7・両 README・`gmail-import-rules.md` の改訂。

**上表の 5 ファイルが既存 CLI の変更範囲の正本**で、§2.2・§4.9・§5・§6 #14–18・§7 はこれと一致させる（第3回レビュー R3-01）。

### 2.2 OUT（今回触らない。既存挙動を保つ）

- **Gmail REST 呼び出しコードの共通化**（Phase 2 へ分離）。両アプリの取得コードはそのまま使う。
- **パースルール・重複判定・隔離・金額按分・バックアップ・CSV 検証のロジックの一切**。`gmail-import-rules.md` のパースルールと重複排除ルールは変更しない。**ただし §2.1 IN の表に挙げた 5 ファイルの変更（排他の追加・引数の追加・識別子と ID の出力追加・診断欄の分類コード化）は明示的な例外**で、いずれも判定・按分・検証のロジックには触れない（第3回レビュー R3-01）。
- `orders.csv` の 28 列構造、SQLite のスキーマ、両アプリの集計 UI・画面・ビルド成果物。
- `amazon-tracker` の一度限りの復旧経路（`--type-b-ids-file`、`--amount-fix`）。手動実行用として維持する。
- MCP への移行（非AI運用へ変更するため Phase 1 では不要）。
- Scaled ティアへの変更（Standard 上限内の見込み。実測確認は §10.2 / §8.4）。
- **新規のビューア／ダッシュボードアプリの作成**（§3.2 で却下）。
- SQLite と CSV のデータストア統一（§3.2 で却下）。

---

## 3. 全体方針

### 3.1 採用する構成

取得（Gmail へのアクセス）を 1 本のランナーに集約し、アプリへの反映（SQLite / CSV）は各アプリに残す。

```mermaid
flowchart TD
    A["Windows タスクスケジューラ<br>\my-app2\GmailIngest-Weekly<br>（週次 + ログオン時 + 起動時）"] --> B[node run.mjs]
    B --> M{"非取得モードの指定あり?<br>--clear-failure / --register-account<br>--cleanup-plan / --enable-cleanup<br>--restore-set"}
    M -->|あり| MO["該当操作のみ実行<br>取得しない・枠を消費しない<br>（§4.1-1）"]
    M -->|なし| W{未完了の実行枠あり?}
    W -->|なし| Z0[即 0 終了]
    W -->|あり| P{"認証・アカウント・<br>出力先の照合OK?"}
    P -->|いいえ| Z4[終了コード4<br>何も実行しない]
    P -->|はい| S[state/last-run.json 読込]
    S --> SK{"対象ごとに<br>未承認の permanent?<br>（§4.5 / §4.5-2）"}
    SK -->|あり| SKIP["その対象だけスキップ<br>他のジョブ・社は継続<br>全件スキップ時のみ終了コード5"]
    SK -->|なし| L["排他ロック取得<br>ランナー + 書込み対象側"]
    SKIP --> L
    L --> J1["job: credit-card<br>--provider 社ごとに 3 回実行<br>（社単位で即時永続化）"]
    J1 --> Q1{"検索窓が<br>confirmed_through+1 を覆う?"}
    Q1 -->|いいえ| GA["欠落回収<br>受信期間と利用日下限を別引数で明示<br>覆えなければ gap_pending"]
    Q1 -->|はい| C1["process.execPath<br>tools/gmail-import-incremental.mjs"]
    GA --> C1
    C1 --> V1{"ID集合照合OK かつ<br>failure_count=0 かつ<br>範囲が連続?"}
    V1 -->|いいえ| F1["当該社の last_outcome を記録<br>当該社の確認済み期間は進めない"]
    V1 -->|はい| U1["当該社の confirmed_through を進める"]
    F1 --> J2
    U1 --> J2["job: amazon<br>（カードの成否に依存せず実行）"]
    J2 --> C2["process.execPath<br>tools/gmail-fetch-local.mjs"]
    C2 --> V2{"0終了 かつ<br>parse-failures.json なし?"}
    V2 -->|いいえ| F2["last_outcome を記録<br>確認済み期間を進めない"]
    V2 -->|はい| VF["適用前照合<br>型別通数・検索条件・<br>元メール単位の金額照合（型別。§4.3-1a）"]
    VF -->|不一致| F2
    VF -->|一致| C3["process.execPath<br>tools/gmail-import-run.mjs"]
    C3 --> V3{"0終了 かつ validation.ok?"}
    V3 -->|いいえ| F2
    V3 -->|はい| VA["適用後照合<br>期待行集合・バックアップ実在・<br>CSV再読・隔離配列長（§4.3-1b）"]
    VA -->|不一致| F2
    VA -->|一致| U["confirmed_through を進める"]
    U --> K{"state/auto-cleanup-enabled<br>あり?"}
    F2 --> K
    K -->|なし| KP["自動削除0件<br>件数のみ出力"]
    K -->|あり| KD["今回生成し適用成功を<br>確認した成果物のみ削除<br>（過去分は §4.6-2 の別系統）"]
    KP --> G[実行サマリ・ログ出力]
    KD --> G
    MO --> G
    G --> X[終了コード集約・ロック解放]
```

要点：

- **認証は「コード」ではなく「ファイルの場所」を一本化する。** `gmail-ingest` は Gmail API も OAuth 更新コードも持たず、`--auth-file` に正本パスを渡すだけ。これによりリポジトリ間の `import` 依存を新たに作らない（現状の悪い形の再発を避ける）。認証コードの共通化は Phase 2。
- **両アプリとも確認済み期間の保持が必要**で、これを `gmail-ingest` が持つ（§4.4）。`credit-card-tracker` は 1 コマンドで完結するが、45 日ルックバックは前回成功日を参照しないため自己回復しない（§1.2 の訂正行）。結果として、影響調査報告書が提案していた `amazon-tracker/tools/gmail-import-incremental.mjs` の新規作成は不要になり、両アプリ共通の 1 本に集約される。
- **ジョブは「成功」と「確認済み期間が進んだ」を別に扱う。** 45 日窓や検索範囲が確認済み期間の翌日を覆えない場合、子 CLI が `status=success` を返しても確認済み期間は進めず、欠けた期間を明示して取り込むか成功扱いを保留する（§4.4 / §4.5）。
- `--out` を `gmail-ingest` 側で指定することで、candidates.json の場所が実行日依存でなく決定論的になる。
- **ジョブ単位リトライは安全**。両アプリが行単位重複判定（`orders.csv`）と fingerprint 重複排除（SQLite）を持つため、同一期間の再実行で二重登録は起きない。

### 3.2 退けた代替案

| 代替案 | 却下理由 |
|---|---|
| **新規ビューアアプリを作り、その中から 2 アプリを確認する** | 規約問題を一切解決しない。本質は取得経路から AI を外すことであり、UI 統合はそれと直交する。加えて個人データ（購入履歴・取引明細）の保管場所が 3 箇所目になり、ポート・ビルド・テスト・公開対象が増える。「一箇所で確認したい」という要求は、§4.7 の実行サマリ（件数・終了コード・最終実行日のみ、個人データなし）で満たす |
| **Phase 1 で Gmail REST 呼び出しコアまで統合する** | `amazon-tracker/tools/gmail-fetch-local.mjs` は取得とパース・金額按分・隔離判定が同一ファイルに同梱されており、ここを触ると `orders.csv` の整合性に直接響く。技術的適用開始まで約 10 週であり、規約リスクを確実に消す変更を先に通す（CLAUDE.md §1 YAGNI・§5 大規模一括実装の禁止） |
| **SQLite と CSV を単一データストアへ統一** | スキーマも用途も異なり、両アプリの集計 UI 全面改修になる。「アプリへの反映のみ分ける」という方針と矛盾する |
| **MCP へ移行して AI エージェント運用を継続** | 定型処理に AI は不要。取得コードの呼び出し方式変更が必要で改修コストが大きく、MCP 側の提供機能・利用条件に運用が依存する。さらに §1.1.1 の原文確認により、MCP 要件は `GWS Access Tool` が AI Agent / AI Harness / AI model に該当する場合に限られ、**非AI運用へ移行すれば MCP 要件は直接かからない**ことが裏付けられた。MCP は単一の呼び出しが複数リクエストとして数えられる場合があり、Standard 上限に対しても不利。AI による取得が必要になった場合の代替案として保留する |
| **各アプリに個別のタスクを登録（ランナーを作らない）** | 規約リスクは解消するが、認証の二重管理、状態管理の不在、保存ポリシーの二重実装、使用量ピークの合算困難が残る |

---

## 4. 詳細仕様

### 4.1 `gmail-ingest` の構成

```
D:\my-app2\gmail-ingest\
  package.json            # name: gmail-ingest, type: module, private: true, 依存なし（Node 標準のみ）
  run.mjs                 # 唯一の入口。node run.mjs で直接実行する（npm script を介さない。P1-03）
  jobs.mjs                # ジョブ定義（credit-card / amazon）
  lib/
    exec.mjs              # 子プロセス実行（process.execPath 直実行）・stdout JSON 回収・タイムアウト
    env.mjs               # 子プロセス環境の構築（認証・出力先の上書きを排除。P1-04）
    lock.mjs              # 排他ロック（原子的作成・所有者のみ解放。P1-05）
    state.mjs             # state/last-run.json の読み書き（原子的 write→rename）
    verify.mjs            # 適用前後の照合（候補と元メッセージ、注文総額と行合計。P1-02）
    cleanup.mjs           # 中間ファイル削除（既定は無効。P1-07）
    log.mjs               # ログ・実行サマリ出力（許可した値だけから生成。P2-02）
    restore-set.mjs       # 復元セットの作成・検証（§7-1。R2-07）
  scripts/
    register-task.ps1     # タスクスケジューラ登録（冪等）
    unregister-task.ps1   # 解除（冪等）
    preflight-cutover.ps1 # 旧Automation停止確認→新タスク有効化（段階ごとに中断可。P2-05）
  data/
    gmail-auth/oauth.json # 認証正本（Git 管理外）
  state/
    last-run.json         # 検索状態の正本（Git 管理外）
    verified-artifacts.json # 照合済み成果物の清掃台帳。実パス・ファイル情報・検証時刻を持つ（Git 管理外）
    cutover.json          # 切替段階、記録時刻、復元セット世代の台帳（Git 管理外）
    cleanup-enabled       # 一括削除の承認フラグ。1 回の削除実行で消費する（Git 管理外。P1-07 / R2-08）
    auto-cleanup-enabled  # 定常の自動削除の有効化フラグ。一括削除の承認とは別系統（Git 管理外。R3-02）
    cleanup-plans/        # 削除計画の非公開台帳 <plan_id>.json（実パス・ハッシュを持つ。Git 管理外。R2-08）
    restore-sets/         # 復元セット <timestamp>/ と manifest.json（Git 管理外。R2-07）
    .lock                 # 実行中ロック（Git 管理外）
  logs/
    YYYY-MM-DD.json       # 実行ログ（Git 管理外。件数・真偽・種別のみ）
    summary.json          # 最新 1 回の実行サマリ（Git 管理外）
  tests/
    *.test.mjs
  docs/
    実装ログ.md
    設計書インデックス.md
  README.md
  .gitignore              # data/ state/ logs/ node_modules/
```

- 外部依存を入れない（Node 20+ 標準 API のみ）。`npm install` 不要で、タスクスケジューラ実行の失敗要因を減らす。
- **`run.mjs` は `node run.mjs` で直接起動する。`npm run` を入口にしない**（P1-03。理由は §4.3 の子プロセス起動契約）。
- ポートを待ち受けないため `PORTS.md` / `ports.json` の変更は不要。この判断を README に明記する。
#### 4.1-1 実行モードと優先順位（第2回レビュー R2-11）

初回反映時は CLI オプションを並べただけで、**通常起動（本番の書込み先固定・完了枠スキップ）と、隔離した state / DB / CSV での再実行、`--job` / `--gap-only` / 清掃専用操作の優先順位が未定義**だった。

| モード | 起動 | 枠判定 | Gmail 取得 | 状態更新 | 書込み先 |
|---|---|---|---|---|---|
| 通常（既定） | `node run.mjs` | する（完了枠ならスキップ） | する | する | **本番に固定**（§4.2-1） |
| ジョブ限定 | `--job <name>` | **しない**（人が起動する前提） | する | 対象ジョブのみ | 本番に固定 |
| 欠落回収 | `--gap-only` | しない | する | 照合を終えた区間まで | 本番に固定 |
| 失敗解除 | `--clear-failure <id> --job <name>` | しない | **しない**（承認の記録のみ） | `cleared_failures` のみ | — |
| アカウント登録 | `--register-account` | しない | プロフィール確認のみ | `account_fingerprint` のみ | — |
| 削除計画 | `--cleanup-plan` | しない | **しない** | **しない** | 計画台帳のみ |
| 削除承認 | `--enable-cleanup --plan-id <id>` | しない | しない | 承認フラグのみ | — |
| 復元セット作成 | `--restore-set` | しない | **しない** | **しない**（state は読んでコピーするだけ） | 復元セット（`state/restore-sets/<timestamp>/`）のみ |
| 移行前記録を含む復元セット | `--restore-set --include-legacy-state` | しない | しない | しない | 復元セットに Amazon の旧運用 Markdown とカードの日付付き Markdown 最新最大3件を添付 |
| 隔離試験 | `--profile <試験プロファイル>` | しない | **スタブまたは試験アカウント** | 試験用 state のみ | **試験用ルート一式** |
| 隔離週次試験 | `--profile <試験プロファイル> --test-weekly` | する（試験用 state で判定） | スタブまたは試験アカウント | 試験用 state のみ | 試験用ルート一式 |

- **優先順位**: `--clear-failure` / `--register-account` / `--cleanup-plan` / `--enable-cleanup` / **`--restore-set`** は**取得を伴わない操作**で、指定時は取得ジョブを実行しない。**同時に複数を指定した場合はエラー**で終了コード 1。`--job` と `--gap-only` は併用でき、どちらも枠判定を行わない。
- **`--restore-set` は `--profile` と併用できる**（第3回レビュー R3-04）。§8.3-21 の隔離試験で**試験用ルートの復元セット**を作る必要があるため。併用時も下記の混在拒否規則に従い、**復元元（CSV / SQLite / state）と保存先のすべてが試験用ルート配下**であることを検証する。1 つでも本番の実体を指していれば何も実行せず終了コード 4。`--restore-set` は書込みを止めるため §4.5 の両ロックを取得するが、**実行枠は消費せず `attempted_slot` / `completed_slot` も更新しない**。
- **本番と試験の混在を拒否する**: `--profile` を与えた場合、state / DB / CSV / ログ / 計画台帳の**すべて**が試験用ルート配下であることを検証する。1 つでも本番の実体を指していれば**何も実行せず終了コード 4**。逆に `--profile` なしで試験用ルートを指す値が渡された場合も同様に拒否する。
- **同一枠内の手動操作が通常取込を起動しない**: `--cleanup-plan` や `--clear-failure` は枠を消費せず、`attempted_slot` / `completed_slot` も更新しない。
- `--test-weekly` はプロファイル付きの通常取込に限り、`--job`・`--gap-only`・`--ids-only` との併用は終了コード 1。`--include-legacy-state` は `--restore-set` 専用。切替の本番スナップショットでは `preflight-cutover.ps1` が付与する。指定時に必要な移行記録が欠けていれば復元セット作成は失敗する。
- **初回本番（§6 #25⑤）の合格項目**: §9 のうち**取り込みの正常性に関する項目のみ**を対象とする。週次タスクの有効化（§6 #25⑥）・削除の承認と実削除（#27）・フェーズ締め（#31）は**初回本番の合格条件に含めない**（それぞれ後続手順の合格条件）。§9 にこの区別を明記する（3 段階の合格判定）。

受入: 同一枠内での手動回収や清掃計画が誤って通常取込を起動しないこと。**隔離実行が本番ファイルを更新しないこと。**

### 4.2 認証の一本化

**2026-11-25 追記（§10-1 の確定内容）**: 両アプリの `oauth.json` は `client_id` / `client_secret` / `refresh_token` のすべてが一致しており、**内容が同一**だった（更新日時も 2026-11-07 23:25 で一致。2026-11-07 に自動コピーが実際に発動した痕跡）。`--check-auth` による検証で `gmail_profile_ok: true` を確認済みで、この認証情報は有効。したがって「どちらが有効か」の選択は発生せず、いずれか一方をコピーすれば移行できる。

1. 正本を `gmail-ingest/data/gmail-auth/oauth.json` に 1 本化する（既存のどちらか一方をコピーする。内容は同一なのでコピー元の選択は任意。`credit-card-tracker` 側を元とする）。コピー後に `--check-auth --auth-file <正本>` で `gmail_profile_ok: true` を再確認する。
2. `gmail-ingest` は全ジョブへ `--auth-file <正本の絶対パス>` を渡す。環境変数 `GMAIL_AUTH_FILE` も同じ値を子プロセス環境へ設定する（`--auth-file` を解釈しない経路の保険）。
3. **`amazon-tracker` のリポジトリ間自動コピーを削除する**（`tools/gmail-fetch-local.mjs` の `SHARED_AUTH_FILE` 定数、`shouldRepairDefaultAuth`、`copyAuthFile`、`getAccessTokenWithRepair` の修復分岐）。認証解決は 環境変数アクセストークン → `--auth-file` → `GMAIL_AUTH_FILE` / `GOOGLE_GMAIL_AUTH_FILE` → 既定 `data/gmail-auth/oauth.json` の順のみとする。
4. 各アプリの `data/gmail-auth/oauth.json` は削除せず据え置く（手動実行のフォールバックとして機能させる）。ただし正本ではないことを `gmail-import-rules.md` と README に明記する。
5. 実行前チェック: `run.mjs` は最初に `amazon-tracker` の `tools/gmail-fetch-local.mjs --check-auth --auth-file <正本>` を §4.3 の起動契約で 1 回だけ呼び、`gmail_profile_ok` を確認する。失敗した場合はどのジョブも実行せず終了コード 4 で終わる（Gmail API を無駄に叩かない）。
6. `refresh_token` は再利用可能で、ジョブは逐次実行されるため、同一ファイルへの同時書き込みは発生しない。
7. **ログ・サマリ・実装ログ・設計書に token / client_secret / refresh_token / `client_id` を一切出力しない。**

#### 4.2-1 子プロセス環境の確定（レビュー P1-04）

起票時の事前確認は「プロフィールにメールアドレスがあること」しか見ておらず、**Amazon の確認が成功しても 2 社の取得元が一致する保証がなかった**。両アプリは環境変数をファイルより優先するため（Amazon: `tools/gmail-fetch-local.mjs:9,111–118,587–596` の 3 種のアクセストークンと `GOOGLE_*`／カード: `tools/lib/gmail-auth.mjs:30–34,84–99` の独自トークンと `GOOGLE_*`）、アプリごとに異なる環境値を継承すると取得元が分かれる。出力先にも `AMZ_GMAIL_IMPORT_ORDERS_CSV`・`CREDIT_CARD_DB_PATH` の上書きがある。**別ファイルへ登録して本番用の検索状態だけを進める組合せが成立しうる。**

`lib/env.mjs` が子プロセス環境を明示的に構築する。親の環境をそのまま継承しない。

1. **除去する変数**（親に設定されていても子へ渡さない）: `AMZ_GMAIL_ACCESS_TOKEN`、`GMAIL_ACCESS_TOKEN`、`CREDIT_CARD_GMAIL_ACCESS_TOKEN`、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`GOOGLE_REFRESH_TOKEN`、`GOOGLE_GMAIL_AUTH_FILE`、`AMZ_GMAIL_IMPORT_CANDIDATES_FILE`、`AMZ_GMAIL_IMPORT_ISOLATED_FILE`。
2. **本番出力先を固定し検証する**: `AMZ_GMAIL_IMPORT_ORDERS_CSV` は `amazon-tracker/public/data/orders.csv`、`CREDIT_CARD_DB_PATH` は本番 DB の絶対パスに固定する。親に別の値があっても上書きし、解決後のパスが本番の実体であることを確認してからジョブを開始する。一致しない場合はそのジョブを実行せず、**確認済み期間を進めない**。
3. **渡す変数（allowlist。これ以外は渡さない）**: `GMAIL_AUTH_FILE`（正本）、`GMAIL_INGEST_LOCK_TOKEN`（§4.5-1）、`PATH`、`SystemRoot`、`TEMP`、`TMP`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`、および §4.2-1-2 で固定する出力先の 2 変数。
   **除外する変数（親に設定されていても渡さない）**: 上記 1 の 9 変数に加えて **`NODE_OPTIONS`**（子の実行環境を外から変えられるため）。
4. **想定アカウントの一致確認（第2回レビュー R2-04 により訂正）**

   初回反映時は「`--check-auth` が返すアカウントをハッシュ比較する」としたが、**現行の実装はその識別子を親へ返さない**。プロフィールの取得は子プロセス内で行われ、親へは `gmail_profile_ok: Boolean(profile.emailAddress)` とパス等だけが返る（`tools/gmail-fetch-local.mjs:587–599`）。**アカウント A でも B でも真になり、親から区別できない。** 初回に無条件で採用すると、取り違えた正本を以後の基準に固定してしまう。

   - **子 CLI が識別子を機械用結果へ返すようにする**: `amazon-tracker/tools/gmail-fetch-local.mjs` の `--check-auth` の出力に `account_fingerprint` を追加する。値は**子側で正規化（小文字化・前後空白除去）したうえで SHA-256 を取ったもの**で、**生のメールアドレスは返さない**。これは既存 CLI の変更であり §2.1 IN・§4.9・§6 に含める。
   - **照合**: `state/last-run.json` の `account_fingerprint` と一致する場合のみ続行する。不一致、または `account_fingerprint` が欠落している場合は**終了コード 4 で停止し、業務データと確認済み期間を変更しない**。
   - **初回登録は独立した人の操作とする**: `node run.mjs --register-account` で、**既存の正しいアカウントと照合したうえで**記録する。通常実行が自動で初回登録することはない（無条件採用をしない）。再登録も同じ操作を要する。

受入（§8.3-3 に追加）: 実プロフィール応答を模した A・B で、**初回一致・以後一致のみ通過**し、**別アカウントと識別子欠落は終了コード 4**、業務データ・確認済み期間とも不変であること。

#### 4.2-2 子プロセスの起動契約（レビュー P1-03）

起票時は `npm run <script> -- <args>` と「stdout の JSON」を指定していたが、**Windows でこの契約は成立しない**。レビューの実測では、シェルを介さない `npm` の起動は `ENOENT`、`cmd.exe` 経由の `npm run` は終了コード 0 でも npm の見出し行が付き、stdout 全体の JSON 解析に失敗した。子が DB や CSV を更新した後に親だけが失敗と判定し、再試行する危険がある。

- **`npm` を介さず `process.execPath`（Node 実行ファイル）に、各アプリのエントリーファイルの絶対パスと引数配列を渡す。** `shell: false`、`cwd` は対象アプリのルート。
- 対象エントリー（いずれも `package.json` 上で Node スクリプトを直接実行しているもの）:
  - `credit-card-tracker/tools/gmail-import-incremental.mjs`
  - `amazon-tracker/tools/gmail-fetch-local.mjs`
  - `amazon-tracker/tools/gmail-import-run.mjs`
- **stdout は単一の JSON、stderr は診断用**と定める。判定は「終了コード」と「JSON の必須項目」を**両方そろって**行う。どちらか欠ければ失敗扱いとし、**データ更新の有無が不明な失敗**として扱う（§4.5 の再試行規則）。
- Amazon apply は `writeJson(stats)` で `validation` と `isolated_file` を同じ階層に出す（`tools/gmail-import-run.mjs:245–276,547–557`）。この階層を前提に必須項目を定義する。
- 空白を含むパス（`C:\Program Files\nodejs\node.exe`）と、`env.mjs` で絞った `PATH` でも動くことを実プロセスで確認する（§8.3）。**子プロセスを全てスタブにする §8.1 の試験では代替できない。**

### 4.3 ジョブ定義と実行順序

`jobs.mjs` は配列順に逐次実行する。並列実行はしない（Standard 上限に対するピークを作らない）。

**ジョブ 1: `credit-card`**

| 項目 | 値 |
|---|---|
| 作業ディレクトリ | `credit-card-tracker`（`gmail-ingest` からの相対パスを絶対化して渡す） |
| 起動 | **1 社ずつ `--provider <社>` で 3 回に分けて起動する**（`--provider all` は使わない。R2-05）。`process.execPath` + `tools/gmail-import-incremental.mjs` + `["--auth-file", <正本>, "--provider", <社>, "--mode", "incremental", …§4.4-1 の期間引数]`（§4.2-2） |
| 検索範囲の事前判定 | **社ごとに `confirmed_through` を読み、45 日窓がその翌日を覆うか判定する**（P1-01）。覆わない場合は §4.4-1 の欠落回収へ分岐する |
| 成功条件（社ごと） | 終了コード 0、かつ stdout JSON の `status === "success"`、かつ `imports[].failure_count === 0`、かつ `log_validation.status === "success"`、**かつ検索範囲が `confirmed_through` の翌日以降を連続して覆っている**、**かつ §4.3-2 の集合照合が一致する** |
| 状態更新 | **社ごとに**、上記すべてを満たしたときのみその社の `confirmed_through` を進める（§4.4） |

既存 CLI は `status !== "success"` で終了コード 2、例外で 1 を返すため終了コードだけでも判定できるが、stdout JSON も併せて検証する。

**`status === "success"` を確認済み期間の根拠にしない**（P1-01）。`tools/lib/provider-config.mjs:95–104` は実行日から検索開始日を算出し前回成功日を参照しないため、長期停止後は未取得期間を飛ばしたまま 3 社とも成功を返す。成功条件の最後から 2 行目がこれを捕まえる。

**`--provider all` を使わない理由（R2-05）**: 現行の一括 CLI は 3 社を処理したあとで初めて `imports` を stdout へ出す。**1 社目のコミット後に 2 社目が例外終了すると、成功済み 1 社の結果 JSON も返らない**。これでは §4.4 の「成功した社だけ進める」を入口から確定できない。正常終了時の `imports[]` にも実際の検索開始・終了は入らない（`tools/gmail-import-incremental.mjs:115–120,161–192`）ため、期間はランナー側が指定した値を正とする。

- **部分成功の永続化時点**: 1 社の成功条件がすべて満たされた直後に、その社の `confirmed_through` を書き込む（3 社の完了を待たない）。
- **未着手社**: 前の社で `permanent` が出た場合も、**他の社は実行する**（社ごとに独立。全体を止めるのは認証・アカウント・出力先の照合失敗とロック競合のみ）。未着手で終わった社は `last_outcome: "not_run"`。
- **再試行先**: `transient` の社だけを再試行する。
- **複数の理由が同時にある場合の終了コード**: `permanent` を含むなら 2、`permanent` なしで `transient` のみなら 2、処理は成功したが `gap_pending` のみなら 6、`not_run` のみなら 2 を返す。複数該当時は **小さい番号を優先せず、`4 > 3 > 5 > 2 > 6` の順で最初に該当したものを返す**（停止の理由が強いものを優先）。

**ジョブ 2: `amazon`**

| 項目 | 値 |
|---|---|
| 作業ディレクトリ | `amazon-tracker` |
| ステップ 1（取得） | `process.execPath` + `tools/gmail-fetch-local.mjs` + `["--type-a-after", <A>, "--type-b-after", <B>, "--auth-file", <正本>, "--out", <OUT>]` |
| ステップ 1 成功条件 | 終了コード 0、かつ `<OUT>/parse-failures.json` が存在しない、かつ `<OUT>/candidates.json` が JSON として読め、`rows` が配列である |
| **ステップ 1.5（適用前照合）** | **`lib/verify.mjs` による照合。下記 §4.3-1。失敗なら apply を実行しない** |
| ステップ 2（適用） | `process.execPath` + `tools/gmail-import-run.mjs` + `["--candidates-file", <OUT>/candidates.json]` |
| ステップ 2 成功条件 | 終了コード 0、かつ stdout JSON の `validation.ok === true`、かつ `stats.isolated_file` のファイルが存在する（隔離 0 件でも空配列が保存される） |
| **ステップ 2.5（適用後照合）** | **バックアップの実在、`public/data/orders.csv` の再読、隔離配列長と `stats.isolated_amount_diff_only` の一致。下記 §4.3-1** |
| 状態更新 | ステップ 1〜2.5 のすべてが成功したときのみ（§4.4） |
| `<OUT>` | `amazon-tracker/data/gmail-staging/amazon/<実行日 YYYY-MM-DD>/`（既定と同一。`gmail-ingest` が明示指定して決定論的にする） |

- `--type-b-ids-file` / `--amount-fix` / `--dry-run` / `--append` は `gmail-ingest` からは渡さない。手動実行専用とする。
- ステップ 1 が失敗した場合、ステップ 2 は実行しない（`orders.csv` に触れない）。

#### 4.3-1 Amazon の適用前後の照合（レビュー P1-02）

起票時の条件は「取得成功・失敗ファイルなし・`rows` が配列」だけで、**現行の `gmail-import-rules.md:323–325` が求める照合が抜けていた**。レビューの実測では、注文総額 1,000 円に対して 300 円 × 2 行という合成候補を `tools/gmail-fetch-local.mjs:560–578` の検査に渡しても指摘は 0 件で、CSV の 28 列検査でも金額差 400 円は発見できない。これは候補検査の限界を示すものであり、現行パーサが実メールで同じ誤りを起こした証拠ではない。

**ステップ 1.5（apply の前）** — `<OUT>` の成果物と今回の元メッセージを照合する。

1. `typeA_query` / `typeB_query` が `gmail-ingest` の指定した開始日と一致する。
2. 予約除外後の型別通数（`typeB_message_count`、`excluded_typeB_preorder_messages`、`typeA` 側の通数）が `typeA-ids.json` / `typeB-ids.json` と `*-messages.jsonl` の件数と整合する。
3. `rows` の各要素が `{type, row}` で、`type` は `typeA` / `typeB` のみ。型別の行数が対象通数以上である。
4. **金額の照合（元メール単位・型別。下記 §4.3-1a）。**
5. 必須項目（`Order ID`、`Product Name`、`Order Date`、`Unit Price`、`Total Amount`）の欠落がない。

いずれかが不一致なら **apply を実行せず、`orders.csv` と確認済み期間の双方を変更しない。**

##### 4.3-1a 金額の照合式（第2回レビュー R2-01 により訂正）

**初回反映時の照合式は誤りだった。** 「同一 `Order ID` の行の `Total Amount` の合計を注文総額と照合する」としたが、**Type A はこの形ではない**。`tools/gmail-fetch-local.mjs:402–439` は Type A の各行に**同じ注文総額を入れる**（総額ラベルがなければ商品小計の和を用いる）。レビューが既存テスト相当の合成メールを実際にパースした結果は、商品小計 1,200 円と 1,000 円、両行の `Total Amount` が**各 2,200 円**。合計すると 4,400 円になり、**正常な週でも apply の前で止まる**。`gmail-import-rules.md:324` が行合計の照合を求めているのは Type B のみである。

照合は**元メール 1 通を単位とし、型別に式を分ける**。

**Type A（物理商品の発送通知）**

- 各行の `Total Amount` が、**元メールの `合計` の値**と一致する。
- 元メールに `合計` ブロックがない場合のみ、各行の `Total Amount` が**通貨表記付き単価行から算出した商品小計の和**と一致する。
- 行ごとに `Unit Price` × `Original Quantity` が `Shipment Item Subtotal` と一致する。
- **行の `Total Amount` を合算しない。**

**Type B（デジタル商品）**

- **按分行の `Total Amount` の和**が、元メールの `*総計:` / `総計:` の値と一致する。`Total Discounts` の和も割引総額と一致する。
- 加えて、**元メールの商品明細と候補の商品名・数量・金額を照合する。** 金額だけを残った商品へ配分すると、**商品が 1 点欠落していても合計は一致してしまう**ため、合計照合だけでは欠落を検出できない。
- `販売者:` ブロックの数と候補行数が一致する。

**共通**

- 同一注文について**別の通知メールが同じ期間に含まれる場合**（発送分割など）、通知ごとに独立して照合する。通知をまたいで合計しない。
- 照合に使う元メールの値は `<OUT>/*-messages.jsonl` から取り、`amazon-tracker` のパーサは呼び直さない（パーサの実装に依存しない独立した照合にする）。

受入（§8.3-8 を差し替え）: ①上記 Type A の 2 商品メール（各行 2,200 円）が**通る** ②正常な Type B の按分 ③**商品 1 点欠落だが合計は一致する Type B** を**検出する** ④同一注文の別通知。

**ステップ 2.5（apply の後）** — 確認済み期間を進める前に確認する。

1. `backups/orders/<timestamp>-orders.csv` が実在し、読み取れる。
2. `public/data/orders.csv` を再読し、ヘッダー 28 列・全行 28 列・空 `Order ID` 0 件・Type A の金額不正な新規行 0 件。
3. `stats.isolated_file` の JSON を読み、**配列長が `stats.isolated_amount_diff_only` と一致**する。
4. **件数収支（R2-01 により訂正）**: 候補行数 = 追記件数 + 完全一致スキップ件数 + 除外件数 + **`isolated_amount_diff_only`** + **`replaced_typeB_summary_rows`**。隔離を独立した分岐として式に含める（`tools/gmail-import-run.mjs:507–523`）。**隔離だけ 1 件の週は「候補 1 / 追記 0 / 完全一致 0 / 除外 0 / 隔離 1」で合格**とする。
5. **既存行の保存（下記 §4.3-1b）。**

照合は `gmail-ingest` 側で行い、`amazon-tracker` のパーサ・重複判定・隔離条件は変更しない（§2.2。ただし §4.3-1b の保留方式を採る場合は Phase 1 の例外として明示する）。

##### 4.3-1b 既存行の非破壊の検証（第2回レビュー R2-13）

適用後の確認が「バックアップ存在・列数・必須値・隔離件数・件数収支」だけでは、**適用前に存在した行の保存を保証しない**。`tools/gmail-import-run.mjs:449–454,540–557,609–649` は Type B の複数行が条件を満たすと、既存の 1 行を**旧サマリとみなして取り除く**。判定条件は注文 ID・日付・数量 1・商品名・金額の数値性などで、**その行が本当に旧サマリなのか公式 CSV 由来の明細なのかを示す取得元の証拠は使わない**。既存の同一注文の商品 A（数量 1）の正当な明細と、商品 A ＋ 商品 B の Type B 候補が条件を満たす場合、**既存 A が置換対象になりうる**。候補側の金額合計・CSV 構造・追記件数が正しくても、既存 A の住所等の情報や取得元が失われたことを検知できない。

1. **期待行集合を apply の前に確定する**: apply 前の `orders.csv` と候補から、「変更を許可する行」「変更理由」「期待する適用後の行集合」を作る。
2. **apply 後に実データの差分を照合する**: 追記・完全一致・隔離・除外に加え、**`replaced_typeB_summary_rows` と置換された実際の行を別集計**とする。変更を許可していない行と、変更対象外の列が保持されていることを確認する。
3. **旧サマリと確実に判断できない行は自動置換しない。** 保留して人の確認に回す方式を採る（`tools/gmail-import-run.mjs` の置換規則を変更する場合は **Phase 1 の例外**として §2.2 と §5 に明示する）。判断材料がないのは §10-10 の取得元識別が未決だからであり、**本項の論点は通常取込時の非破壊性**で、失効時の識別とは別である。
4. **異常差分を検出した場合**: 確認済み期間を進めず、削除許可も進めない。**復旧に必要な適用前世代（バックアップ）と証跡を保持する。**

受入: ①正規の旧サマリの置換が通る ②**同じ外形を持つ公式 CSV 明細が置換されない**（保留になる） ③同一件数で別行が欠落するケースを検出する ④CSV 置換直後の異常終了からの再試行。

#### 4.3-2 カードの検索・取得・適用の集合照合（第2回レビュー R2-12）

子 CLI の成功とログ検証、期間の連続性だけでは、**検索したメッセージ集合と実際に適用したメッセージ集合の一致を要求していない**。`tools/gmail-fetch-local.mjs:159–188` は検索 ID・スキップ件数・取得予定件数を返すが、`tools/gmail-raw-payload.mjs:42–65,153–184` は入力ディレクトリ内の JSON/JSONL を再帰走査し、**ID 欠落や重複を黙って除外する**。取得履歴の expected / fetched はいずれも実際に読み取った `messages.length` から作る（同 L106–122）。検索 2 件・取得予定 2 件に対して中間ファイルが正常な JSONL 1 件に欠けた場合、残る 1 件の解析が正常なら**現在の成功条件は不足 1 件を検出できない**。これは静的照合上の反例であり、通常運転で欠落が発生した実績を示すものではない。

**provider・実行 ID・検索区間の単位で**次を照合する。

1. **検索 ID 集合 =（処理済みとして検証された ID 集合）＋（今回取得した ID 集合）**。2 つの集合は**互いに素**であること。
2. **今回取得した ID 集合 = payload の対象 ID 集合 = 適用対象の ID 集合**。
3. **各 ID の処理結果**が次のいずれかに分類され、未分類が 0 件であること: 登録 / 既存取引への対応（重複排除） / 業務条件による正当な除外 / 失敗。
4. **1 メールに複数取引がある場合、メール数と取引数を直接同一視しない。** 照合はメール ID 単位で行い、取引件数は別に集計する。
5. **旧成果物を入力にしない。** 入力ディレクトリは実行別（§4.5 の実行別ディレクトリ）とし、過去の中間ファイルを再帰走査の対象に含めない。
6. 検証用の ID 一覧は**非公開の実行別成果物**に限定し、**定常ログには件数と真偽のみ**を出す（§4.7）。

受入: 0 件検索 / 全件処理済み / 複数ページ検索 / **JSONL の末尾 1 行欠落** / **同件数の別 ID 混入** / 1 メール複数取引。**正常な 0 件は成功**し、**欠落・別 ID 混入では確認済み期間を進めない**。

この照合に既存 CLI の出力追加が必要な場合は、§2.1 IN・§4.9・§6・§8・§9 の記載を一致させる。

### 4.4 検索状態の管理

`gmail-ingest/state/last-run.json`（これを機械可読の**正本**とする）:

```json
{
  "schema_version": 2,
  "account_fingerprint": "<アカウント識別子のSHA-256。値そのものは保存しない>",
  "amazon": {
    "type_a": { "confirmed_through": "2026-11-20", "last_success": "", "last_outcome": "" },
    "type_b": { "confirmed_through": "2026-11-20", "last_success": "", "last_outcome": "" }
  },
  "business_from": "<既存CLIの業務開始日。利用日の抽出下限。R2-02>",
  "credit_card": {
    "smbc":         { "confirmed_through": "", "last_success": "", "last_outcome": "" },
    "rakuten_card": { "confirmed_through": "", "last_success": "", "last_outcome": "" },
    "jcb_ekenet":   { "confirmed_through": "", "last_success": "", "last_outcome": "" }
  },
  "last_run": { "started_at": "", "finished_at": "", "exit_code": null, "attempted_slot": "", "completed_slot": "" },
  "cleared_failures": []
}
```

`confirmed_through` は「この日付までは全対象メールの取り込みを確認済み」を表す。`next_search_after` から名前を変えたのは、**検索の起点ではなく確認済みの終端**を正本にするため（P1-01 / P2-04）。

- **`amazon` の初期値**: `amazon-tracker/gmail-import-rules.md`「最終取り込み状況」の現在値（Type A / Type B とも `2026-11-20`）をそのまま移す。取り込み漏れを出さないため、初期値は現在値より新しくしない。
- **`credit_card` の初期値**: **旧ログから 3 社それぞれの確認済み期間末を特定して投入する**（`credit-card-tracker/logs/gmail-import/` の provider セクションと DB の取得履歴を突き合わせる）。特定できない社は空のままとし、**初回実行を §4.4-1 の欠落回収として扱う**。空のまま通常実行で成功扱いにはしない。
- **更新規則**: 対象ジョブの全ステップ（Amazon は 1〜2.5、カードは成功条件の全項目）が成功し、**かつ今回の検索範囲が `confirmed_through` の翌日以降を連続して覆っているときのみ** `confirmed_through` を進める。進める先は **その実行で照合を終えた連続区間の末**（実行日の前日を上限とし、それより短ければ短い方。R2-02）。Gmail の日付境界が太平洋時間基準であることへの対策は §4.4-1 (3)。
- **失敗時・範囲が覆えていないときは一切更新しない。** 次回実行で同じ範囲を再取得する。
- 書き込みは一時ファイルへ書いて読み直し検証し、`rename` で置換する。書き込みに失敗した場合は終了コードを非 0 にし、ログへ記録する（次回再実行で取り込み漏れが出ないことを優先する）。
- 粒度は **Amazon が Type A / Type B 別、カードが provider 別**。カードは 1 社ずつコミットするため（`tools/gmail-import-incremental.mjs:115–176`）、1 社成功・1 社失敗の部分成功が起こりうる。成功した社だけ進め、失敗した社は据え置く。
- `gmail-import-rules.md`「最終取り込み状況」は**人間向けの記録**へ降格する。表に「機械可読の正本は `gmail-ingest/state/last-run.json`」と明記し、`gmail-ingest` は Markdown を書き換えない。
- `amazon-tracker/logs/gmail-import/last-run.json` は従来どおり非正本。移行時に `state/last-run.json` の初期値と突き合わせ、より古い日付がある場合はユーザーへ報告して判断を仰ぐ（自動では採らない）。

#### 4.4-1 確認済み期間の欠落回収（レビュー P1-01）

通常の検索窓が `confirmed_through` の翌日を覆えない場合（カードは 45 日、Amazon は指定した開始日）、次のいずれかを行う。**黙って飛ばして成功扱いにはしない。**

**第2回レビュー R2-02 による訂正が 3 点ある。初回反映時の案は、遅着通知を正常として除外し、分割途中でも状態を先へ進めうるものだった。**

**(1) 「受信期間」と「利用日の下限」を別の引数にする**

既存 CLI は `--from` を **Gmail 検索の受信期間**と**取引の利用日フィルター**の**両方**に使う。レビューの実測では、9 月 25 日利用の通知を 9 月 27 日以降に受信した合成データに対し、抽出下限 9 月 1 日では取引 1 件、**抽出下限 9 月 27 日では取引 0・除外 1・解析失敗 0** だった（`tools/lib/parser.mjs:327–365`）。つまり**受信日の範囲が連続していて失敗数が 0 でも、遅着通知の明細が欠ける**。

- ランナーは **検索する受信期間**（`confirmed_through` の翌日〜実行日）と、**業務上採用する利用日の下限**（既存の業務開始日。`INITIAL_IMPORT_FROM` 相当）を**別の引数**として渡す。通常実行と欠落回収の**両方**に適用する。
- このため `credit-card-tracker/tools/gmail-import-incremental.mjs` と `tools/gmail-raw-payload.mjs` に**利用日下限の引数を追加する**（§2.1 IN / §4.9 / §6）。既存の `--from` の意味は変えず、新しい引数を省略したときの挙動を現状と同じにする。
- **既存の業務開始日を `state/last-run.json` に保存する**（`business_from`）。移行時に既存 CLI の既定値から転記する。
- 子 CLI へは `--from`・`--to` で検索する受信期間を、`--business-from` で利用日の下限を渡す。ランナー管理下のカード取込ではこの下限を必須とする（§4.9）。

**(2) 確定日は「照合を終えた連続区間の末」にする**

初回反映時は確定先を「実行日の前日」固定にしていたが、**60 日分の先頭 45 日だけ成功した場合に実際の取得末を越える**。また**初期状態が空の社には「翌日」の計算元がない**。

- 各社の `confirmed_through` は、**その実行で照合を終えた連続区間の末**までとする（実行日の前日を上限とするが、それより短ければ短い方）。
- **初期値不明時の検索下限**: `business_from`（業務開始日）を検索下限とし、`last_outcome: "gap_pending"` で開始する。初回は必ず欠落回収として扱い、通常実行で成功扱いにしない。

**(3) Gmail の日付検索は太平洋時間の午前 0 時基準**

Google「Search and filter messages」の日付境界の説明を 2026-11-25 に確認した。`after:` / `before:` / `newer:` / `older:` に日付文字列を使う検索は**太平洋時間の午前 0 時が境界**になる。JST とは最大 17 時間ずれるため、**JST の意図した範囲を取りこぼす**。

- 範囲は**秒指定（`after:<epoch>` 形式）**、または**重なりを持たせた日付指定**で覆う。重なりの重複は既存の重複判定で除外される。
- JST 早朝に着信した通知が落ちないことを受入で確認する。

**(4) 分割と保留**

- 回収しきれない場合は `last_outcome: "gap_pending"` として記録し、全体終了コードを 6 にする。`confirmed_through` は照合を終えた区間の末までしか進めない。
- 欠落が大きい場合は分割して実行する（1 回の検索範囲を 45 日以内に保ち、API 上限に対するピークを作らない）。`--gap-only` で欠落分だけを順に回収できる。**分割の途中で中断しても、そこまでの連続区間の末までしか確定しない。**

受入（§8.3-7 を差し替え）: ①**遅着通知 1 件**が欠けない ②**JST 早朝着**の通知が落ちない ③**初期値不明**の社が通常実行で成功扱いにならない ④**60 日の回収を 45 日で中断・再開**。いずれも最終的な取引集合と各回の確定末を照合する。

#### 4.4-2 ジョブ結果の定義（レビュー P2-04）

`last_outcome` に記録する値と、全体終了コードへの寄与を定める。**「確定失敗」と「一時障害」を区別し、タスク側の 30 分後再試行にも同じ方針を適用する。**

| 値 | 意味 | 再試行 | 確認済み期間 |
|---|---|---|---|
| `success` | 全ステップ成功、範囲も連続 | しない | 進める |
| `gap_pending` | 処理自体は成功したが範囲に欠落が残る | しない（次回 `--gap-only`） | 進めない |
| `partial` | schema v2 の互換読込用。Phase 1 の取込では provider ごとに結果を記録するため新規には記録しない | provider ごとの結果に従う | provider ごとの結果に従う |
| `transient` | 一時障害（ネットワーク、429 / 5xx、タイムアウト、JSON 欠落） | する（§4.5） | 進めない |
| `permanent` | 確定失敗（解析失敗、CSV 検証失敗、照合不一致、出力先不一致） | **しない** | 進めない |
| `not_run` | 前段の失敗や認証停止により未実行 | しない | 進めない |

`§8.3-6` の再実行確認で「SQLite の件数が増えない」は、取得・実行履歴テーブル（`gmail_fetch_messages` ほか、`tools/gmail-raw-payload.mjs:106–125`）まで含めると成立しない。**業務行（`transactions` / `orders.csv` の注文行）の集合と金額**と、**履歴行の増加**を別々に検証する。

### 4.5 排他制御・リトライ・終了コード

**排他制御（レビュー P1-05 反映）**: 起票時のロックは親 PID だけを追跡し、子や孫が apply 中にタイムアウトした場合の停止確認、ロックの原子的作成・所有者確認がなく、旧 Automation・直接 CLI はそもそもロックを取らなかった。Amazon apply は CSV を読んでから一時ファイルを作り、バックアップ後に置換する（`tools/gmail-import-run.mjs:569–604`）。**2 件が同じ旧 CSV を読めば、最後の置換で先行分が失われる。行単位の重複判定では同時書込みを防げない。**

- **ロックの場所を書込み対象の側に置く。** `gmail-ingest/state/.lock`（ランナー用）に加え、**書込み対象ごとのロック**を `amazon-tracker/data/.import.lock` と `credit-card-tracker/data/.import.lock` に置く。`orders.csv` / SQLite を書き換える入口はすべてこのロックを取る。
- **原子的に作成する**: `fs.openSync(path, "wx")` で排他作成し、`{ owner_token, pids: [...], started_at, host, entry, pending_human_review }` を書く。`owner_token` は実行ごとの乱数。**解放は `owner_token` が一致する場合のみ**許す。

##### 4.5-1 ロックの保持範囲と所有者の引継ぎ（第2回レビュー R2-03）

初回反映時は「CSV 置換の直前」にロックを取る設計だったが、**それでは先行する書込みが失われる**。Amazon apply は L569 で**旧 CSV を読み**、L449 以降の判定で出力を組み立て、L602–604 でバックアップ・置換する。手動処理と定期処理がともに 100 行を読み、それぞれ別の 1 行を追加して順に置換すれば、**置換中は常に 1 プロセスでも最終 101 行**になる（期待は 102 行）。また図の上で親が書込み対象ロックを取得し、子も同じロックを**新規取得**しようとすると、所有者の引継ぎ方法がない。

- **保持範囲**: Amazon は「**既存 CSV を読む前**」から「**適用後の照合（ステップ 2.5 / §4.3-1b）の完了**」まで、**1 つのロックを保持し続ける**。カードは「取得記録の書込み前」から「集合照合（§4.3-2）の完了」まで。
- **所有者はランナー（親）**: 親がロックを取得し、`owner_token` を環境変数 `GMAIL_INGEST_LOCK_TOKEN` で子へ渡す。**子は、この値がロックファイルの `owner_token` と一致する場合はロックを取得も解放もせず、そのまま処理する。** 一致しない／未設定の場合（＝人が直接 CLI を実行した場合）は**子が自分で取得・解放する**。`pids` には親と子の両方を記録する。
- **カード側の他の書込み口も保護する**: `tools/gmail-raw-payload.mjs:96–147,203` の取得履歴書込みも同じロックの下に入れる。**同日同パスへ書く中間ファイルは実行別ディレクトリに分ける**（`data/gmail-staging/run-<実行ID>/<provider>/`）。これは §4.3-2 の「旧成果物を入力にしない」とも一致する。
- **既存ロックの扱い（矛盾の解消）**: 2 つを区別する。
  - `pending_human_review: false` のロック: `pids` のいずれも生存していなければ stale として奪取し、ログに記録する。**1 つでも生存していれば奪取しない**（`started_at` から 6 時間を超えていても同じ）。これにより**親が終了し子が生存している間の第三の起動を拒否**できる。
  - `pending_human_review: true` のロック: **PID の生存に関わらず自動回収しない。** 人が §4.5-2 の解除操作を行うまで、すべての入口が終了コード 3 で停止する。
- **タイムアウト・強制終了時**: `exec.mjs` は子を `detached: false` で起動し、タイムアウト時は子ツリーを終了させ、プロセスの消滅を確認してからロックを解放する。確認できない場合は `pending_human_review: true` を書いて**ロックを保持したまま非 0 終了**する（誤った再試行で CSV を失うより停止を選ぶ）。
- **他の入口**: 旧 Codex Automation、`/amazon-import`、直接の `npm run` もこのロックに従う。既存 CLI 側にロック取得を追加するのは `amazon-tracker/tools/gmail-import-run.mjs`（**既存 CSV を読む前**）、`credit-card-tracker/tools/gmail-import-apply.mjs`（DB 書込み前）、`credit-card-tracker/tools/gmail-raw-payload.mjs`（取得履歴書込み前）の 3 箇所。**これは §2.2 の「既存挙動を保つ」の例外**として明記する（排他の追加のみで、判定・按分・検証のロジックは変更しない）。**ロック取得は 3 ファイルだが、既存 CLI の変更は合計 5 ファイル**（利用日下限の引数追加と `account_fingerprint` 出力を含む。§2.1 IN・§4.9・§6 #14–18）。
- 切替中・手動保守中は `scripts/preflight-cutover.ps1` が旧入口の停止を確認する（§4.8-2）。

受入（§8.3-13 を差し替え）: **2 プロセスが別の注文を追加する試験で、再試行完了後に最終 102 行で両注文が存在する**こと。**親終了・子生存中の第三の起動を拒否**すること。`pending_human_review` のロックが自動回収されないこと。

##### 4.5-2 確定失敗の解除と再開（第2回レビュー R2-14）

`permanent` を「人の確認があるまで再実行しない」としたが、**確認済みを記録する操作がなく、誰が何を確認し、どの provider・期間・失敗を解除するのかが未定義**だった。状態を手編集する運用では、誤って確定済み期間まで進めてしまう。また全体入口で一律に停止すると、provider 別の部分成功（§4.3）を採った場合に**正常な別ジョブまで停止し続ける**。

- **再開は承認付きの専用操作で行う**: `node run.mjs --clear-failure <failure_id> --job <名前>`。`failure_id` は失敗時にログとサマリへ出す識別子（分類コード＋対象＋期間から生成。個人データを含まない）。
- **承認は特定の失敗・対象・期間に束縛する**: `state/last-run.json` の `cleared_failures` に `{ failure_id, job, provider, range, cleared_at }` を追記する。**`confirmed_through` やデータの手編集は不要**で、解除操作はそれらを変更しない。
- **解除の効果は 1 回だけ**: 解除後の実行で同じ対象が再び `permanent` になれば、再度の承認が必要。
- **停止の範囲を区別する**:
  - **全体停止**: 認証・アカウント照合・出力先照合の失敗（終了コード 4）、`pending_human_review` のロック（3）、状態ファイルの破損・未対応 `schema_version`（1）。
  - **provider / ジョブ単位の停止**: 解析失敗・CSV 検証失敗・照合不一致。**他のジョブは通常どおり実行する。**
- **現行の Amazon**。Type A/B は共通 CSV へ適用する1ジョブで、どちらかに未承認の `permanent` があればジョブを見送る。両型が処理対象だった回に共通の確定失敗が起きると、型ごとに別の `failure_id` が記録される。原因と両型への影響を確認し、ログまたはサマリに残る未承認の ID **それぞれ**に `node run.mjs --clear-failure <failure_id> --job amazon` を実行してから再取込する。片方の承認だけでは、もう片方が未承認の間は再開しない。型単位での再開は [後続の修正設計](修正設計書_Gmail取り込み実装レビュー反映_Phase1_2026-11-26.md) §5.2 の受入対象とする。
- **状態が不明・破損・未対応 schema のときは安全停止**とし、**新規状態の自動生成で上書きしない**（取り込み漏れの発生源になる）。
- `/amazon-import` などの AI 経路からは**解除できない**（§4.9-1 の診断専用の範囲外）。

受入: 確定失敗 → 定期再起動（**未承認なので停止**）→ 原因修正 → **対象を限定した承認** → 再取得成功。承認済みの対象だけが再開し、成功時のみ期間が進むこと。

**リトライ（レビュー P2-04 反映）**: ジョブ単位で最大 2 回まで再試行する。待機は 60 秒 → 300 秒（指数バックオフ）。

- 再試行するのは `last_outcome: "transient"` のみ（§4.4-2）。
- **`permanent` は再試行しない**: CSV 検証失敗（`validation.ok === false`）、解析失敗（`parse-failures.json`）、照合不一致（§4.3-1）、出力先不一致（§4.2-1）。
- **データ更新の有無が不明な失敗**（JSON が欠落した非 0 終了、タイムアウト）は `transient` とするが、再試行の前に書込み対象ロックの解放と子ツリーの停止確認を必須とする。
- **タスク側の 30 分後再試行にも同じ方針を適用する。停止の粒度は §4.5-2 に従う（第3回レビュー R3-03）。** `run.mjs` は起動時に `last_outcome` と `cleared_failures` を読み、**ジョブ / provider ごとに**判定する。起動時に一律で全体を止めることはしない。
  - **起動時に全体を一律停止するのは全体停止事由だけ**: 認証・アカウント照合・出力先照合の失敗（終了コード 4）、`pending_human_review` のロック（3）、状態ファイルの破損・未対応 `schema_version`（1）。
  - **未承認の `permanent` が残っているジョブをスキップする。** カードは provider 単位、現行の Amazon は §4.5-2 のとおり Type A/B 共通の1ジョブ。`last_outcome` は `permanent` のまま保ち、確認済み期間は進めない。その他のジョブは通常どおり実行する。スキップは `failure_id` 付きでログとサマリに記録する。
  - **全体の終了コード**: 実行対象の**すべて**が未承認 `permanent` でスキップされ、**新規に実行したジョブが 0 件**だった場合のみ 5 とする。1 つ以上を実行して `transient` / `permanent` / `partial` が出た場合は 2（優先順は §4.3 の `4 > 3 > 5 > 2 > 6`）。
  - したがって**タスクの 30 分後再試行では、未承認 `permanent` の対象は再実行されず、`transient` の対象だけが再試行される**。
- 各ステップのタイムアウトは 30 分。ジョブ全体で 45 分、実行全体で 90 分を上限とする。
- 429 / 5xx に対する個別の再試行は各アプリ側の既存実装に委ね、`gmail-ingest` はジョブ単位の粗い再試行だけを担う（Phase 1 では新たなレート制御を実装しない）。

**終了コード**:

| コード | 意味 |
|---|---|
| 0 | 全ジョブが `success`（確認済み期間も進んだ） |
| 1 | 予期しない例外 |
| 2 | 1 つ以上のジョブが `transient` / `permanent` / `partial`（失敗分の確認済み期間は進めていない） |
| 3 | 多重起動または他入口のロックを検出して何もしなかった |
| 4 | 事前の認証チェック、アカウント照合、出力先照合に失敗して何もしなかった |
| 5 | **実行対象のすべてが未承認の `permanent` でスキップされ、新規に実行したジョブが 0 件**だった（個別対象だけのスキップでは 5 を返さず、実行した分の結果で 0 / 2 / 6 を返す。§4.5 / §4.5-2。R3-03） |
| 6 | 1 つ以上のジョブが `gap_pending`（処理は成功したが確認済み期間に欠落が残る） |

### 4.6 中間ファイル・保存期間

根拠は §1.1.1 の原文確認による。`user data` に数値の保存上限はなく、中間ファイルは「取り込み完了後は利用目的を終える」ことを根拠に削除する。30 日上限は `Google Technical Information` に対するものであり、本アプリ群はこれを生成・保存していない。

#### 4.6-1 定常の削除規則

削除は `gmail-ingest/lib/cleanup.mjs` が実施する（既存アプリのコードを変えずに保存ポリシーを実装できる）。

| 対象 | 方針 |
|---|---|
| `amazon-tracker/data/gmail-staging/amazon/<日付>/*-messages.jsonl`（メール本文） | 当該ジョブの適用成功を確認した直後に削除 |
| `amazon-tracker/data/gmail-staging/amazon/<日付>/candidates.json` / `typeA-ids.json` / `typeB-ids.json` | 7 日保持後に削除（検証用） |
| `amazon-tracker/data/gmail-staging/amazon/<日付>/parse-failures.json` を含むディレクトリ | 30 日保持（解決後は手動削除可）。自動削除の対象外とし、ログに「保持中」と記録する |
| `credit-card-tracker/data/gmail-staging/incremental/<日付>/<provider>/messages.jsonl` | DB 登録成功を確認した直後に削除 |
| `credit-card-tracker/data/import-<provider>-<tag>.json` | 7 日保持後に削除 |
| 隔離 JSON（`isolated.json`）、`amazon-tracker/backups/orders/isolated/`、**`credit-card-tracker/quarantine/gmail-import/`** | 空配列は照合済み台帳に登録されていれば7日保持後に定常削除の候補となる。**内容のある隔離は未解決扱いで、日数にかかわらず保持する。** 解決後の処分は人が必要資料と保持方針を確認する。現在は F #27 の保留が優先する。 |
| `backups/orders/*.csv` / DB バックアップ | **Phase 1 では削除しない（確定）**。`user data` に数値の保存上限はなく（§1.1.1）、復旧性を優先する。現状 `amazon-tracker/backups` は 64MB / 41 世代（2026-05-05〜2026-11-21）。世代上限を設けない代わりに、§4.6-3 の権限取り消し手順で削除対象に含める |
| `gmail-ingest/logs/*.json` | 180 日保持 |

- **許可ルート**: `data/` / `logs/` / `backups/` / **`quarantine/`** 配下に限定する。起票時は `quarantine/` が漏れており、カード側の実パス `credit-card-tracker/quarantine/gmail-import` が許可ルート外だった（P1-07）。パスが対象アプリのルート配下であることを `path.relative` で検証してから削除する（親ディレクトリへの遡上を禁止）。
- `public/data/orders.csv`、`dist/data/orders.csv`、SQLite 本体、`gmail-import-rules.md` は削除対象に含めない。
- **削除は既定で無効。承認は 2 系統に分かれ、互いを消費しない（第3回レビュー R3-02）。**

| 系統 | 有効化 | 対象 | 承認の寿命 |
|---|---|---|---|
| **定常の自動削除**（本節） | `state/auto-cleanup-enabled` の存在 | **`gmail-ingest` 自身が今回の実行で生成し、適用成功を確認した成果物**と、その保持期限が切れたもの | **消費しない**（週次の無人実行で継続して効く） |
| **計画に基づく一括削除**（§4.6-2 / §4.6-2a） | `state/cleanup-enabled` ＋ `--plan-id <id>` | 現行は照合済み台帳の記録と一致し、保持期限を過ぎた項目のみ。台帳のない過去分は棚卸しに掲載して保持 | **1 回の削除実行で消費**する |

- どちらのフラグもなければ削除 0 件。現行コード上、定常削除は `auto-cleanup-enabled` の配置で有効になる。F #27 の保留中は両フラグを未配置とする。再開条件は §4.6-2 と [後続の修正設計](修正設計書_Gmail取り込み実装レビュー反映_Phase1_2026-11-26.md) §5.1 を参照。
- **一括削除の承認消費（§4.6-2a）で `auto-cleanup-enabled` を削除してはならない。** 消費するのは `cleanup-enabled` と計画台帳だけ。これを混ぜると、初回の一括削除後に週次の無人実行で中間ファイルが一切自動削除されなくなる。
- `auto-cleanup-enabled` があっても、**過去分・未解決隔離・`parse-failures.json` を含むディレクトリは自動削除の対象外**（本節の表と末尾の判定根拠に従う）。

**「適用成功を確認した直後に削除」の判定根拠（P1-07）**: 日付ディレクトリの存在と `parse-failures.json` の有無からは過去の適用成功を判定できない。日付ディレクトリには取得成功・適用失敗も置かれ、Amazon は同日の再試行成功で失敗マーカーを消す（`tools/gmail-fetch-local.mjs:649–655`）。したがって削除の判定は次のように分ける。

- **今回の実行で生成した成果物**: ステップ 2.5 までの成功後に `run.mjs` が `state/verified-artifacts.json` に登録する。現行は保持期限と、ルート・種別・パス・サイズ・更新時刻・SHA-256 が台帳と一致することを削除条件とする。
- **過去分（`gmail-ingest` の記録がないもの）**: 現行版は定常・一括の両経路で保持する。人の計画承認だけで `eligible` は変わらない。

#### 4.6-2 既存の残存分の棚卸しと一括削除の保留

2026-11-25 時点でディスク上に以下が残存していた。現行版では計画に検出されても、照合済み台帳の記録がない限り削除候補にならない。

| 対象 | 実測 |
|---|---|
| `amazon-tracker` のメール本文 JSONL | 66 ファイル / 8.0MB（2026-05-25〜2026-11-21） |
| `credit-card-tracker` のメール本文 JSONL | 190 ファイル / 32.4MB（2026-05-17〜2026-11-21） |
| `amazon-tracker` の `candidates.json` | 38 ファイル |
| `credit-card-tracker` の `import-*.json` | 247 ファイル |
| `amazon-tracker/data/gmail-staging/amazon` の日付ディレクトリ | 33 ディレクトリ（2026-05-17 以降の全回分） |
| `credit-card-tracker/quarantine` | 441 ファイル / 2.5MB |

**削除は既定で無効で、明示的に有効化するまで 1 件も削除しない（レビュー P1-07 反映）。** 起票時は「`--no-cleanup` 付きの本番実行 → 一覧確認 → 有効化」としながら、当時の §6 の該当ステップ（現在の #27 に相当）が通常の `node run.mjs` で、許可の永続化手順も、過去の本文を「適用済み」と判定する証拠もなかった。

1. **F #27 の保留中は `state/cleanup-enabled` と `state/auto-cleanup-enabled` を未配置とする。** `node run.mjs --cleanup-plan` は棚卸しに使える。計画はファイル種別と実ルート単位で、照合済み・未解決隔離・削除可否を記録する。
2. §10-10 の取得元識別方針を決め、選んだ方法で必要資料を保全できたことを確認する。本文 JSONL や候補 JSON が遡及照合に必要な限り保持する。
3. [後続の修正設計](修正設計書_Gmail取り込み実装レビュー反映_Phase1_2026-11-26.md) §5.1 の一括削除方式をユーザーが選び、選択結果を設計に記録する。その方式の隔離受入と本番対象の確認が終わるまで、一括承認や定常有効化を行わない。承認の版・同一性・一回消費の契約は §4.6-2a に従う。

##### 4.6-2a 承認の束縛と計画の保存先（第2回レビュー R2-08）

初回反映時は**計画を定常ログと同じパスに出し、承認はフラグ 1 つ**だった。これでは**再生成された同名の別ファイルや差し替えられた別計画に旧承認を使える**。さらに**カードの隔離ファイル名はメッセージ ID** であり、計画の実パスには**定常ログで禁止した値**が残る。

- **承認を計画の版と対象の同一性に束縛する**: 計画に `plan_id`（内容の SHA-256）を持たせ、各対象に**パス・サイズ・mtime・内容ハッシュ**を記録する。`--enable-cleanup --plan-id <id>` は、**その `plan_id` の計画に限って**有効。
- **削除の直前に同一性を再検証する**: 対象が計画時点と異なる（サイズ・mtime・ハッシュのいずれかが変化、または新規に出現）場合、**その対象は削除せず**「変更あり・再確認要」として記録する。承認は**変更された対象には及ばない**。
- **ルート検証は実体まで行う**: `fs.realpathSync` でシンボリックリンク・ジャンクションを解決したうえで、許可ルート配下であることを確認する。
- **保存先を 2 系統に分ける**:
  - **診断用ログ**（`gmail-ingest/logs/YYYY-MM-DD.json` / `summary.json`）: 件数・真偽・種別のみ。**パスもファイル名も書かない**（§4.7）。
  - **削除用の非公開台帳**（`gmail-ingest/state/cleanup-plans/<plan_id>.json`）: 実パスとハッシュを持つ。`state/` 配下なので Git 管理外。**削除の完了（または計画の失効）をもって削除する**。保持期間は最大 30 日。
- 承認は**1 回の削除実行で消費**し、`state/cleanup-enabled` と計画台帳を削除する。追加で削除する場合は毎回新しい計画と承認を要する。
- **この消費は一括削除の系統に限られる。** `state/auto-cleanup-enabled`（定常の自動削除。§4.6-1）には触れない（第3回レビュー R3-02）。承認の消費によって週次の自動削除が止まってはならない。

受入（§8.3-16 に追加）: **同日の計画再生成・計画差し替えでは削除 0 件**。**定常ログへの ID 混入 0 件**。

- `credit-card-tracker/quarantine/gmail-import` の内容がある隔離は、現行の一括・定常の両経路で保持する。
- 旧本文 JSONL の存在だけでは取り込み成功を判定できない。取得元の照合に必要な資料は §4.6-2 の再開条件を満たすまで保持する。

#### 4.6-3 アクセス権限取り消し時の手順（Addendum 2(d) 対応）

OAuth のアクセスを取り消した場合、または `gmail-ingest` の運用を終了する場合に実行する手順を `gmail-ingest/README.md` に文書化する。コードでの自動化は Phase 1 では行わない（取り消しの検知を自動化すると誤削除のリスクが大きい）。

**前提（レビュー P2-03）**: **§10-10 の方針を決めてから実施する。** 起票時の列挙は対象が漏れていた。以下は漏れを補った完全な対象一覧で、**処理順もこの順に固定する**（取得を止める → 認証を断つ → 中間物 → 業務データ → 派生物・バックアップ → ビルド出力 → 記録）。

1. **取得の停止**: タスクを `unregister-task.ps1` で解除する。旧 Codex Automation が有効なら併せて停止する。`/amazon-import` など手動入口も停止する（§4.9-1）。
2. **認証**: `gmail-ingest/data/gmail-auth/oauth.json`、各アプリの `data/gmail-auth/oauth.json`。
3. **中間ファイル**: 本文 JSONL、`candidates.json`、`typeA-ids.json` / `typeB-ids.json`、**`ids.json`**、**`manifest.json`**、**年月別の過去取得ディレクトリ**（`credit-card-tracker/data/gmail-staging/<YYYY>/<YYYY-MM>/<provider>/`。`tools/gmail-fetch-local.mjs:153–160,184–188`）、`import-<provider>-<tag>.json`、隔離 JSON、`quarantine/gmail-import/`、`parse-failures.json`。
4. **（業務データに触れる前）公式データの可用性と再構築の試行**（第2回レビュー R2-10 により順序を前倒し）: Amazon 公式 CSV エクスポート由来のデータは Workspace API 経由で取得していないため 2(d) の対象外で、**保持してよい**。公式 CSV から再構築する案 (d) を採る場合は、**この時点で公式エクスポートファイルを読み取り、再構築を試行して成功することを確認する。** 入力が欠損していれば、**独立データを失う前に手順を中止する**。
5. **（業務データに触れる前）復元セットの作成**: §7-1 の手順で、現時点の CSV・SQLite・state を 1 世代として保存する。**この復元セット自体も失効時の対象台帳に含める**（R2-15。Gmail 由来データを含むため、手順 8 で扱う）。
6. **業務データ（user data）**: `amazon-tracker/public/data/orders.csv` の Gmail 由来行、`credit-card-tracker` の SQLite。`orders.csv` の Gmail 由来行の識別手段は §10-10 で決める。
   **SQLite の扱い（R2-10）**:
   - **全体を廃棄できる条件**: 当該 DB に Gmail 由来以外の独立データが**無い**と確認できる場合。`credit-card-tracker` の取引は現状すべて Gmail 由来のため、この条件を満たす見込み（実装時に確認する）。満たす場合は **DB ファイルごと廃棄**し、スキーマだけを作り直すのが最も確実。
   - **混在する場合に削除するテーブル**: `transactions`（Gmail 由来行）、`transaction_sources`、`gmail_fetch_messages`、`parse_failures`、`import_runs`（診断 `note` を含む。§4.7-1）、および `email_messages` **自体**（件名・送信元・メッセージ ID を保持しているため、行削除では足りず**テーブルの内容を全消去する**）。
   - **保持するデータ**: Gmail 由来でないと確認できたもののみ。判定できないものは**廃棄側に寄せる**（2(d) は保持を禁じているため）。
   - **物理的残存**: WAL / SHM を含めて対象由来データを除去する。行削除だけで足りない場合は**クリーンな DB への再構築**を行う（§4.7-1）。
7. **バックアップ**: `amazon-tracker/backups/orders/*.csv`、`backups/orders/isolated/`、DB バックアップのうち Gmail 由来データを含むもの。
8. **復元セット**: 手順 5 で作ったものを含め、`gmail-ingest` の全復元セット世代（§7-1）。
9. **ビルド出力**: **`amazon-tracker/dist/data/orders.csv`**（この作業ツリーに実在することを確認済み）。削除後にビルドし直す場合は、再ビルドの入力が削除済みの `public/data/orders.csv` であることを確認する。
10. **記録**: 実施日時、対象別の削除件数、保持したものとその理由。個人データは記録しない。

コードでの自動化は Phase 1 では行わない（取り消しの検知を自動化すると誤削除のリスクが大きい）。合成データを入れて本手順と再ビルドを実行し、**対象由来データの残存 0 件**（元メールの識別子を含む）と**独立した公式データの保持**を確認する（§8.3-17）。

### 4.7 実行サマリとログ

`gmail-ingest/logs/YYYY-MM-DD.json` に追記し、`logs/summary.json` を最新 1 回で上書きする。

**永続ログは「許可した値から生成する」方式にする（レビュー P2-02 反映）。** 起票時は API エラーの先頭 200 文字と相対パスの記録を許していたが、両アプリの fetch は API のエラー JSON を例外に含め、カードの例外には**メッセージ ID 入りのものがある**うえ**隔離ファイル名にも ID を使う**（`tools/gmail-import-apply.mjs:66,381–386`）。禁止キー名だけを見る試験では値への混入を検出できない。

記録する項目（**この一覧にある値だけを組み立てて出力し、子プロセスの出力文字列をそのまま転記しない**）:

- 実行開始・終了時刻、総所要時間、終了コード、実行枠（`slot`）
- ジョブ名、ステップ名（固定の列挙値）、終了コード、リトライ回数、`last_outcome`（§4.4-2 の列挙値）
- 件数のみ: 検索通数、取得通数、候補行数、追記/登録件数、重複スキップ件数、除外件数、隔離件数、失敗件数
- 検証結果: `validation.ok`、CSV 列数チェック結果、空 Order ID 件数、`log_validation.status`、§4.3-1 の照合項目ごとの真偽
- 状態更新: 更新前後の `confirmed_through`、更新したか否か、欠落期間の日数
- 削除・保持したファイル数（**種別と実ルート単位の集計のみ。個別のファイル名・パスは書かない**）
- **エラーは分類コードと HTTP ステータスだけ**: `auth` / `network` / `rate_limit` / `parse` / `validation` / `verify_mismatch` / `output_mismatch` / `timeout` / `lock` / `unknown` と、あれば HTTP ステータス番号。**例外メッセージ本文は永続ログへ書かない**（stderr には出るが、stderr はファイルへ保存しない）

**書かないもの**: メール本文、件名、商品名、注文番号、取引明細、金額の内訳、住所、氏名、追跡番号、Gmail メッセージ ID、隔離ファイル名、例外メッセージ、token / client_secret / refresh_token / `client_id`、アカウントのメールアドレス。

**削除計画は定常ログに置かない（第2回レビュー R2-08）**: 実パスを持つ計画は `state/cleanup-plans/<plan_id>.json`（非公開台帳）へ分離する。定常ログには件数・真偽・種別のみを出す（§4.6-2a）。

#### 4.7-1 子 CLI 側の永続化と DB の物理的残存（第2回レビュー R2-15）

ランナー側を許可リスト方式にしても、**子 CLI による永続化は残る**。`credit-card-tracker/tools/gmail-import-apply.mjs:418–435` は**例外メッセージそのものを SQLite `import_runs.note` に書き込む**。親が stderr を保存しなくてもこれは残る。また `tools/gmail-raw-payload.mjs:96–101` は SQLite を **WAL モード**で開くため、§4.6-3 の行削除だけでは **WAL / SHM やDB 内の未使用ページ**に以前のデータが残らないことまでは保証できない。

- **出力を 4 系統に区別して扱う**: ①ランナーのログ（許可値のみ） ②**子 CLI の日次ログ** ③**SQLite の診断用 `note`** ④タスクスケジューラの出力。
- **③の診断欄の例外本文を、許可された分類コード等へ置き換える**（`gmail-import-apply.mjs` の該当箇所を変更する。§2.1 IN / §4.9 / §6）。
- **②④についても、永続化される先と内容を一覧にし、例外本文を含まないことを確認する。**
- これは**業務目的に必要なメール ID や隔離データまで日常運用中に一律削除する要求ではない**。対象は診断記録に混入する値である。
- **権限取り消し時**（§4.6-3）は、**全接続を停止**したうえで、WAL / SHM を含めて対象由来データを除去する。行削除だけで足りない場合は**クリーンな DB への再構築**（必要なテーブルだけを新しい DB へ移す）を行う。**SSD 等の物理媒体の完全消去を保証するものではなく、その必要性は別途判断する。**

受入: ダミーの ID・件名・認証文字列を例外に混入させ、**親子の診断ログと DB の診断欄に残存しない**ことを確認する。

`summary.json` は「一箇所で両アプリの取り込み状況を確認する」要求を満たす成果物であり、個人データを含まないため、必要なら後続フェーズで 1 枚の HTML 表示を足せる（Phase 1 では JSON のみ）。

### 4.8 タスクスケジューラ登録

`task-scheduler-register` スキルの規約に従う。

| 項目 | 値 |
|---|---|
| タスク名 | `\my-app2\GmailIngest-Weekly` |
| トリガー | **毎週日曜 22:00（確定）**。現状 cc = 土 22:00 / amazon = 日曜を日曜 22:00 に統一する |
| 追加トリガー | **ログオン時トリガー**と**起動時トリガー（BootTrigger）**を併設し、いずれも「未完了の実行枠があれば実行」で判定する（下記 §4.8-1） |
| 逃した実行の回収 | タスク設定の **StartWhenAvailable（予定時刻を逃した場合に直ちに開始）を有効**にする |
| 実行権限 | **ログオン中のユーザー（確定）**。既存の `\my-app2\` 配下タスク（`BackupLedger-Import`、`process-watcher-sweep` 等 7 件）と同じ権限。SYSTEM は `data/` のユーザー権限と OAuth ファイルの扱いが変わるため採らない |
| 実行内容 | `C:\Program Files\nodejs\node.exe`（確認済み。Node v24.22.1）+ `D:\my-app2\gmail-ingest\run.mjs`。作業ディレクトリは `D:\my-app2\gmail-ingest` |
| 条件 | ネットワーク接続が利用可能な場合のみ開始。AC 電源条件は付けない |
| 設定 | 最長実行時間 2 時間、失敗時は 30 分後に 1 回再試行（§4.5 の `permanent` は終了コード 5 で再実行しない）、既に実行中なら新しいインスタンスを開始しない |
| スクリプト | `scripts/register-task.ps1` / `scripts/unregister-task.ps1`（冪等。既存タスクがあれば更新）、`scripts/preflight-cutover.ps1`（§4.8-2） |

#### 4.8-1 実行枠による未実行の判定（レビュー P2-01）

起票時は「前回成功から 8 日以上経過していれば実行」としていたが、**この条件では回収できない**。前週日曜 22 時に成功し、今週日曜 22 時に PC が停止していて月曜朝に復帰した場合、経過は 8 日未満になる。また PC の起動はスリープ復帰時には発生せず、起動時に対話ユーザーがいる保証もない。

- 判定は**経過日数ではなく「実行枠（slot）」の比較**で行う。`run.mjs` は現在時刻から **直近の予定枠（最後に到来した日曜 22:00）** を算出し、`state/last-run.json` の**完了済み枠**と比較する。未完了ならその枠として実行し、完了済みなら即 0 終了する。
- **試行枠と完了枠を分けて記録する（第2回レビュー R2-09）**。初回反映時は `last_run.slot` 1 つだったため、**失敗時にも枠が更新され、同じ枠の再試行が即 0 終了しうる**状態だった。
  - `attempted_slot`: その枠で実行を試みたことの記録。**枠の完了扱いには使わない。**
  - `completed_slot`: **全ジョブが `success` のときだけ**記録する。`partial` / `gap_pending` / `transient` / `permanent` / `not_run` では更新しない。
  - **認証失敗（終了コード 4）・ロック競合（3）・人の確認待ち（5）では、`attempted_slot` も `completed_slot` も更新しない**（実行していないため）。
- 枠は `YYYY-MM-DD` 形式（その枠の日曜の日付）で記録する。確認済み期間とは別に持つ（§4.4）。
- トリガーは 3 系統を併設する。いずれも同じ `node run.mjs` を同じ引数で起動し、実行するかどうかは上記の枠判定だけで決める（引数で挙動を分けない）。
  1. **週次**: 毎週日曜 22:00。`StartWhenAvailable` を有効にし、予定時刻に PC が停止していた場合は復帰後に開始させる。
  2. **ログオン時**: `InteractiveToken` で動作するため、対話ユーザーのログオンを確実な契機として使う。
  3. **起動時（BootTrigger）**: 起動時に対話ユーザーがいない場合があるため、これ単独には依存しない。ログオン時トリガーとの二重起動は §4.5 のロックと枠判定で無害化する。
  4. **ネットワーク復旧時（R2-09）**: 上記 1〜3 はいずれも**ログオン済みのままネットだけが戻る場合に発火しない**。`RunOnlyIfNetworkAvailable` で見送られた枠を回収するため、**ネットワーク接続イベントのトリガー**（イベントログ `Microsoft-Windows-NetworkProfile/Operational` のイベント ID 10000）を併設する。
- **回収期限**: 未完了枠は**次の枠が到来するまで**に回収する。次の枠が来た時点で未完了のままなら、古い枠は閉じずに `last_outcome` を残したまま新しい枠として実行し、確認済み期間の欠落として §4.4-1 で回収する（枠の未完了とデータの欠落を別に追跡する）。
- 受入（§8.3-18 を差し替え）: **日曜夜停止 → 月曜朝ログオン / スリープ復帰 / ネット回復 / 定刻起動**の 4 条件を実タスクで各 1 回。加えて **週次枠内で「失敗 → 再起動 → 成功 → 再起動」の順に実行し、成功した回だけ枠が閉じる**こと。

#### 4.8-2 旧 Automation からの切替手順（レビュー P2-05）

起票時は「停止と登録を同一作業内で完了させる」としか書いておらず、**旧ジョブの起動予約・実行中プロセスと重ならない保証がなかった**。§6 #16–18 の順序では、新ランナーの本番実行から登録完了までの間に旧 Automation が有効なままになりうる。

**第2回レビュー R2-06 により順序を訂正した。** 初回反映時は「①旧ジョブの完了を待つ → ②無効化」の順で、**確認と無効化の間に旧枠が開始できた**。§6 も本番データを使う新ランナーの実行（#20）を旧 Automation 停止（#22）より先に置いており、診断専用化（#27）も後だったため、**移行中に旧手動入口が使用できる**状態だった。

`scripts/preflight-cutover.ps1` が次の順に進める。**各段階で失敗しても二重起動しない**よう、前段が完了しない限り次へ進まない。

切替台帳 `state/cutover.json` に `stage`・`at`・`generation` を記録する。段階は `isolation-verified` → `old-disabled` → `old-drained` → `snapshot-verified` → `first-run-verified` → `enabled` の順に進む。本番タスク登録の前提は `first-run-verified`。切り戻し時は新タスクを解除して `new-disabled` を記録する。隔離試験の切替では試験用台帳を使う。

1. **隔離試験の完了を確認する**（§8.1 / §8.3 の隔離試験が pass していること。本番データに触れる前の門）。
2. **旧経路の「新規起動」を先に無効化する**: 旧 Codex Automation 2 本を無効化し、`/amazon-import` と Codex 取込スキルの診断専用化（§4.9-1）を**この時点で反映済み**にする。無効化の反映を再確認する。
3. **既に受理済み・実行中の処理の完了を確認する**: 無効化してから、旧ジョブの実行中プロセスの不在と、受理済みキューが残っていないことを確認する。**完了を待つのは無効化の後**。
4. **最終状態を引き継ぐ**: `amazon-tracker/gmail-import-rules.md`「最終取り込み状況」と `credit-card-tracker/logs/gmail-import/` から確認済み期間を読み、`state/last-run.json` と照合する。旧側が新しければ旧側を採用する。**復元セット（§7-1）をここで 1 世代作成する。**
5. **新ランナーの本番 1 回を人が実行する**（§9 を確認。この時点で削除は無効）。
6. **週次タスクを有効化する**。
7. **切り戻し（逆順）は無条件には行わない**: 新タスク無効化 → 完了待ち → 旧経路の有効化。**旧 Codex Automation の有効化は、実行日が 2027-02-01 より前で、かつ人の明示的な承認がある場合のみ**許す（§4.9-1 / §7）。それ以降は旧経路を使わず、人が直接 CLI を実行する運用へ切り替える。スクリプトは日付と承認フラグを検査し、条件を満たさない場合は旧経路を有効化せずに終了する。

**旧 Automation の確認・停止場所**: Codex Automation のカードは Codex 側の画面で管理されており、**PowerShell からは操作できない**。したがって手順 2・3 のうち旧 Automation に関する部分は**ユーザー自身が Codex の画面で無効化と実行中の不在を確認**し、スクリプトはその確認結果の入力（確認済みフラグ）を受け取って次へ進む。スクリプトが自動判定できるのは Windows タスク側だけであることを `README.md` に明記する。

試験は隔離した `state` / DB / CSV と**試験用タスク**で行い、10 日前の状態や障害を再現する。**本番の正本 state を書き換える手順を実機試験に含めない。**

受入（§8.3-20 を差し替え）: 停止前後に旧ジョブが始まるケース、**新ランナー初回失敗**、期限後の切り戻しを試験し、**実行主体が重ならない**こと。

### 4.9 既存 2 アプリ側の変更

**`amazon-tracker`**

| ファイル | 変更内容 |
|---|---|
| `tools/gmail-fetch-local.mjs` | **①認証**: `SHARED_AUTH_FILE` 定数、`shouldRepairDefaultAuth`、`copyAuthFile`、`getAccessTokenWithRepair` の修復分岐を削除。認証解決は §4.2-3 の順のみ。`--check-auth` の出力から `repaired_from` を削除。**②`--check-auth` の出力へ `account_fingerprint`（アカウント識別子の正規化＋SHA-256。値そのものは出さない）を追加**（§4.2-1。R2-04）。**③`--ingest-status`** 指定時の異常終了は `status` と取得できた `http_status` を JSON で返す。 |
| `tools/gmail-import-run.mjs` | **①`data/.import.lock` の取得を「既存 CSV を読む前」に追加**（§4.5-1。R2-03。`GMAIL_INGEST_LOCK_TOKEN` が一致する場合は取得も解放もしない）。**②`replaced_typeB_summary_rows` と置換した実行の出力**。**③`--summary-proof <file>`** には既存行のヘッダーと列値をハッシュ化した SHA-256 の配列を渡す。旧サマリと証明できる行だけを置換し、不明な行は保持する（§4.3-1b。R2-13）。 |
| `tests/gmail-fetch-local.test.mjs` | 認証フォールバックに関するケースを削除し、「明示 `--auth-file` 以外では他リポジトリを参照しない」ことを検証するケースへ置き換え。**`account_fingerprint` の出力と、別アカウント・欠落時の扱いのケースを追加** |
| `tests/`（`gmail-import-run` 系） | **ロック取得・置換行集計・保留の回帰ケースを追加**（§6 #19） |
| `package.json` | version を `0.2.0` へ。スクリプトの追加・削除はしない |
| `gmail-import-rules.md` | §Codex Automation 運用 → §定期実行（`gmail-ingest` 経由）へ改訂。自動コピーの記述を削除。「最終取り込み状況」を人間向け記録と明記し、機械可読の正本を `gmail-ingest/state/last-run.json` と記載。「amazon-tracker を Codex で修正・確認する場合、作業前に Gmail 差分取り込みを先に実行する」という指示を削除（AI に取得を起動させない） |
| `README.md` | 定期実行方法と障害時の手順を `gmail-ingest` 基準へ更新 |
| `docs/実装ログ.md` | Phase 8 として起票・締め |

**`credit-card-tracker`**

**起票時の「コード変更なし」は撤回する（第2回レビュー R2-02 / R2-03 / R2-12 / R2-15。第3回レビュー R3-01 で §2.1 IN・§6 #16–18 と同期）。** 認証は `--auth-file` に既対応のため変更不要だが、排他・利用日下限・集合照合・診断欄の 4 点で 3 ファイルの変更が必要になった。

| ファイル | 変更内容 |
|---|---|
| `tools/gmail-import-apply.mjs` | **①DB 書込み前に `data/.import.lock` を取得**（§4.5-1。R2-03。`GMAIL_INGEST_LOCK_TOKEN` 一致時は取得も解放もしない）。**②`import_runs.note` は許可された分類コード等で記録**（§4.7-1。R2-15）。**③`--ingest-evidence`** 指定時は集合照合用の `applied_ids` を返す。 |
| `tools/gmail-raw-payload.mjs` | **①取得履歴の書込み前に同じロックを取得**（§4.5-1。R2-03）。**②`--business-from <YYYY-MM-DD>`** は利用日の下限。省略時は従来の `--from` から決める（§4.4-1）。**③`--ingest-evidence`** 指定時は集合照合用の `payload_ids` を返す。 |
| `tools/gmail-import-incremental.mjs` | **①`--business-from <YYYY-MM-DD>`** を payload へ渡す。**②`--ingest-run-dir <絶対パス>`** を指定するとランナー用の経路となり、単独 provider・`incremental`・利用日下限を必須とする。実行別ディレクトリに成果物を置き、受信期間の検索と、検索・取得・payload・適用の ID 集合を親へ返す（§4.3-2、§4.4-1）。ID 集合は定常ログに永続化しない。 |
| `tests/`（parser / import / automation） | **ロック取得・新引数・ID 出力・`note` 置換の回帰ケースを追加**（§6 #19） |
| `package.json` | version を `0.1.2` へ |
| `README.md` | L35 / L67 の Codex Automation 記述を `gmail-ingest` 経由へ改訂 |
| `gmail-import-rules.md` | 同趣旨の記述があれば改訂（実装時に突合） |
| `docs/実装ログ.md` | 新規フェーズとして起票・締め |

**親リポ**

| ファイル | 変更内容 |
|---|---|
| `.claude/CLAUDE.md` §7 | 担当区分を改訂: 「定期的な自動取り込みは `gmail-ingest` + Windows タスクスケジューラが主担当。**AI（Codex / Claude）は Gmail 取得を起動しない**」。`/amazon-import` の扱いは §4.9-1 に従う |
| **`.claude/commands/amazon-import.md`** | **改訂（レビュー P1-08）**。現行の L38–56 / L73 は Markdown を読んで REST 取得 CLI と apply を動かし旧状態を更新する。取得・適用・状態更新の手順を**削除**し、`gmail-ingest/logs/summary.json` と `state/last-run.json` を読んで状況を説明する診断専用コマンドへ変更する |
| `AGENTS.md`（存在する場合） | 同趣旨を反映。Codex 側の取込スキル（`codex-skills/my-app2-gmail-import-ops`）の実行指示からも Gmail 取得の起動を外す |
| `PROJECT_OVERVIEW.md` | `gmail-ingest` を追加 |
| `PORTS.md` / `ports.json` | **変更なし**（ポートを使わない）。この判断を `gmail-ingest/README.md` に記録 |
| `docs/設計書インデックス.md` | 本設計書を 1 行追加 |

**Obsidian**（CLAUDE.md §8）: `Projects\D-my-app2.md` / `my-app2 プロジェクト一覧.md` / `my-app2 AI運用ルール.md` を更新する。転記するのは概要・判断理由・代表コマンド・重要パス・検証結果・注意点のみ。

#### 4.9-1 取得を起動する主体の一覧（レビュー P1-08）

起票時は §9 で「取得経路から AI を排除」を受入条件にしながら、§4.9・§5 で Claude の `/amazon-import` を残し、§7 で旧 Codex Automation 2 本の再有効化を指定していた。**現行の `.claude/commands/amazon-import.md:38–56,73` は Markdown を読んで REST 取得 CLI と apply を動かし旧状態を更新する**ため、この経路が残る限り受入条件は成立しない。定期タスクの親プロセス 1 件を調べても検証できない。

Addendum 項目 1 は、ツール自体が AI である場合に加え、**AI によって駆動される場合も対象に含める**（2026-11-25 確認）。旧構成についての個別判断は未取得という §1.1 の留保を踏まえても、自ら選んだ運用方針と矛盾するため、経路ごとに主体を固定する。

| 経路 | 取得を指示する主体 | Gmail 取得 | 参照する状態 | 更新する状態 | 排他 |
|---|---|---|---|---|---|
| 定期実行（`\my-app2\GmailIngest-Weekly`） | タスクスケジューラ（非AI） | する | `state/last-run.json` | `confirmed_through` / `last_run` | §4.5 の両ロック |
| 欠落回収（`run.mjs --gap-only`） | **人が直接起動** | する | 同上 | 同上 | 同上 |
| 障害復旧（各アプリの CLI を直接実行） | **人が直接起動** | する | 同上 | **人が `run.mjs` 経由で反映**（CLI 単体では state を更新しない） | 同上（既存 CLI 側にロック取得を追加。§4.5） |
| 一度限りの復旧（`--type-b-ids-file` / `--amount-fix`） | **人が直接起動** | する | 既存ルールに従う | `confirmed_through` を進めない | 同上 |
| 診断・報告（`/amazon-import` 改訂後、Codex 取込スキル） | AI（Claude / Codex） | **しない** | `logs/summary.json`、`state/last-run.json`（読み取りのみ） | なし | 取らない（読み取りのみ） |
| 期限後の切り戻し | **人が直接起動**（`preflight-cutover.ps1` の逆順） | する | §7 | §7 | §4.5 |

- **旧 Codex Automation の再有効化は、2027-02-01 以降は切り戻し手段として使わない**（§7 のロールバック方針を改訂）。それ以前の期間に限り、人が明示的に判断した場合のみ許す。
- AI が読んでよいのは `gmail-ingest/logs/summary.json` と `state/last-run.json`。**どちらも個人データを含まない**（§4.7）。
- 手動復旧でも**同じ状態ファイルと同じ排他**を使う。別の状態を持たせない。
- 受入: 定期・手動・障害復旧・期限後の切り戻しの各ケースで、上表の主体・状態・排他が実際にその通りであることと、**旧 AI 起動経路が有効にならないこと**を、親リポのコマンド本文・スキル本文・Automation 実行指示・切り戻し手順の 4 点を対象に確認する（§8.3）。

---

## 5. 既存機能の非破壊（チェックリスト）

- [ ] `public/data/orders.csv` のヘッダー 28 列・全行 28 列・空 Order ID なしが維持される
- [ ] `orders.csv` のレコード数が、取り込み件数以外の理由で変化しない
- [ ] 行単位重複判定キー（6 項目）の判定結果が変わらない
- [ ] Type A の金額欠落・0 円候補の追記禁止、金額差分のみの候補の隔離が変わらない
- [ ] Type B の複数商品の行分割・按分（同一 Order ID の行合計＝注文総額）が変わらない
- [ ] 予約受付通知の除外（`-subject:"お客様の予約注文"` 等）が変わらない
- [ ] 取り込み前バックアップ（`backups/orders/`）が従来どおり作成される
- [ ] 一時 CSV 検証に失敗した場合、`orders.csv` 本体を書き換えない
- [ ] SQLite のスキーマ・`transactions.fingerprint` による重複排除が変わらない
- [ ] `credit-card-tracker` の 3 プロバイダ（三井住友 / 楽天 / e-kenet JCB）の検索クエリと 45 日ルックバックの**算出ロジック自体**が変わらない（`gmail-ingest` は範囲が足りるかを外側で判定するだけで、`provider-config.mjs` を変更しない）
- [ ] 正常処理済み Gmail 本文の再取得省略（v0.1.1 の最適化）が維持される
- [ ] 両アプリの集計 UI・画面表示・グラフ・ビルド成果物が変わらない
- [ ] 手動実行経路（`npm run gmail:fetch-local` / `gmail:import:apply` / `gmail:import-incremental` / `--type-b-ids-file` / `--amount-fix`）が**人による直接実行として**従来どおり動作する
- [ ] `/amazon-import` は診断専用へ変更する（§4.9-1）。**これは意図した挙動変更であり、非破壊の対象外**
- [ ] 既存 CLI 5 ファイルの変更（§2.1 IN の表）が、重複判定・按分・隔離・CSV 検証・バックアップのロジックを変えない
- [ ] **Type B 旧サマリ行の置換規則を「確定できない行は保留」へ変更する場合は、Phase 1 の例外として明示する**（§4.3-1b。R2-13。これは意図した挙動変更であり、非破壊の対象外）
- [ ] **`import_runs.note` の例外本文を分類コードへ置き換える変更**は診断欄のみに及び、業務データに影響しない（§4.7-1。R2-15）
- [ ] `data/` / `backups/` / `logs/` / `oauth.json` が Git 管理外のまま（`gmail-ingest` も同様）

---

## 6. 変更ファイルと差分の粒度（実装順）

CLAUDE.md §5 に従い 1 ファイル単位で生成する。各ステップは独立してコミットできる。

| # | 対象 | 内容 |
|---|---|---|
| 1 | `gmail-ingest/`（新規） | **2026-11-25 に一部実施済み**: `D:\my-app2\gmail-ingest\` 作成、`.gitignore` 作成、ローカル `git init`（main、コミットなし）、`docs/` へ本設計書と `設計書インデックス.md` 配置、親リポ `.gitignore` へ `/gmail-ingest/` 追加。**残り**: 初回コミットと GitHub リモートの作成（`new-app-bootstrap` スキル）。ポート予約は不要 |
| 2 | `gmail-ingest/package.json`, `README.md`, `docs/実装ログ.md` | 足場（`docs/設計書インデックス.md` は作成済み） |
| 3 | `gmail-ingest/lib/exec.mjs` | 子プロセス実行（`process.execPath` 直実行）・stdout JSON 回収・タイムアウト・子ツリー停止確認（§4.2-2 / §4.5） |
| 4 | `gmail-ingest/lib/env.mjs` | 子プロセス環境の構築・出力先の固定と検証（§4.2-1） |
| 5 | `gmail-ingest/lib/lock.mjs` | 排他ロック（原子的作成・所有者のみ解放・書込み対象側ロック。§4.5） |
| 6 | `gmail-ingest/lib/state.mjs` | 状態の読み書き（§4.4。`schema_version: 2`・原子的置換・検証・欠落判定） |
| 7 | `gmail-ingest/lib/log.mjs` | ログ・サマリ（§4.7。許可した値からの生成） |
| 8 | `gmail-ingest/lib/verify.mjs` | 適用前後の照合（§4.3-1） |
| 9 | `gmail-ingest/lib/cleanup.mjs` | 削除規則（§4.6。既定無効・パス検証・過去分の保留） |
| 10 | `gmail-ingest/jobs.mjs` | ジョブ定義（§4.3。欠落回収の分岐を含む） |
| 11 | `gmail-ingest/run.mjs` | 入口。枠判定 → 認証・アカウント・出力先の事前チェック → 逐次実行 → 照合 → 状態更新 → サマリ → 終了コード（クリーンアップは既定無効） |
| 12 | `gmail-ingest/tests/*.test.mjs` | §8.1 のテスト |
| 13 | `gmail-ingest/lib/restore-set.mjs` | 復元セットの作成・検証（§7-1。R2-07） |
| 14 | `amazon-tracker/tools/gmail-fetch-local.mjs` | 認証自動コピー経路の削除。`--check-auth` に `account_fingerprint` を追加（§4.2-1。R2-04） |
| 15 | `amazon-tracker/tools/gmail-import-run.mjs` | **既存 CSV を読む前**のロック取得。`replaced_typeB_summary_rows` と置換した実行の出力。旧サマリと確定できない行の保留（§4.5-1 / §4.3-1b。R2-03 / R2-13） |
| 16 | `credit-card-tracker/tools/gmail-import-apply.mjs` | DB 書込み前のロック取得。`import_runs.note` の例外本文を分類コードへ置換（§4.5-1 / §4.7-1。R2-03 / R2-15） |
| 17 | `credit-card-tracker/tools/gmail-raw-payload.mjs` | 取得履歴書込み前のロック取得。**利用日下限の引数**。集合照合用の ID 出力（§4.4-1 / §4.3-2。R2-02 / R2-03 / R2-12） |
| 18 | `credit-card-tracker/tools/gmail-import-incremental.mjs` | **利用日下限の引数**（`--from` の意味は変えない。R2-02） |
| 19 | 既存テストの更新 | `amazon-tracker/tests/gmail-fetch-local.test.mjs`（認証フォールバック削除・`account_fingerprint`）、両アプリのロック取得・新引数・置換保留の回帰 |
| 20 | `gmail-ingest/data/gmail-auth/oauth.json` ＋ `--register-account` | 正本の配置（§10-1 確定済み）。**アカウント登録は独立した人の操作**として実行（§4.2-1。R2-04） |
| 21 | `gmail-ingest/state/last-run.json` | 初期値投入。Amazon は `2026-11-20` / `2026-11-20`。**カード 3 社は旧ログから確認済み期間末を特定**（特定できない社は空にし初回を欠落回収とする）。**`business_from`** を既存 CLI の既定値から転記（§4.4。R2-02）。**投入前に非正本の `amazon-tracker/logs/gmail-import/last-run.json` と突き合わせ、そこに初期値より古い日付があればユーザーへ報告して判断を仰ぐ（自動では採らない。§4.4）** |
| 22 | **隔離試験** | §8.1 の全件と §8.3 の隔離試験（試験用ルート一式・`--profile`）。**本番データに触れる前の門**（§4.8-2 手順 1。R2-06 / R2-11） |
| 23 | 親リポ `.claude/CLAUDE.md` §7, **`.claude/commands/amazon-import.md`（診断専用へ改訂）**, `AGENTS.md`, `codex-skills/my-app2-gmail-import-ops` | §4.9-1 の主体固定。**切替より前に反映する**（移行中に旧手動入口を使えないようにするため。R2-06） |
| 24 | `gmail-ingest/scripts/register-task.ps1` / `unregister-task.ps1` / `preflight-cutover.ps1` | `task-scheduler-register` スキルで整備（§4.8） |
| 25 | **切替（順序を厳守）** | `preflight-cutover.ps1` で **①隔離試験の完了確認 → ②旧経路の新規起動を無効化（Codex 側はユーザーが画面で実施・確認）→ ③受理済み・実行中の完了確認 → ④最終状態の引継ぎ＋復元セット作成 → ⑤新ランナーの本番 1 回（人が実行。§9 の取り込み項目のみを合格条件とする）→ ⑥週次タスク有効化**（§4.8-2。R2-06） |
| 26 | **§10-10 の方針決定** | `orders.csv` の取得元識別の方針を決める（§4.6-2 手順 2）。資料を保持し、識別策の採用を保留するユーザー判断を記録済み。 |
| 27 | 削除（2 系統） | **ユーザー判断で保留**。一括・定常の両フラグは未配置。再開には §10-10 の決定と [後続の修正設計](修正設計書_Gmail取り込み実装レビュー反映_Phase1_2026-11-26.md) §5.1 の方式決定・受入が必要。 |
| 28 | `amazon-tracker/gmail-import-rules.md`, `README.md`, `package.json` | ドキュメント・バージョン |
| 29 | `credit-card-tracker/README.md`, `package.json` | ドキュメント・バージョン |
| 30 | 親リポ `PROJECT_OVERVIEW.md`, `docs/設計書インデックス.md`, `.gitignore` | 台帳（`repo-ledger-sync` スキル）。**2026-11-25 実施済み・push 済み**（`ae1de4d`） |
| 31 | 各 `docs/実装ログ.md` | フェーズ締め（完了日 / 実装内容 / 反映コミット / 検証結果 / 残課題 / 申し送り / 関連ドキュメント / ステータス） |
| 32 | Obsidian | 関連ノート更新（§4.9）。**2026-11-25 実施済み・push 済み**（移行完了時に「移行前」の記述を更新する） |

---

## 7. リスクと割り切り

| リスク | 対応 |
|---|---|
| 規約解釈が外れる（タスクスケジューラ実行も AI 経由と見なされる等） | 実行経路から AI を実際に除外する設計変更であり、迂回ではない。それでも対象と判断された場合は MCP 移行（§3.2 の保留案）へ切り替える。本設計は取得コードを温存するため、切り替え先の改修範囲が限定される |
| `oauth.json` 正本の切り替えで認証が通らなくなる | §10-1 を確定してから実施。切り替え前に `--check-auth` で検証し、各アプリの既存 `oauth.json` は削除せず残す（即時ロールバック可能） |
| 認証自動コピー削除により、`invalid_grant` 時に自動復旧しなくなる | 意図した変更。`run.mjs` の事前チェックで終了コード 4 と明示的なエラー分類を返し、ログに残す。復旧は人が `oauth.json` を再発行する |
| 状態の正本が Markdown から JSON に変わり、二重管理や取り込み漏れが起きる | 初期値は現在値をそのまま移し、より古い日付が別ファイルにある場合は自動で採らずユーザーへ報告。Markdown は人間向け記録と明記し、`gmail-ingest` は書き換えない |
| ジョブ単位リトライで二重登録 | 両アプリの重複排除で防がれる。`permanent` はリトライ対象外、`transient` でも子ツリー停止とロック解放を確認してから再試行する（§4.5） |
| **同時書込みで CSV が失われる** | 書込み対象ごとのロックを全入口で共有する（§4.5。既存 CLI **3 ファイル**にロック取得を追加: `gmail-import-run.mjs` / `gmail-import-apply.mjs` / `gmail-raw-payload.mjs`）。確認できない場合はロックを保持したまま停止し、人の確認を待つ |
| クリーンアップが消してはいけないファイルを消す | 削除対象を `data/` / `logs/` / `backups/` / `quarantine/` 配下に限定し、アプリルート配下であることを検証。`orders.csv`・`dist/data/orders.csv`・SQLite 本体・ルール文書は対象外。**削除は既定で無効**で、一覧確認と §10-10 の決定を経て明示的に有効化する（§4.6-2）。適用成功を証明できない過去分は削除しない |
| **長期停止後に未取得期間を飛ばす** | 確認済み期間（`confirmed_through`）を両アプリで保持し、検索範囲が覆えない場合は欠落回収か成功保留に分岐する（§4.4-1）。子 CLI の `status=success` を根拠にしない |
| **AI 起動経路が残る／復活する** | 経路ごとに主体を固定し（§4.9-1）、`/amazon-import` を診断専用へ改訂、Codex 取込スキルの実行指示からも取得を外す。2027-02-01 以降は旧 Automation の再有効化を切り戻し手段にしない |
| タスクスケジューラの実行環境差（作業ディレクトリ・`node` パス・PowerShell の `CreateProcessAsUserW failed: 5`） | `node.exe` と作業ディレクトリを絶対パスで固定し、`register-task.ps1` に記録。`gmail-ingest` は PowerShell を介さず `node` 直実行とする |
| 実行時間が長引き、次のトリガーと重なる | 排他ロックで多重起動を防止し、タスク設定でも「実行中は新インスタンスを開始しない」 |
| Standard 上限の超過 | 逐次実行でピークを作らない。§10.2 のコンソール実測を行い、超過が見えた場合のみ Scaled を検討（2027-03-31 まで）。公開ページに REST の Gmail API の具体的上限値がないため、上限内という評価は推定である（§1.1.1） |
| 新規リポジトリを増やすことによる管理コスト | 依存 0・ポート不要・UI なしに抑える。既存 2 アプリのコード変更は **5 ファイル**に限定する（`amazon-tracker` 2 / `credit-card-tracker` 3。内訳は認証経路削除＋`account_fingerprint` 出力 1、ロック取得追加 3、利用日下限の引数追加 2 で、1 ファイルが複数の変更を含む）。**§2.1 IN・§2.2・§4.9・§5・§6 #14–18 と一致させる**（第3回レビュー R3-01）。巻き戻しは下記 (A) の手順による |

**ロールバック方針（レビュー P1-06 / P1-08 反映）**

起票時は「新ランナーの最新開始日を旧 Markdown へ転記し、CSV・DB をバックアップから戻す」としていたが、**時点が一致しない**。Amazon のバックアップは対象行を適用する直前の CSV（`tools/gmail-import-run.mjs:602–604`）なので、11 月の成功後に 10 月のデータへ戻して 11 月の開始日を転記すると、**間の注文は旧運用でも再取得されない**。カード側もバックアップが 45 日窓より古ければ同じ問題が残る。

切り戻しは 2 種類に分け、混ぜない。

**(A) 起動経路だけを戻す（データは戻さない）** — 既定の切り戻し。

1. `preflight-cutover.ps1` の逆順で、新タスクを無効化 → 実行中の完了を待つ → 旧経路を有効化する。
2. **確定済みデータと確認済み期間はそのまま維持する。** `state/last-run.json` は書き換えない。旧 Markdown の「最終取り込み状況」へは、`confirmed_through` の値を**そのまま**転記する（データを戻していないので時点は一致する）。
3. `amazon-tracker/tools/gmail-fetch-local.mjs` の認証変更をリバートする場合は、`oauth.json` の正本の場所も元に戻す。

**(B) データ復元が必要な場合** — 破損や誤適用が判明したときのみ。

1. 新旧**両方の実行を停止**する（タスク無効化＋旧 Automation 無効化＋手動入口の停止）。
2. **整合する組で復元する**: `orders.csv`・SQLite・各検索期間（`confirmed_through`）を**同一時点の組**として選び、まとめて復元する。CSV だけ、DB だけ、状態だけを戻さない。
3. 復元した時点から現在までの**不足期間を再取込する**（`run.mjs --gap-only`）。
4. 再取込後、元の注文・取引の集合と金額が一致することを確認してから、いずれかの経路を再有効化する。
5. 受入: 隔離環境で 2 週以上の成功を作ってから古い世代へ切り戻し、再取込後に集合と金額が一致すること（§8.3）。

**旧 Codex Automation の再有効化は 2027-02-01 以降は行わない**（§4.9-1）。それ以降に (A) が必要になった場合は、`gmail-ingest` を停止したうえで**人が直接 CLI を実行する**運用へ切り替える。`preflight-cutover.ps1` は日付と承認フラグを検査し、条件を満たさない場合は旧経路を有効化しない（§4.8-2 手順 7）。

### 7-1 復元セットの作成手順（第2回レビュー R2-07）

初回反映時は「3 者を同一時点の組で復元する」と書いただけで、**その組を作る手順がなかった**。Amazon の既存バックアップは**CSV 単独の適用直前コピー**、state は一時ファイルからの置換で、**SQLite を整合した形で取得し、同じ時点の CSV・state と関連付けて保管・検証する工程が §6 に無い**。個別バックアップが存在しても、3 点が揃った世代を選べるとは限らない。

**作成するタイミング**: ①切替直前（§4.8-2 手順 4） ②失効手順の業務データに触れる前（§4.6-3 手順 5） ③`--restore-set` を人が明示的に実行したとき。

**手順**（`node run.mjs --restore-set` が行う）:

1. **書込みを止める**: §4.5 の両ロックを取得し、保持したまま以降を行う。
2. **SQLite を整合した形で取得する**: WAL を含む整合コピーを作る（`VACUUM INTO` または SQLite のバックアップ API を使い、ファイルの単純コピーはしない）。
3. **CSV をコピーする**: `amazon-tracker/public/data/orders.csv`。
4. **state をコピーする**: `gmail-ingest/state/last-run.json`。**初回（移行前）は旧状態も含める**: `amazon-tracker/gmail-import-rules.md` の「最終取り込み状況」と `credit-card-tracker/logs/gmail-import/` の該当記録。
5. **1 世代として保存する**: `gmail-ingest/state/restore-sets/<timestamp>/` に上記を置き、`manifest.json` に**各ファイルの SHA-256・取得時刻・取得元パス・ロック保持の記録**を書く。世代は 3 点が揃っていることを manifest で保証する。
6. **復元検証を行う**: 保存直後に、別の一時ディレクトリへ復元して ①SQLite が開けて主要テーブルの件数が取得時と一致する ②CSV が 28 列で行数が一致する ③state が JSON として読めて `schema_version` が一致する、を確認し、結果を manifest に記録する。**検証に失敗した世代は「不完全」と記録し、復元候補に出さない。**
7. ロックを解放する。

**既存の外部バックアップを使う場合**は、manifest 相当の記録（対象・取得時刻・整合性の確認方法・復元検証の結果）を同じ形式で残す。記録がない世代は復元候補にしない。

**保持**: 復元セットは Gmail 由来データを含むため `state/` 配下（Git 管理外）に置き、§4.6-3 手順 8 の削除対象に含める。世代は最新 3 世代を保持する。

受入（§8.3-21 を差し替え）: **この手順が作った世代から開始**し、①**欠損・世代混在を検出して本体に触れる前に止まる**こと ②**正しい世代から全注文・取引を復元できる**こと、の両方を確認する。

---

## 8. テスト・検証

### 8.1 `gmail-ingest` の単体テスト（`npm test`、Node 標準のみ）

- 状態更新: 全ステップ成功**かつ検索範囲が連続**のときのみ `confirmed_through` が実行日の前日へ進む
- **欠落判定**: 固定日付を与え、45 日窓が `confirmed_through` の翌日を覆わない場合に `gap_pending` となり `confirmed_through` が進まない（P1-01）
- 状態維持: ステップ 1 失敗 / 照合不一致 / ステップ 2 失敗 / 適用後照合失敗のそれぞれで状態が変わらない
- 状態書き込み失敗時に非 0 終了し、次回再実行で取り込み漏れが出ない初期値が保たれる
- **`last_outcome` の分類**: §4.4-2 の 6 値それぞれで、再試行の有無と確認済み期間の進退が定義どおり
- **部分成功**: provider 別に成功/失敗を混ぜ、成功した社だけ `confirmed_through` が進む（P2-04）
- **照合**（P1-02）: 注文総額 1,000 円に対し 300 円 × 2 行の合成候補で**不一致を検出**する。正常系では通る
- **環境構築**（P1-04）: `env.mjs` が除去対象の変数を落とし、出力先を固定し、不一致を検出する
- 排他（P1-05）: 原子的作成で二重取得できない、`owner_token` 不一致では解放できない、PID 生存中は 6 時間超でも奪取しない、PID 消滅時は奪取する
- リトライ: `transient` のみ最大 2 回再試行、`permanent`（`validation.ok === false` / 照合不一致 / 出力先不一致）は再試行しない
- **実行枠判定**（P2-01）: 日曜夜停止 → 月曜朝など、経過日数では判定できないケースで未完了枠と判定される
- 終了コード: 0 / 1 / 2 / 3 / 4 / 5 / 6 の各経路
- クリーンアップ（P1-07）: **`state/cleanup-enabled` がなければ削除 0 件**。許可ルート（`quarantine/` を含む）以外とアプリルート外、`orders.csv` / `dist/data/orders.csv` / SQLite / ルール文書は削除しない。適用成功の記録がない過去分と未解決隔離は保留する
- ログ（P2-02）: **禁止キー名の検査だけでなく、ダミーの ID・資格情報・件名を例外メッセージとファイル名に埋め、出力 JSON を値まで検索して一致 0 件**
- **照合式が型別である**（R2-01）: Type A の各行 2,200 円の検体が通り、**行合計 4,400 円との照合を行わない**。Type B は按分和と総計を照合し、商品明細も照合する
- **件数収支に隔離の独立分岐が入る**（R2-01）: 「候補 1 / 追記 0 / 完全一致 0 / 除外 0 / 隔離 1」が合格になる
- **期待行集合と差分照合**（R2-13）: 変更を許可していない行が保持され、旧サマリと確定できない行が保留になる
- **カードの集合照合**（R2-12）: 検索 ID 集合＝処理済み＋今回取得、今回取得＝payload＝適用対象、各 ID の処理結果が分類済みで未分類 0 件
- **受信期間と利用日下限の分離**（R2-02）: 2 つを別引数として渡し、遅着検体が抽出下限で落ちない。確定末が「照合を終えた連続区間の末」になる
- **試行枠と完了枠**（R2-09）: 失敗時に `completed_slot` が更新されない。終了コード 3 / 4 / 5 では `attempted_slot` も更新されない
- **モードの優先順位と混在拒否**（R2-11）: 取得を伴わない操作の同時指定がエラー、`--profile` と本番実体の混在が終了コード 4
- **削除承認の束縛**（R2-08）: `plan_id` 不一致で削除 0 件、対象の変更検出で当該対象を削除しない、`realpath` 解決後のルート検証
- **確定失敗の解除**（R2-14）: 未承認では停止、承認は対象・期間に束縛され 1 回で消費、`confirmed_through` を変更しない。破損・未対応 schema で安全停止し自動生成しない
- **復元セット**（R2-07）: 3 点が揃った manifest を作り、復元検証に失敗した世代を「不完全」として候補に出さない
- 子プロセスはすべてスタブで注入し、**テストで実際の Gmail API を叩かない**。**ただし起動契約（P1-03）だけはスタブで代替できないため §8.3-2 の実プロセス試験で担保する**

### 8.2 既存テストの回帰

- `amazon-tracker`: `npm test`（category / chart / csv-response / gmail-import）が pass
- `credit-card-tracker`: `npm run test:parser` / `test:import` / `test:automation` が pass

### 8.3 実機確認

**前提**: 以下のうち状態・DB・CSV を操作する項目は、**`--profile` で指定した試験用ルート一式と試験用タスク**で行う（§4.1-1）。**本番の正本 state を書き換える手順は実機試験に含めない**（P2-05 / R2-11）。

1. 認証事前チェックのみ: `--check-auth` が `gmail_profile_ok: true`。アカウント照合と出力先照合も通る
2. **子プロセス起動契約**（P1-03。設計上解消済みだが実プロセスで担保）: Windows 実プロセスで ①正常 JSON ②不正 JSON ③JSON 付き非 0 終了 の 3 ケースを通す。**空白を含むパス**（`C:\Program Files\nodejs\node.exe`）と `env.mjs` で絞った `PATH` でも動く
3. **環境・出力先・アカウント**（P1-04 / R2-04）: 異なる合成資格情報を各優先環境変数に入れた場合／欠損正本と有効な環境トークンが同居する場合／別 DB・別 CSV を指す場合。**後 2 者で本番用の確認済み期間が進まない**。加えて**実プロフィール応答を模した A・B** で、初回一致・以後一致のみ通過し、**別アカウントと `account_fingerprint` 欠落は終了コード 4**、業務データ・期間とも不変
4. 取得のみのドライラン: `amazon` ジョブを `--ids-only` で実行し、検索通数が妥当で `orders.csv` が SHA-256 で不変
5. 本番 1 回実行（`state/cleanup-enabled` なし）で §9 の**取り込み項目**を確認し、**削除が 0 件**であること
6. **同一期間での再実行**（P2-04）: **業務行**（`orders.csv` の注文行、`transactions`）の集合と金額が変わらないこと、**履歴行**（`gmail_fetch_messages` ほか）は増えてよいこと、最終サマリの件数、の 3 つを**別々に**検証する
7. **長期停止・遅着・境界の回収**（P1-01 / R2-02）: ①**遅着通知 1 件**が欠けない（利用日 9/25・受信 9/27 の検体） ②**JST 早朝着**の通知が落ちない ③**初期値不明**の社が通常実行で成功扱いにならない ④**60 日の回収を 45 日で中断・再開**。いずれも最終的な取引集合と**各回の確定末**を照合する
8. **Amazon の金額照合**（P1-02 / R2-01）: ①**Type A の 2 商品メール（各行 `Total Amount` 2,200 円）が通る** ②正常な Type B の按分 ③**商品 1 点欠落だが合計は一致する Type B を検出する** ④同一注文の別通知。**適用前の異常では CSV と `confirmed_through` の双方が不変**。隔離だけ 1 件の週が件数収支で合格すること
9. **既存行の非破壊**（R2-13）: ①正規の旧サマリの置換が通る ②**同じ外形を持つ公式 CSV 明細が置換されない（保留になる）** ③同一件数で別行が欠落するケースを検出する ④CSV 置換直後の異常終了からの再試行。異常差分では成功状態・削除許可を進めず、適用前世代と証跡を保持する
10. **カードの集合照合**（R2-12）: 0 件検索／全件処理済み／複数ページ検索／**JSONL の末尾 1 行欠落**／**同件数の別 ID 混入**／1 メール複数取引。**正常な 0 件は成功**し、**欠落・別 ID 混入では確認済み期間を進めない**
11. **部分成功**（P2-04 / R2-05）: **1 社成功直後のプロセス強制終了**／**2 社目で結果 JSON がある解析失敗**／CSV 置換直後の停止／`confirmed_through` 更新後の清掃・ログ失敗。成功した社だけ進み、未着手社は `not_run`、再試行先が正しいこと。⑤**1 社が未承認の `permanent` の状態で定期再起動**し、**当該 1 社のみスキップされ、残りのカード 2 社と Amazon ジョブが正常に実行・更新される**こと。**実行対象のすべてが未承認 `permanent` の場合のみ終了コード 5 で即終了する**こと（R3-03）
12. 認証エラーの再現: 無効な `--auth-file` を渡し、終了コード 4 で `orders.csv` / SQLite が変化しない
13. **排他**（P1-05 / R2-03）: **2 プロセスが別の注文を追加する試験で、再試行完了後に最終 102 行で両注文が存在する**こと。**親終了・子生存中の第三の起動を拒否**すること。`pending_human_review` のロックが自動回収されないこと。手動 apply との競合でも CSV・バックアップに欠落がない
14. **確定失敗の解除**（R2-14）: 確定失敗 → 定期再起動（**未承認なので停止**）→ 原因修正 → 対象を限定した承認 → 再取得成功。未承認の失敗は停止し、**承認済みの対象だけが再開**し、成功時のみ期間が進む
15. **ログと診断欄への値混入**（P2-02 / R2-15）: ダミーの ID・資格情報・件名を**例外とファイル名**に埋め、①ランナーのログ ②子 CLI の日次ログ ③**SQLite の `import_runs.note`** ④タスク出力 を**値まで検索して一致 0 件**
16. **削除の段階と承認の束縛**（P1-07 / R2-08 / R3-02）。隔離環境で照合済みの期限超過分、台帳のない過去分、未解決隔離、解析失敗を混ぜる。両フラグなしなら削除0件。一括承認後は照合済みの適格な対象だけが削除され、計画再生成・対象差替え・承認再利用により対象が増えないことを確認する。定常の有効化試験では照合済みの本文と期限超過の適格分だけが削除され、過去分と未解決分は保持される。一括承認の消費が定常フラグを変更せず、定常ログの ID 混入が0件であることも確認する。過去分の処分に関する追加受入は [後続の修正設計](修正設計書_Gmail取り込み実装レビュー反映_Phase1_2026-11-26.md) §8 を参照。
17. **失効手順**（P2-03 / R2-10 / R2-15）: 合成データを入れて §4.6-3 を実行し、**対象由来データの残存 0 件**（元メールの識別子を含む）と**独立した公式データの保持**。**公式エクスポートの読取り・再構築試行が業務データ変更の前に行われる**こと。入力欠損時に独立データを失わず中止すること。**WAL / SHM・サイドカーファイル・復元セット**も確認対象に含める。`dist/data/orders.csv` の再ビルドも確認
18. **未実行枠の回収**（P2-01 / R2-09）: 日曜夜停止 → 月曜朝ログオン／スリープ復帰／ネット回復／定刻起動の 4 条件を**実タスクで各 1 回**。加えて**週次枠内で「失敗 → 再起動 → 成功 → 再起動」の順に実行し、成功した回だけ枠が閉じる**こと
19. **モードの分離**（R2-11）: 同一枠内での手動回収や清掃計画が**誤って通常取込を起動しない**こと。**隔離実行が本番ファイルを更新しない**こと。本番と試験用ルートの混在が終了コード 4 で拒否されること
20. **切替**（P2-05 / R2-06）: `preflight-cutover.ps1` の各段階で中断しても二重起動しないこと。**停止前後に旧ジョブが始まるケース**、**新ランナー初回失敗**、**期限後の切り戻し**を試験し、**実行主体が重ならない**こと
21. **切り戻しと復元セット**（P1-06 / R2-07）: **§7-1 の手順が作った世代から開始**し、①**欠損・世代混在を検出して本体に触れる前に止まる** ②**正しい世代から全注文・取引を復元できる**。隔離環境で 2 週以上の成功を作ってから古い世代へ切り戻し、`--gap-only` の再取込後に**元の注文・取引の集合と金額が一致**
22. **AI 起動経路の不在**（P1-08）: §4.9-1 の表の各ケースについて、主体・参照/更新する状態・排他が表どおりであることと、**親リポのコマンド本文・スキル本文・Automation 実行指示・切り戻し手順の 4 点**に取得を起動する記述が残っていないことを確認する。タスクスケジューラからの実行でプロセス系列に Codex / Claude が存在しないことも併せて確認する（**親プロセスの確認だけでは P1-08 を検証できない**）

### 8.4 2027-03-31 までの最終確認（課金開始前）

- Workspace API usage developer dashboard で `credit-card-tracker-496602` の使用量が Standard 上限内であること
- 週次処理だけでなく、バックフィル時のピークも確認
- 最新の料金・上限・規約を再確認し、Scaled 変更が不要であることを判断

---

## 9. 受け入れ条件

**合格判定を 3 段階に分ける（第2回レビュー R2-11）**。§6 #25⑤ の「初回本番 1 回」で確認するのは **(1) 取り込みの正常性**のみで、(2)(3) は後続手順の合格条件とする。

- **(1) 取り込みの正常性**（初回本番の合格条件）: 下記のうち `orders.csv` / SQLite / 確認済み期間 / ログ / 排他に関する項目
- **(2) 切替の完了**（§6 #25⑥ の合格条件）: 旧経路の停止、二重実行の不在、AI 起動経路の不在、枠の回収
- **(3) 保存ポリシーの完了**（§6 #26–27 の合格条件）。§10-10 の決定、[後続の修正設計](修正設計書_Gmail取り込み実装レビュー反映_Phase1_2026-11-26.md) §5.1 で採用した方式の受入、失効手順の試験。現在は保留。

---

- [ ] `gmail-ingest` の `npm test` が全 pass
- [ ] `amazon-tracker` / `credit-card-tracker` の既存テストが全 pass
- [ ] `node run.mjs` 1 回の実行で、両アプリの対象メールが漏れなく取り込まれ、SQLite と `orders.csv` に反映される
- [ ] `orders.csv` の CSV 検証が OK（28 列 / 全行一致 / 空 Order ID 0 件 / Type A の金額不正な新規行 0 件）
- [ ] 同一期間の再実行で**業務行**（注文行・取引）の集合と金額が変わらない（履歴行の増加は許容。§8.3-6）
- [ ] 認証エラー・API 制限・ネットワーク障害・解析失敗・CSV 検証失敗・照合不一致・出力先不一致の各ケースで、確認済み期間を進めず、SQLite / `orders.csv` を不正に変更しない
- [ ] 一部処理が失敗した実行が「完全成功」として記録されない（`last_outcome` が §4.4-2 の定義どおり）
- [ ] **長期停止後に未取得期間を飛ばして成功扱いにならない**（§8.3-7）
- [ ] **適用前の照合不一致で CSV と確認済み期間の双方が不変**（§8.3-8）
- [ ] 多重起動と他入口との競合が排他制御で防止され、**同一時点の書き手が 1 つ**（§8.3-13）
- [ ] **初回実行と F #27 の保留中は削除が 0 件**。F #27 を再開する場合は、§10-10 と一括方式の決定を記録し、採用方式に応じて承認済みの対象集合との一致または旧成果物の保持を確認する（§8.3-16、[後続の修正設計](修正設計書_Gmail取り込み実装レビュー反映_Phase1_2026-11-26.md) §8）。
- [ ] 実行ログ・サマリに個人データ・認証情報が含まれない（**値まで検索して一致 0 件**。§8.3-15）
- [ ] **Gmail 取得を起動する主体が §4.9-1 の表どおりで、旧 AI 起動経路が有効にならない**（コマンド本文・スキル本文・Automation 実行指示・切り戻し手順の 4 点を確認。§8.3-22）
- [ ] `/amazon-import` が診断専用へ改訂済みで、取得・適用・状態更新を行わない
- [ ] Codex Automation 2 本が停止済みで、タスクスケジューラと二重実行しない（切替の各段階で中断しても二重起動しない。§8.3-20）
- [ ] 逃した実行枠が 4 条件すべてで回収される（§8.3-18）
- [ ] **Type A の正常な複数商品注文が apply 前に止められない**（照合式が型別。§8.3-8。R2-01）
- [ ] **商品 1 点欠落だが合計が一致する Type B を検出する**（§8.3-8。R2-01）
- [ ] **適用前に存在した行が保持され、旧サマリと確定できない行が自動置換されない**（§8.3-9。R2-13）
- [ ] **カードの検索・取得・適用の ID 集合が一致し、欠落・別 ID 混入で確認済み期間を進めない**（§8.3-10。R2-12）
- [ ] **遅着通知と JST 早朝着の明細が欠けない**（受信期間と利用日下限が別引数。§8.3-7。R2-02）
- [ ] **2 プロセスが別の注文を追加しても最終 102 行で両方が残る**（§8.3-13。R2-03）
- [ ] **確定失敗は未承認では再開せず、承認済みの対象だけが再開する**（§8.3-14。R2-14）
- [ ] **アカウント識別子が子 CLI から返り、別アカウント・欠落で終了コード 4**（§8.3-3。R2-04）
- [ ] **SQLite の診断欄（`import_runs.note`）に例外本文が残らない**（§8.3-15。R2-15）
- [ ] **削除承認が計画の版と対象の同一性に束縛され、計画差し替えでは削除 0 件**（§8.3-16。R2-08）
- [ ] **復元セットが 3 点揃った世代として作成・検証され、欠損世代では本体に触れる前に止まる**（§8.3-21。R2-07）
- [ ] **切替が「旧無効化 → 完了確認 → 状態引継ぎ → 本番 1 回 → 週次有効化」の順で行われ、実行主体が重ならない**（§8.3-20。R2-06）
- [ ] **隔離実行が本番ファイルを更新しない**（§8.3-19。R2-11）
- [ ] **一括削除の承認消費によって定常の自動削除が止まらず、定常有効化後は今回生成・適用成功分のみが自動削除される**（2 系統が独立。§8.3-16。R3-02）
- [ ] **1 社が未承認の `permanent` でも当該社のみスキップされ、残りのジョブは通常どおり実行・更新される**（全対象スキップのときだけ終了コード 5。§8.3-11。R3-03）
- [ ] **既存 CLI の変更範囲が §2.1 IN・§2.2・§4.9・§5・§6 #14–18・§7 で一致している**（5 ファイル。R3-01）
- [ ] `oauth.json` の正本が 1 箇所に定まり、リポジトリ間の自動コピーが削除されている
- [ ] `PORTS.md` / `ports.json` が未変更であること（ポート不要の確認）
- [ ] 親リポ `.claude/CLAUDE.md` §7、両 README、`gmail-import-rules.md`、`PROJECT_OVERVIEW.md` が改訂済み
- [ ] 各 `docs/実装ログ.md` のフェーズが締めチェックリストでクローズ済み
- [ ] 本設計書と各 `docs/設計書インデックス.md` のステータス・反映コミットが更新済み
- [ ] Obsidian の関連ノートが更新済み（更新の有無を最終報告に明記）

---

## 10. 確定事項と残る未確定事項

起票時の未確定 9 件は 2026-11-25 に処理した。内訳は 確定 7 件 / 確認タスクへ格下げ 2 件 / 新規起票 1 件。

### 10.1 確定事項（2026-11-25）

| # | 項目 | 確定内容 | 根拠 |
|---|---|---|---|
| 1 | `oauth.json` 正本 | **2 ファイルは内容が同一**（`client_id` / `client_secret` / `refresh_token` すべて一致、更新日時も 2026-11-07 23:25 で一致）。`--check-auth` で `gmail_profile_ok: true` を確認済みで、この認証情報は**有効**。再発行は不要。`credit-card-tracker` 側をコピー元として `gmail-ingest/data/gmail-auth/oauth.json` を正本にする | ローカル実測（値は記録しない）＋ `--check-auth` 実行。§4.2 |
| 2 | `gmail-ingest` の配置 | `D:\my-app2\gmail-ingest\` を新規フォルダとして作成し、**それ自体を独立リポジトリ**とする（既存子プロジェクトと同じ方式）。親リポ `.gitignore` に `/gmail-ingest/` を追加。本設計書と `設計書インデックス.md` も本リポジトリの `docs/` に置く | ユーザー判断（2026-11-25）。§4.1 / §4.9 / §6-1 |
| 3 | 実行曜日・時刻 | **毎週日曜 22:00 に統一**（現状 cc = 土 22:00 / amazon = 日曜） | ユーザー判断。§4.8 |
| 4 | タスクの実行権限 | **ログオン中のユーザー**。既存の `\my-app2\` 配下タスク 7 件と同じ権限。ログオフ中の実行（パスワード保存）や SYSTEM は採らない。未実行分は**実行枠の比較**で回収する（週次 + ログオン時 + 起動時の 3 トリガー併設。経過日数では判定しない。§4.8-1 / レビュー P2-01） | ユーザー判断。§4.8 |
| 5 | Node 実行パス | `C:\Program Files\nodejs\node.exe`（v24.22.1）。外部依存を入れないため `npm install` も不要 | ローカル実測。§4.8 |
| 6 | 既存の残存中間データ | **元データを保持し、F #27 を保留**。現行は過去分を計画に掲載するが、照合済み台帳の記録がなければ削除しない。再開には §10-10 と一括削除方式の決定が必要。 | 2026-11-25 ユーザー判断・2026-11-26 実装レビュー P1-01。§4.6-2 |
| 7 | Addendum の適用範囲 | 原文を確認し §1.1.1 に記載。**30 日の保存上限は `Google Technical Information` に対するもので、`user data` には数値の保存期間がない**（目的で制限）。`orders.csv` / SQLite の取引明細は `user data` であり 30 日上限の対象外。2(d) により権限取り消し後の保持は禁止 → §4.6-3 を新設。MCP 要件は AI Agent / AI Harness / AI model に限られ、非AI運用には直接かからない | 公開ページの原文確認（2026-11-25）。§1.1.1 |
| 8 | バックアップの保持方針 | **Phase 1 では削除しない**。`user data` に数値の保存上限がないため、復旧性を優先する。世代上限も設けない。代わりに §4.6-3 の権限取り消し手順で削除対象に含める | §1.1.1 の帰結。§4.6-1 |
| 9 | Phase 2 の起票時期 | **Phase 1 の定期実行が 4 週連続で成功した後に起票**する。2027-02-01 までに必須の作業ではない（非AI化で規約要件は満たされ、Phase 2 はコード重複の解消のみ） | 本設計の方針。§2.2 |

### 10.2 実装手順内の確認タスクへ格下げ（着手の前提ではない）

いずれもユーザー自身の操作が必要で、設計の確定を妨げないため、実装手順の中で確認する。

- **Google Cloud コンソールでの使用量実測**（起票時 §10-4）: `client_id` の一致までは確認済みだが、コンソール上でこのクライアントが `credit-card-tracker-496602` 配下であることと、Standard 上限に対する実使用量は未確認。公開ページには REST の Gmail API の具体的な上限値が記載されていないため、ダッシュボードでの実測が必要。週次の検索通数が両アプリ合計で数十通規模であることから Standard 上限内の見込みだが、これは推定である。確認期限は課金開始前の 2027-03-31（§8.4）。
- **Codex Automation の現在の有効状態**（起票時 §10-5）: 2 本のカードが実際に承認・有効化されているか、実行プロンプトの現在の内容。実装手順 **#25**（切替）の `preflight-cutover.ps1` 手順 1（次回予定時刻と実行中プロセスの確認）で確認する。
- **カード 3 社の確認済み期間末**（レビュー P1-01 由来）: 旧ログ（`credit-card-tracker/logs/gmail-import/` の provider セクション）と DB の取得履歴から特定する。特定できない社は初回を欠落回収として扱う（§4.4）。これは実装手順 #21 の作業であり、設計の確定は妨げない。あわせて `business_from`（利用日の抽出下限）を既存 CLI の既定値から転記する（R2-02）。

### 10.3 残る未確定事項

**2026-11-25 ユーザー決定**。取得元の識別に必要な資料を保持し、F #27 の過去分一括削除と定常の自動削除を保留する。`state/cleanup-enabled` と `state/auto-cleanup-enabled` は未配置で運用する。取得元識別策を再検討するときは、下記の選択肢と公式 CSV の可用性を確認する。

**10-10（2026-11-25 新規起票）: 権限取り消し時に `orders.csv` の Gmail 由来行を識別する手段がない。**

§1.1.1 で確認した Addendum 2(d) により、アクセスを取り消した場合は Gmail 由来の user data を保持できない。一方 `orders.csv` は Amazon 公式 CSV エクスポート由来の行と Gmail 由来の行が混在しており、28 列のどこにも取得元を示す列がない。SQLite 側は `email_messages` と `transactions` の対応で識別できる見込みだが、CSV 側には手段がない。

選択肢:

| 案 | 内容 | 評価 |
|---|---|---|
| (a) `Source` 列を追加 | `orders.csv` に取得元列を足す | ヘッダー 28 列の検証（§5）と既存 UI の CSV パースに衝突する。採りにくい |
| (b) 別の対応表を持つ | `data/gmail-origin.json` に Gmail 由来の重複判定キー（または Order ID + 商品名 + 日付）の一覧を持つ。取り込み時に追記する | **推奨**。`orders.csv` の構造を変えず、既存検証と無衝突。ただし過去分（2026-05 以降の Gmail 取り込み済みデータ）の遡及生成が必要で、ログから再構成できるか要確認 |
| (c) 特徴から推定 | Gmail 由来は `Billing Address` / `Shipping Address` が空、`Payment Method Type` が `Not Available` 等の特徴で推定 | 確実性がない。公式 CSV 由来でも同様の行があり得る |
| (d) 区別せず再構築 | 取り消し時は Gmail 由来か不明な行も含めて削除し、Amazon 公式 CSV エクスポートから再構築する | 実装不要で確実だが、Gmail からのみ取得した注文（公式エクスポート最終日 2026-04-25 以降の分）が失われる |

**要判断**: (b) を Phase 1 のスコープに含めるか、Phase 1 では §4.6-3 の手順書に (d) を暫定手順として記載し、(b) を別設計書へ分離するか。取り消しが実際に起きる可能性は低く、Phase 1 の期限（2027-01-31）を圧迫するため、**暫定は (d) を手順書に記載し、(b) は別途起票**を推奨する。

**F #27 の再開前に取得元識別策を決める。** (b) を採る場合は過去の本文 JSONL と候補 JSON を再構成入力として保全する（§4.6-2 手順 2）。(d) を採る場合は Amazon 公式エクスポートファイルの可用性と再構築を先に確かめる（§4.6-3 手順 4）。取得元識別策の決定後、一括削除方式を決める。

---

## 変更履歴

| 日付 | 内容 |
|---|---|
| 2026-11-26 | 実装レビューを反映。§4.1・§4.1-1・§4.4-1・§4.9 に実装済みの CLI・台帳を補記。§4.4-2 に `partial` の互換扱い、§4.5-2 に Amazon の現行停止粒度と ID ごとの解除、§4.6 に過去分・内容のある隔離の保持条件を記載。F #27 の再開条件と未実装の改善は [後続の修正設計](修正設計書_Gmail取り込み実装レビュー反映_Phase1_2026-11-26.md) に記録。 |
| 2026-11-25 | 実装・本番切替済みへ更新。ユーザー判断により元データを保持し、一括削除と定常の自動削除を保留。 |
| 2026-11-25 | §6 #21 へ、状態初期値の投入前に非正本 `amazon-tracker/logs/gmail-import/last-run.json` と突き合わせる手順を追記（§4.4 の規則が実装順の工程文に落ちていなかった）。 |
| 2026-11-25 | **第3回レビューの判定 条件付き着手可（Conditional Go）を受け、P1 3 件 / P2 3 件の全件を本文へ反映し、ステータスを「着手前（正本）」へ変更。Phase 1 は分割せず 1 本の設計書で進める（ユーザー判断）。** 第3回の指摘はいずれも**改訂の積み重ねで生じた文書内の仕様衝突**であり、設計の根幹に関する新たな欠陥の指摘はなかった。反映内容: **R3-01**（既存CLIの変更範囲が §2.1・§6 と §4.9・§7 で矛盾）→ §4.9 の `amazon-tracker` 表へ `tools/gmail-import-run.mjs`（既存CSV読込前のロック・置換行集計・保留）と `gmail-fetch-local.mjs` の `account_fingerprint` 出力、テスト 2 行を追記。§4.9 の `credit-card-tracker` を「コード変更なし」から 3 ファイル（`gmail-import-apply.mjs` / `gmail-raw-payload.mjs` / `gmail-import-incremental.mjs`）＋テスト・version へ差し替え、起票時の記述を撤回と明記。§7 のリスク表を「3 ファイル」→「5 ファイル」および「既存 CLI 2 ファイルにロック取得」→「3 ファイル」へ訂正。§2.1 IN に「上表 5 ファイルが変更範囲の正本」を明記し重複行を削除、§2.2 に例外の明示、§4.5-1 に「ロック 3 箇所・変更は合計 5 ファイル」を補記、§9 に整合の受入を追加。**R3-02**（定常の自動削除と一括削除の承認が衝突し、初回一括削除後に週次の自動削除が止まる）→ §4.6-1 に 2 系統の表を新設（定常＝`state/auto-cleanup-enabled`・消費しない／一括＝`state/cleanup-enabled`＋`plan_id`・1 回で消費）。§4.6-2 に手順 7（一括完了後に定常を有効化）、§4.6-2a に「消費は一括系統に限り `auto-cleanup-enabled` に触れない」を追加。§4.1 のツリー、§3.1 の図、§6 #27、§8.3-16、§9 も同期。**R3-03**（確定失敗時の停止粒度が §4.5 と §4.5-2 で衝突し、1 社の失敗で全ジョブが停止し続ける）→ §4.5 の起動時判定を対象ごとの判定へ改め、全体停止事由（1 / 3 / 4）と対象スキップを分離。終了コード 5 を「全対象が未承認 `permanent` でスキップされ新規実行が 0 件」に限定（表も改訂）。§8.3-11 に 1 社スキップ・残り継続の試験、§9 に受入を追加。**R3-04** → §4.1-1 の実行モード表へ `--restore-set` 行を追加し、優先順位・`--profile` 併用時の混在拒否・枠を消費しないことを明記。**R3-05** → §4.1 のツリーへ `lib/restore-set.mjs` / `state/cleanup-plans/` / `state/restore-sets/` / `state/auto-cleanup-enabled` を追加し `logs/cleanup-plan.json` を削除。§3.1 の Mermaid 図を現行仕様（非取得モードの分岐、対象別スキップ、カード社別 3 回実行、カード失敗でも Amazon が実行される独立性、型別の金額照合、`auto-cleanup-enabled`）へ全面更新。**R3-06** → §4.7 末尾の重複段落を削除。§10.2 の `#22`→`#25`、§10.3 の `#23/#24`→`#26/#27`、`§4.6-3 手順 7`→`手順 4` を訂正。あわせて §6 の 32 ステップ改番で陳腐化していた §8.3 相互参照 14 箇所（`§8.3-4`→`-6`、`-11`→`-13`、`-12`→`-15`、`-13`→`-16`、`-14`→`-17`、`-15`→`-18`、`-16`→`-20`、`-17`→`-21`、`-18`→`-22`）を §8.3 の現行番号（全 22 項目）へ揃えた。 |
| 2026-11-25 | 新規作成。Google Workspace API 規約変更（2027-02-01 MCP 要件適用開始）への対応として、Gmail 取得を非AIの単一ランナー `gmail-ingest` へ一本化する Phase 1 の仕様を起票。新規ビューアアプリ案・取得コア同時統合案・データストア統一案・MCP 移行案を §3.2 で退けた理由を記録。両アプリの `client_id` 一致（＝同一 Google Cloud プロジェクト共用）を §1.2 に記録。起票時は親リポ `my-app2/docs/` に配置。 |
| 2026-11-25 | **第2回レビュー（追加レビュー R2-12〜15 を含む）の判定 着手不可（No-Go）を受け、P1 9 件 / P2 6 件 / 外部仕様の表現修正の全件を本文へ反映。** 初回反映時の 2 つの誤りを訂正した: ①**§4.3-1 の金額照合式が正常な Type A を永久失敗にする**（Type A は各行に同じ注文総額が入るため、行合計との照合は誤り。レビューが `parseTypeA` へ合成メールを渡し、各行 2,200 円 / 合計 4,400 円で止まることを実証）→ §4.3-1a を新設し元メール単位・型別の式へ。件数収支にも隔離の独立分岐を追加（R2-01）。②**§4.4-1 の欠落回収が `--from` を受信期間と利用日下限の両方に使うため遅着通知を正常として除外する**（抽出下限 9/27 で取引 0・除外 1・解析失敗 0 を実証）→ 2 つを別引数に分離し、確定末を「照合を終えた連続区間の末」へ、Gmail 日付境界が太平洋時間基準であることへの対策を追加（R2-02）。その他の反映: **R2-03** → §4.5-1 でロック保持範囲を「既存 CSV を読む前〜適用後照合の完了」へ広げ、親が所有して `GMAIL_INGEST_LOCK_TOKEN` で子へ引継ぎ、`pending_human_review` ロックを自動回収しない規則を追加。**R2-04** → §4.2-1 で子 CLI が `account_fingerprint` を返す契約と `--register-account` を新設、`NODE_OPTIONS` を除外側へ明記。**R2-05** → §4.3 でカードを `--provider` 社別の 3 回実行へ変更し、部分成功の永続化時点・未着手社・再試行先・終了コードの優先順を定義。**R2-06** → §4.8-2 の順序を「隔離試験 → 旧無効化 → 完了確認 → 状態引継ぎ → 本番 1 回 → 週次有効化」へ訂正し、診断専用化を切替前（§6 #23）へ移動、切り戻しに日付・承認条件を追加、Codex 側は PowerShell から操作できない旨を明記。**R2-07** → §7-1 復元セットの作成手順を新設（`VACUUM INTO` による整合コピー・manifest・復元検証）。**R2-08** → §4.6-2a で承認を `plan_id` と対象の同一性に束縛し、実パスを持つ計画を `state/cleanup-plans/` の非公開台帳へ分離、`realpath` 解決後のルート検証。**R2-09** → `attempted_slot` / `completed_slot` の分離とネットワーク復旧トリガーの追加。**R2-10** → §4.6-3 で公式エクスポートの読取り・再構築試行を業務データ変更前へ前倒し、SQLite 全体廃棄の条件と削除テーブル（`email_messages` 自体を含む）を明記。**R2-11** → §4.1-1 実行モード表と優先順位、本番・試験の混在拒否、§9 の合格判定を 3 段階へ分離。**R2-12** → §4.3-2 カードの検索・取得・適用の集合照合を新設。**R2-13** → §4.3-1b 既存行の非破壊の検証を新設（期待行集合・`replaced_typeB_summary_rows` の別集計・確定できない行の保留）。**R2-14** → §4.5-2 確定失敗の解除と再開の契約を新設（`--clear-failure`・`cleared_failures`・停止範囲の区別）。**R2-15** → §4.7-1 子 CLI の永続化と WAL / SHM の残存への対応を新設。**外部仕様** → §1.1 の 2026-11-24 行に例外申請経路、2027-02-01 行に Addendum 発効を併記。既存 CLI の変更は 2 → 5 ファイルに拡大（§2.1 IN の表）、実装順は 30 → 32 ステップ。 |
| 2026-11-25 | **初回設計レビューの判定 着手不可（No-Go）を受け、P1 8 件 / P2 5 件 / 外部仕様の訂正 1 件の全件を本文へ反映。ステータスを「ドラフト（レビュー指摘反映版・再レビュー待ち）」へ変更。** 反映先: **P1-01**（カードの長期停止で未取得期間を飛ばす）→ §1.2 に訂正行、§3.1、§4.3 の成功条件、§4.4 を `schema_version: 2` へ（`next_search_after` → `confirmed_through`、カード 3 社の状態を追加）、§4.4-1 欠落回収を新設、§8.1 / §8.3-7。**P1-02**（適用前後の照合漏れ）→ §4.3 にステップ 1.5 / 2.5、§4.3-1 を新設、`lib/verify.mjs` を追加、§8.3-8。**P1-03**（Windows の子 CLI 起動契約）→ §4.2-2 を新設し `npm run` を廃して `process.execPath` 直実行へ、§4.1、§8.3-2。**P1-04**（別アカウント・別出力先で成功しうる）→ §4.2-1 を新設し `lib/env.mjs` を追加、§8.3-3。**P1-05**（残存書き手との競合）→ §4.5 のロックを原子的作成・所有者限定・書込み対象側へ、既存 CLI 2 ファイルへロック取得を追加（§2.1 IN / §6 #14-15）、§8.3-11。**P1-06**（切り戻し時点の不一致）→ §7 のロールバックを (A) 経路のみ / (B) データ復元の 2 種に分離、§8.3-17。**P1-07**（初回実行だけで一括削除できる）→ §4.6-1 の許可ルートに `quarantine/` を追加、削除を既定無効（`state/cleanup-enabled`）、§4.6-2 を 6 段階の手順へ、過去分と未解決隔離を保留、§8.3-13。**P1-08**（手動フォールバックと切り戻しで AI 取得が復活）→ §4.9-1 を新設し経路×主体の表を定義、`/amazon-import` と Codex 取込スキルを診断専用へ、2027-02-01 以降は旧 Automation の再有効化を禁止、§5 / §9 / §8.3-18。**P2-01**→§4.8-1 の実行枠判定（経過日数判定を廃止、3 トリガー併設、StartWhenAvailable）。**P2-02**→§4.7 を許可値からの生成方式へ（例外メッセージ・ファイル名の記録を禁止）、§8.1 / §8.3-12。**P2-03**→§4.6-3 に `dist/data/orders.csv`・`transaction_sources`・`gmail_fetch_messages`・`parse_failures`・`ids.json`・`manifest.json`・年月別ディレクトリを追加し処理順を固定、§8.3-14。**P2-04**→§4.4-2 のジョブ結果定義、終了コードを 7 種へ、業務行と履歴行を分けた検証、§8.3-6 / -9。**P2-05**→§4.8-2 と `scripts/preflight-cutover.ps1` を新設、§6 #22、§8.3-16。**外部仕様の訂正**→§1.1 の日程表で 2027-02-01（MCP 要件）と 2027-04-01（Standard 上限適用・課金開始）を分離し、例外申請経路の存在と未確認であることを追記。あわせて §6 の実装順を 23 → 30 ステップへ改め、§10-10 の決定期限を削除有効化の直前に前倒し。 |
| 2026-11-25 | **§10 の未確定 9 件を処理（確定 7 / 確認タスクへ格下げ 2 / 新規起票 1）してステータスを「着手前（正本）」へ更新。** 主な追記: ①§1.1.1 を新設し Workspace AI Tools Addendum と利用階層ページの原文確認を記載（30 日上限は `Google Technical Information` に対するもので `user data` には数値の保存期間がない／2(d) は権限取り消し後の保持を禁止／MCP 要件は AI に限られ非AI運用には直接かからない）。②§4.2 に `oauth.json` 2 ファイルが内容同一であることと `--check-auth` で有効を確認した結果を追記。③§4.6 を 4.6-1〜4.6-3 に再構成し、既存残存分（本文 JSONL が amazon 66 件 8.0MB / cc 190 件 32.4MB）の一括削除と権限取り消し時手順を追加。④§4.8 の node 絶対パス・実行曜日（日曜 22:00）・実行権限（ログオン中ユーザー）を確定。⑤§2.1 IN に残存データ削除と取り消し手順整備を追加。⑥§3.2 の MCP 移行案の却下理由を原文根拠で補強。⑦§10-10 として「権限取り消し時に `orders.csv` の Gmail 由来行を識別する手段がない」を新規起票。あわせて設計書の配置を `my-app2/gmail-ingest/docs/` へ移設（ユーザー判断）し、親リポ `.gitignore` に `/gmail-ingest/` を追加、`gmail-ingest` をローカル `git init`（コミットなし）。 |
