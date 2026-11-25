# gmail-ingest

Amazon とクレジットカードの Gmail 取り込みを Windows タスクスケジューラから順に実行する CLI です。Node.js 20 以上の標準 API を使用します。依存パッケージのインストールやポート予約は不要です。

Phase 1 の進捗は [実装ログ](docs/実装ログ.md)、実行・切替・復元の仕様は [Phase 1 設計書](docs/修正設計書_Gmail取り込み非AI一本化_Phase1_2026-11-25.md) を参照してください。

開発時は `npm test` で合成データを使ったテストを実行できます。本番の入口は `node run.mjs` を予定しています。
