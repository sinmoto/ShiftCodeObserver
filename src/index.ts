/**
 * index.ts
 *
 * Cloudflare Workers 上で稼働する HTTP API のエントリポイント。
 * Hono を用いてルーティングを定義し、`/` および `/api/v1` で同一のエンドポイントを提供します。
 * スケジュール実行（cron）により監視バッチも起動します。
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Context } from 'hono';
import type { WorkerEnv } from './env';
import {
  getCodeById,
  getMetrics,
  listCodes,
  listDetectionLogs,
  listNotificationLogs,
  listSourceTrust,
  setSourceTrust,
} from './storage';
import { resendNotifications, runMonitor } from './monitor';
import { parseNumber, toIsoString } from './utils';
import type { CodeStatus, SourceName } from './models';

// 一度に返す最大件数（上限）
const MAX_LIMIT = 250;

// Hono アプリ本体。`Bindings` に Cloudflare Workers の `env` 型を紐付け
const app = new Hono<{ Bindings: WorkerEnv }>();
// CORS を全ルートに適用
app.use('*', cors());

// グローバルエラーハンドラ
app.onError((err, c) => {
  console.error('Unhandled error', err);
  return c.json(
    {
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
      details: err instanceof Error ? err.message : 'Unexpected error',
    },
    500
  );
});

// クエリ `limit` を解釈し、[1, MAX_LIMIT] に丸める
function parseLimitFromContext(c: Context<{ Bindings: WorkerEnv }>): number {
  const limit = parseNumber(c.req.query('limit'), 100);
  return Math.min(Math.max(limit, 1), MAX_LIMIT);
}

// クエリ `offset` を解釈し、0 以上の整数でない場合は 400 を返す側で例外化
function parseOffsetFromContext(c: Context<{ Bindings: WorkerEnv }>): number {
  const raw = c.req.query('offset');
  if (!raw) {
    return 0;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('Invalid offset parameter');
  }
  return parsed;
}

/**
 * ルーティング定義。
 * - `/` と `/api/v1` の両方にバインドされる想定で複製登録する。
 * - 読み取り系（health/codes/logs/metrics）と管理系（trust/monitor/notifications）を提供。
 */
function registerRoutes(router: Hono<{ Bindings: WorkerEnv }>) {
  // ルート: 稼働状況の簡易情報
  router.get('/', (c) =>
    c.json({
      message: 'Borderlands 4 SHiFT code monitor Cloudflare Worker',
      status: 'running',
      version: '1.0.0',
      mode: c.env.MODE,
    })
  );

  // ヘルスチェック: 直近実行情報を返す
  router.get('/health', async (c) => {
    const metrics = await getMetrics(c.env);
    return c.json({
      status: 'ok',
      timestamp: toIsoString(new Date()),
      lastRunId: metrics?.runId ?? null,
      lastRunAt: metrics?.lastRunAt ?? null,
      mode: c.env.MODE,
    });
  });

  // コード一覧: status/limit/offset でフィルタ・ページング
  router.get('/codes', async (c) => {
    try {
      const statusFilter = c.req.query('status');
      if (statusFilter && !['Active', 'Expired', 'Hold'].includes(statusFilter)) {
        return c.json({ error: 'Invalid status parameter' }, 400);
      }

      const limit = parseLimitFromContext(c);
      const offset = parseOffsetFromContext(c);
      const codes = await listCodes(c.env);
      const filtered = statusFilter
        ? codes.filter((code) => code.status === statusFilter)
        : codes;

      const paginated = filtered.slice(offset, offset + limit);
      return c.json({
        codes: paginated,
        total: filtered.length,
        limit,
        offset,
      });
    } catch (error) {
      return c.json({ error: 'Invalid request', details: (error as Error).message }, 400);
    }
  });

  // コード詳細: ID 指定で 1 件取得
  router.get('/codes/:id', async (c) => {
    const id = c.req.param('id');
    const code = await getCodeById(c.env, id);
    if (!code) {
      return c.json({ error: 'Code not found' }, 404);
    }
    return c.json(code);
  });

  // 検出ログの最新から limit 件
  router.get('/detection-logs', async (c) => {
    const limit = parseLimitFromContext(c);
    const logs = await listDetectionLogs(c.env, limit);
    return c.json({ logs, limit });
  });

  // 通知ログの最新から limit 件
  router.get('/notification-logs', async (c) => {
    const limit = parseLimitFromContext(c);
    const logs = await listNotificationLogs(c.env, limit);
    return c.json({ logs, limit });
  });

  // メトリクスの取得（存在しない場合は既定形で返す）
  router.get('/metrics', async (c) => {
    const metrics = await getMetrics(c.env);
    if (!metrics) {
      return c.json({
        runId: null,
        lastRunAt: null,
        totalCodes: 0,
        newCodes: 0,
        duplicatesSkipped: 0,
        notificationsSent: 0,
        errors: 0,
        http429: 0,
        http5xx: 0,
        sourcesScanned: [],
        scheduleDelaySeconds: 0,
      });
    }
    return c.json(metrics);
  });

  // ソースの信頼重み一覧
  router.get('/sources/trust', async (c) => {
    const records = await listSourceTrust(c.env);
    return c.json({
      sources: records,
      total: records.length,
    });
  });

  // ソースの信頼重みを更新（0〜1 に正規化）
  router.put('/sources/trust/:source', async (c) => {
    const source = c.req.param('source').toUpperCase() as SourceName;
    if (!['OFFICIAL_SITE', 'OFFICIAL_X', 'MEDIA_TRUSTED', 'COMMUNITY_AUX'].includes(source)) {
      return c.json({ error: 'Unknown source' }, 404);
    }

    const body = await c.req.json<{ score?: number }>().catch(() => null);
    if (!body || typeof body.score !== 'number' || Number.isNaN(body.score)) {
      return c.json({ error: 'Invalid request body' }, 400);
    }

    const score = Math.min(Math.max(body.score, 0), 1);
    const record = await setSourceTrust(c.env, source, score, toIsoString(new Date()));

    return c.json(record);
  });

  // 監視処理を手動実行
  router.post('/monitor/run', async (c) => {
    const result = await runMonitor(c.env, new Date());
    return c.json(result);
  });

  // 通知の再送（フィルタ・件数・期限切れ取扱い等を指定可能）
  router.post('/notifications/resend', async (c) => {
    const body = await c.req.json<{ codeIds?: string[]; statuses?: string[]; limit?: number; includeFallback?: boolean; includeExpired?: boolean }>().catch(() => null);
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const codeIds = Array.isArray(body.codeIds)
      ? body.codeIds
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
      : undefined;

    const statusMap: Record<string, CodeStatus> = {
      ACTIVE: 'Active',
      EXPIRED: 'Expired',
      HOLD: 'Hold',
    };

    let statuses: CodeStatus[] | undefined;
    if (Array.isArray(body.statuses)) {
      const normalized = body.statuses
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim().toUpperCase())
        .filter((value) => value.length > 0);

      if (normalized.length > 0) {
        const invalidValues = normalized.filter((value) => value !== 'ALL' && !(value in statusMap));
        if (invalidValues.length > 0) {
          return c.json({ error: `Invalid status values: ${invalidValues.join(', ')}` }, 400);
        }
        if (normalized.includes('ALL')) {
          statuses = ['Active', 'Hold', 'Expired'];
        } else {
          statuses = normalized.map((value) => statusMap[value]);
        }
      } else {
        statuses = [];
      }
    }

    const limit = typeof body.limit === 'number' && body.limit > 0 ? Math.floor(body.limit) : undefined;

    const includeFallback = typeof body.includeFallback === 'boolean' ? body.includeFallback : false;
    const includeExpired = typeof body.includeExpired === 'boolean' ? body.includeExpired : false;

    const summary = await resendNotifications(c.env, { codeIds, statuses, limit, includeFallback, includeExpired });

    return c.json({
      message: summary.sent > 0 ? 'Notifications dispatched' : 'No notifications sent',
      ...summary,
    });
  });

  // 管理: 指定プレフィックス配下の R2 オブジェクト件数をカウント（既定 `codes/`）
  router.get('/admin/codes/count', async (c) => {
    const prefix = c.req.query('prefix') ?? 'codes/';
    let cursor: string | undefined;
    let count = 0;
    while (true) {
      const listing = await c.env.R2.list({ prefix, cursor });
      count += listing.objects.length;
      if (!listing.truncated) {
        break;
      }
      // 型定義上、truncated=true のケースでのみ cursor が存在するため、存在チェックの上で参照
      cursor = (listing as unknown as { cursor?: string }).cursor;
      if (!cursor) {
        break;
      }
    }
    return c.json({ prefix, count });
  });
}

// ルート直下と `/api/v1` の 2 系統で同一路線を公開
registerRoutes(app);
registerRoutes(app.basePath('/api/v1'));

export default {
  // HTTP リクエストエントリポイント
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx);
  },
  // Cron（スケジュール）実行エントリポイント
  scheduled(event: ScheduledController, env: WorkerEnv, ctx: ExecutionContext) {
    ctx.waitUntil(runMonitor(env, new Date(event.scheduledTime)).catch((error) => {
      console.error('Scheduled run failed', error);
    }));
  },
};

