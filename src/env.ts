/**
 * Cloudflare Workers の環境変数を型でまとめたモジュール。
 * - WorkerEnv は実行時に注入される設定やバインディングを表現する
 * - scripts/fetch-codes.ts からも再利用できるように単独で定義している
 */
import type { R2Bucket } from '@cloudflare/workers-types';

/**
 * 実行モード。
 * - DRY_RUN: 確認用。本番通知などの副作用はスキップ
 * - PROD: 本番運用モード
 */
export type Mode = 'DRY_RUN' | 'PROD';

/**
 * Cloudflare Worker の nv オブジェクトを型として表現する。
 * Wrangler や GitHub Actions から注入された値をここで受け取る。
 */
export interface WorkerEnv {
  /** 実行モード（DRY_RUN か PROD） */
  MODE: Mode;
  /** ログ出力レベル（未指定なら既定の INFO） */
  LOG_LEVEL?: 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';
  /** Discord Webhook の送信先URL */
  DISCORD_WEBHOOK_URL?: string;
  /** 有効なソースのみを許可するホワイトリスト(JSON文字列) */
  SOURCES_WHITELIST?: string;
  /** 公式ソースのポーリング間隔（分） */
  SCHEDULE_OFFICIAL_MINUTES?: string;
  /** メディア系ソースのポーリング間隔（分） */
  SCHEDULE_MEDIA_MINUTES?: string;
  /** コミュニティ系ソースのポーリング間隔（分） */
  SCHEDULE_COMMUNITY_MINUTES?: string;
  /** 何日分までさかのぼって取得するか */
  BACKFILL_DAYS?: string;
  /** リトライ回数の上限 */
  RETRY_MAX?: string;
  /** リトライ時の基準ウェイト（ミリ秒） */
  RETRY_BASE_MS?: string;
  /** リトライ時のジッター割合（%） */
  RETRY_JITTER_PCT?: string;
  /** 公式サイトフィードのURL */
  SOURCE_OFFICIAL_SITE_URL?: string;
  /** X(Twitter)フィードのURL（API連携かスクレイピングを想定） */
  SOURCE_OFFICIAL_X_URL?: string;
  /** 信頼済みメディアのフィードURL */
  SOURCE_MEDIA_TRUSTED_URL?: string;
  /** コミュニティ補完フィードのURL */
  SOURCE_COMMUNITY_AUX_URL?: string;
  /** グローバルなジッター割合（%）。必要に応じて追加の揺らぎに利用 */
  JITTER_PCT?: string;
  /** SHiFTコードや各種ログを格納する Cloudflare R2 バケット */
  R2: R2Bucket;
  /** 旧ストレージからの移行用に残したKV（読み取り専用） */
  SHIFT_STATE?: KVNamespace;
  /** キャッシュ用途のKV（読み取り専用） */
  SHIFT_CACHE?: KVNamespace;
}