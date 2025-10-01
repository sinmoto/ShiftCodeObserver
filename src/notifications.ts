/**
 * notifications.ts
 *
 * SHiFTコードに関する通知（Discord Webhook）を送信します。
 * - DRY_RUN もしくは Webhook 未設定時は送信せず、SKIPPED としてログのみ記録
 * - 429/5xx などの一時的な失敗に対してはリトライ（指数バックオフ）
 */
import type { WorkerEnv } from './env';
import type { ShiftCode } from './models';
import { saveNotificationLog } from './storage';
import { sleep, toIsoString } from './utils';

/**
 * 通知ディスパッチの結果サマリ。
 */
export interface NotificationDispatchResult {
  sent: number;
  attempted: number;
  sentRecords: Array<{ codeId: string; sentAt: string }>;
}

// 最大リトライ回数（試行総数）
const MAX_NOTIFICATION_ATTEMPTS = 3;
// 指数バックオフの基底ミリ秒
const BACKOFF_BASE_MS = 1000;

// ISO文字列（あるいはnull/undefined）をUTC日付(YYYY-MM-DD)に整形
function formatUtcDate(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return null;
  }
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day} (UTC)`;
}

// Discord Webhook へ送るJSONペイロードを組み立て
function buildDiscordPayload(code: ShiftCode) {
  const codeDisplay = code.codeText ?? code.normalizedCodeText ?? 'Unknown';
  const lines = [
    `**Code:** \`${codeDisplay}\``,
    `**Sources:** ${code.sources.join(', ')}`,
    `**Status:** ${code.status}`,
    `**First seen:** ${formatUtcDate(code.firstSeenAt) ?? code.firstSeenAt}`,
  ];
  const formattedExpires = formatUtcDate(code.expiresAt);
  if (formattedExpires) {
    lines.push(`**Expires:** ${formattedExpires}`);
  } else {
    lines.push('**Expires:** Unknown');
  }
  if (code.rewardType) {
    lines.push(`**Reward:** ${code.rewardType}`);
  }
  if (code.metadata?.url) {
    lines.push(`**Source URL:** ${code.metadata.url}`);
  }
  if (code.metadata?.notes) {
    lines.push(code.metadata.notes);
  }

  return {
    content: '🚨 Borderlands 4 SHiFT code update!',
    embeds: [
      {
        title: 'New SHiFT Code discovered',
        description: lines.join('\n'),
        color: 0xffc43d,
        timestamp: new Date().toISOString(),
        footer: {
          text: 'Borderlands 4 SHiFT Monitor',
        },
      },
    ],
  };
}

/**
 * コード配列に対して通知を送信。
 * - DRY_RUN/未設定時は送信スキップしてログのみ
 * - 429 は Retry-After を解釈して再試行
 * - 5xx は指数バックオフで再試行
 */
export async function dispatchNotifications(
  env: WorkerEnv,
  codes: ShiftCode[],
): Promise<NotificationDispatchResult> {
  const result: NotificationDispatchResult = {
    sent: 0,
    attempted: codes.length,
    sentRecords: [],
  };

  if (!codes.length) {
    return result;
  }

  const isProd = env.MODE === 'PROD';
  const webhookUrl = env.DISCORD_WEBHOOK_URL;

  for (const code of codes) {
    const timestamp = toIsoString(new Date());

    if (!isProd || !webhookUrl) {
      await saveNotificationLog(env, {
        id: crypto.randomUUID(),
        codeId: code.id,
        status: 'SKIPPED',
        destination: 'DISCORD_WEBHOOK',
        createdAt: timestamp,
        error: !webhookUrl ? 'Webhook URL not configured' : 'DRY_RUN_MODE',
      });
      continue;
    }

    let delivered = false;
    let lastResponseStatus: number | undefined;
    let lastError: string | undefined;

    for (let attempt = 0; attempt < MAX_NOTIFICATION_ATTEMPTS && !delivered; attempt++) {
      try {
        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(buildDiscordPayload(code)),
        });

        lastResponseStatus = response.status;

        if (response.ok) {
          delivered = true;
          result.sent += 1;
          result.sentRecords.push({ codeId: code.id, sentAt: timestamp });
          await saveNotificationLog(env, {
            id: crypto.randomUUID(),
            codeId: code.id,
            status: 'SENT',
            destination: 'DISCORD_WEBHOOK',
            createdAt: timestamp,
            responseStatus: response.status,
          });
          break;
        }

        if (response.status === 429) {
          const retryAfterHeader = response.headers.get('Retry-After');
          const retrySeconds = parseRetryAfter(retryAfterHeader);
          if (attempt < MAX_NOTIFICATION_ATTEMPTS - 1) {
            await sleep(retrySeconds * 1000);
            continue;
          }
          lastError = 'HTTP 429';
          break;
        }

        if (response.status >= 500 && attempt < MAX_NOTIFICATION_ATTEMPTS - 1) {
          const delay = BACKOFF_BASE_MS * 2 ** attempt;
          await sleep(delay);
          continue;
        }

        lastError = `HTTP ${response.status}`;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Unknown error';
        if (attempt < MAX_NOTIFICATION_ATTEMPTS - 1) {
          const delay = BACKOFF_BASE_MS * 2 ** attempt;
          await sleep(delay);
          continue;
        }
        break;
      }
    }

    if (!delivered) {
      await saveNotificationLog(env, {
        id: crypto.randomUUID(),
        codeId: code.id,
        status: 'SKIPPED',
        destination: 'DISCORD_WEBHOOK',
        createdAt: timestamp,
        responseStatus: lastResponseStatus,
        error: lastError ?? 'Unknown error',
      });
    }
  }

  return result;
}

/**
 * Retry-After ヘッダを秒数に解釈。
 * - 数値型（秒）/ 日付型（HTTP-date）の両方を扱う
 * - 最小1秒、最大3600秒にクリップ
 */
function parseRetryAfter(header: string | null): number {
  if (!header) {
    return 1;
  }

  const numeric = Number(header);
  if (!Number.isNaN(numeric) && numeric >= 0) {
    return Math.max(1, Math.min(3600, Math.ceil(numeric)));
  }

  const dateValue = Date.parse(header);
  if (!Number.isNaN(dateValue)) {
    const diffSeconds = Math.ceil((dateValue - Date.now()) / 1000);
    return Math.max(1, Math.min(3600, diffSeconds));
  }

  return 1;
}
