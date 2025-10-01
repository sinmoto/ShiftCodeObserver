# Borderlands 4 SHiFT Code Monitor

このプロジェクトは Borderlands 4 の SHiFT コードを監視するワーカーです。Cloudflare Workers で動作させることも、GitHub Actions のスケジュール実行で動かすこともできます。どちらの経路でも同一の TypeScript ソースと環境変数設定を共有します。

## 前提条件

- Node.js 18 以降
- npm 9 以降
- Cloudflare 利用時（任意）: Wrangler CLI（`npm install -g wrangler`）
- GitHub Actions 利用時（任意）: Actions を有効にした GitHub リポジトリ

## リポジトリ構成

```
ShiftCodeObserver/
  README.md             # このガイド（日本語）
  package.json          # スクリプトと依存関係
  tsconfig.json         # TypeScript 設定
  src/                  # Worker 本体（TypeScript）
  scripts/              # 補助スクリプト（tsx で実行）
```

## インストール

```bash
npm install
```

## 使い方の選択肢

### Cloudflare Workers で実行

1. リポジトリ直下に `wrangler.toml` を作成または更新します:

   ```toml
   name = "shift-code-worker"
   main = "src/index.ts"
   compatibility_date = "2024-09-20"

   [[r2_buckets]]
   binding = "R2"
   bucket_name = "bl4-shift-codes"
   ```

   バケット名は利用中の R2 リソースに合わせて調整してください。移行中に既存の KV バインディング（`SHIFT_STATE`, `SHIFT_CACHE`）へ依存している場合は、移行完了まで維持してください。

2. Cloudflare リソースを用意します:
   - コード・メトリクス・ログ保存用の R2 バケット
   - 段階的移行に使う任意の Workers KV 名前空間
   - 5 分間隔の Cron トリガ（`wrangler.toml` で設定）

3. Wrangler を認証・設定します:

   ```bash
   npm run dev # 初回は wrangler login を促されます
   wrangler r2 bucket create bl4-shift-codes # 初回のみ
   ```

4. 環境変数・シークレットを設定します:

   ```bash
   wrangler secret put DISCORD_WEBHOOK_URL
   wrangler secret put SOURCE_OFFICIAL_SITE_URL
   wrangler secret put SOURCE_OFFICIAL_X_URL
   wrangler secret put SOURCE_MEDIA_TRUSTED_URL
   wrangler secret put SOURCE_COMMUNITY_AUX_URL
   ```

   機密でない値は `wrangler.toml` の `vars` ブロックに直書きすることも可能です。

5. ローカル実行:

   ```bash
   npm run dev
   ```

6. 本番デプロイ:

   ```bash
   npm run deploy
   ```

   定期実行や Webhook 配信の挙動は `wrangler tail` でログを追跡して検証してください。

7. 提供エンドポイント（`/` と `/api/v1` の両方で提供）
   - `GET /health`: 稼働時間と直近実行サマリ
   - `GET /codes`: 保存済みコード（`status`, `limit`, `offset` をサポート）
   - `POST /monitor/run`: 監視収集を手動トリガ
   - `GET /detection-logs`, `GET /notification-logs`, `GET /metrics`
   - `PUT /sources/trust/:source`: 信頼重みを更新（`OFFICIAL_SITE`, `OFFICIAL_X`, `MEDIA_TRUSTED`, `COMMUNITY_AUX`）
   - `POST /notifications/resend`: 送信履歴の再送を各種フィルタでリプレイ

### GitHub Actions で実行

Cloudflare 依存のない軽量フェッチャー `scripts/fetch-codes.ts` を用いてコード収集が可能です。R2 ストレージはモック化され、Workers と同じ環境変数を受け付けます。

1. 収集するフィードを決め、各 URL をリポジトリ・シークレットとして作成（例: `SOURCE_MEDIA_TRUSTED_URL`）。未指定は同梱のサンプルデータにフォールバックします。
2. ワークフローを追加（例: `.github/workflows/fetch-shift-codes.yml`）:

   ```yaml
   name: Fetch Borderlands SHiFT Codes

   on:
     schedule:
       - cron: "0 * * * *" # 毎時
     workflow_dispatch: {}

   jobs:
     fetch:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with:
             node-version: 20
             cache: npm
         - run: npm ci
         - name: Fetch codes
           run: npm run fetch-codes -- --json > shift-codes.json
           env:
             MODE: DRY_RUN
             SOURCE_OFFICIAL_SITE_URL: ${{ secrets.SOURCE_OFFICIAL_SITE_URL }}
             SOURCE_OFFICIAL_X_URL: ${{ secrets.SOURCE_OFFICIAL_X_URL }}
             SOURCE_MEDIA_TRUSTED_URL: ${{ secrets.SOURCE_MEDIA_TRUSTED_URL }}
             SOURCE_COMMUNITY_AUX_URL: ${{ secrets.SOURCE_COMMUNITY_AUX_URL }}
         - uses: actions/upload-artifact@v4
           with:
             name: borderlands-shift-codes
             path: shift-codes.json
   ```

   既定では人間が読みやすいサマリを標準出力します。`--json` フラグを付けると後続処理（Discord 投稿や Issue 作成など）向けの構造化出力をファイルに保存します。

3. 任意の後続ステップ例:
   - 生成した JSON をカスタム Action で Discord/Slack に投稿
   - 監査用に出力をブランチへコミット
   - 前回実行との差分を比較し、新規コード出現時に Issue を起票

4. 調整オプション:
   - `MODE=PROD` にすると本番設定を模倣（フェッチャー自体は読み取り専用）
   - `BACKFILL_DAYS` で遡及取得期間を制御（既定 14 日）
   - `SOURCES_WHITELIST` で実行するソースを限定（JSON 配列またはカンマ区切り）

## 環境変数

Cloudflare と GitHub Actions の両経路で同じ変数を認識します（Cloudflare は `vars`/secrets、Actions は環境変数で設定）。

- `MODE`: `DRY_RUN`（既定）または `PROD`
- `DISCORD_WEBHOOK_URL`: Discord Webhook（通知有効時のみ使用）
- `SOURCES_WHITELIST`: 有効化する収集ソースの JSON 配列
- `SCHEDULE_*`: ソースごとの実行間隔（分）
  - `SCHEDULE_OFFICIAL_MINUTES`, `SCHEDULE_MEDIA_MINUTES`, `SCHEDULE_COMMUNITY_MINUTES`
- `BACKFILL_DAYS`, `RETRY_MAX`, `RETRY_BASE_MS`, `RETRY_JITTER_PCT`, `JITTER_PCT`: 監視動作のチューニング
- `SOURCE_OFFICIAL_SITE_URL`, `SOURCE_OFFICIAL_X_URL`, `SOURCE_MEDIA_TRUSTED_URL`, `SOURCE_COMMUNITY_AUX_URL`: フィードのエンドポイント

未指定の値は同梱のサンプルデータにフォールバックするため、常に決定的な出力が得られます。

## セーフティチェックリスト（Cloudflare）

- 検証中は `MODE` を `DRY_RUN` に維持
- 初回デプロイ前に R2 バケットのバインディングを確認
- `PROD` 切替前に Discord Webhook シークレットを設定
- `wrangler tail` でレート制限や通信エラーを監視
- R2 への移行成功後は KV バインディングを削除

## 手動再通知（Cloudflare）

```bash
curl -X POST https://<worker-url>/notifications/resend \
  -H "content-type: application/json" \
  -d '{"codeIds": ["<code-id>"], "statuses": ["Active"], "limit": 1}'
```

- `codeIds` を省略すると一致するすべてのコードが対象
- 既定の `statuses` は `["Active"]`。`"ALL"` を指定すると保留・期限切れを含めて対象化
- `includeFallback` はサンプル／フォールバックコードを追加
- `includeExpired` は期限切れコードの再送を許可
- `limit` は 1 回の再送件数を制限

成功時は送信された通知件数が返ります。

