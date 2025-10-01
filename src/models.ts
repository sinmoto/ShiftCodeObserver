/**
 * models.ts
 *
 * 本プロジェクトで使用するドメインモデル（型定義）を集約。
 * 監視対象コード、ログ、メトリクス、ソース取得コンテキスト等の
 * 共通インターフェースを定義します。
 */
import type { Mode, WorkerEnv } from './env';

/**
 * 収集対象のソース名称。
 */
export type SourceName =
  | 'OFFICIAL_SITE'
  | 'OFFICIAL_X'
  | 'MEDIA_TRUSTED'
  | 'COMMUNITY_AUX';

/**
 * コードの状態。
 * - Active: 利用可能
 * - Expired: 期限切れ
 * - Hold: 保留（真偽不明・確認待ちなど）
 */
export type CodeStatus = 'Active' | 'Expired' | 'Hold';

/**
 * 正規化・保存された SHiFT コードのレコード。
 */
export interface ShiftCode {
  id: string;
  title: 'BL4';
  codeText: string;                 // 元のコード表記
  normalizedCodeText: string;       // 比較用に正規化した表記
  rewardType: string;               // 付与リワード種別（例: Golden Keys）
  expiresAt: string | null;         // 期限（ISO）
  firstSeenAt: string;              // 初出検出日時（ISO）
  status: CodeStatus;               // 現在の状態
  sources: SourceName[];            // 検出ソース一覧
  hash: string;                     // 同一性判定用ハッシュ
  createdAt: string;                // 作成日時（ISO）
  updatedAt: string;                // 更新日時（ISO）
  metadata?: {
    url?: string;                   // 元記事/投稿などの参照URL
    notes?: string;                 // 任意メモ
    discoveredBy?: string;          // 発見者（ハンドル等）
    notifiedAt?: string;            // 通知実施日時（ISO）
    isFallback?: boolean;           // サンプル/フォールバック由来か
  };
}

/**
 * 解析結果種別。
 */
export type ParseResult = 'SUCCESS' | 'FAILED' | 'SKIPPED_DUPLICATE';

/**
 * 収集・解析フェーズでの検出ログ。
 */
export interface DetectionLog {
  id: string;
  source: SourceName;
  fetchedAt: string;
  parseResult: ParseResult;
  codeId?: string;
  errorCode?: string;
  notes?: string;
}

/**
 * 通知送信の履歴ログ。
 */
export interface NotificationLog {
  id: string;
  codeId: string;
  status: 'SENT' | 'SKIPPED';
  createdAt: string;
  destination: 'DISCORD_WEBHOOK';
  responseStatus?: number;
  error?: string;
}

/**
 * 1 回の監視実行（バッチ）のサマリメトリクス。
 */
export interface RunMetrics {
  runId: string;
  lastRunAt: string;
  scheduleDelaySeconds: number;
  sourcesScanned: SourceName[];
  totalCodes: number;
  newCodes: number;
  duplicatesSkipped: number;
  notificationsSent: number;
  errors: number;
  http429: number;
  http5xx: number;
}

/**
 * 監視実行のレスポンス（外部 API 用）。
 */
export interface MonitorResult {
  runId: string;
  processedSources: SourceName[];
  newCodes: ShiftCode[];
  notificationsSent: number;
  duplicatesSkipped: number;
  errors: number;
}

/**
 * ソース収集時の実行コンテキスト。
 */
export interface SourceFetchContext {
  mode: Mode;
  backfillDays: number;
}

/**
 * 収集時点の生コード（正規化前・保存前の形）。
 */
export interface CollectedCode {
  code: string;
  rewardType?: string;
  expiresAt?: string | null;
  firstSeenAt?: string;
  status?: CodeStatus;
  url?: string;
  notes?: string;
  isFallback?: boolean;
}

/**
 * 単一ソースからの収集結果。
 */
export interface SourceFetchResult {
  source: SourceName;
  codes: CollectedCode[];
  http429: number;
  http5xx: number;
}

/**
 * ソース収集関数のシグネチャ。
 */
export type SourceFetcher = (
  env: WorkerEnv,
  context: SourceFetchContext
) => Promise<SourceFetchResult>;

/**
 * ソース信頼度（0〜1）。重み付け等に利用。
 */
export interface SourceTrustRecord {
  source: SourceName;
  score: number;
  lastUpdated: string;
}

