/**
 * Cloudflare R2 を使ったストレージ操作周りのユーティリティ。
 * - コードや検知ログ、通知ログ、メトリクスなどをR2に保存・取得する
 * - 旧KVストレージからの読み替えと移行処理もここで吸収する
 */
import type {
  DetectionLog,
  NotificationLog,
  RunMetrics,
  ShiftCode,
  SourceName,
  SourceTrustRecord,
} from './models';
import type { WorkerEnv } from './env';

const CODE_PREFIX = 'codes/';
const DETECTION_PREFIX = 'logs/detection/';
const NOTIFICATION_PREFIX = 'logs/notification/';
const METRICS_KEY = 'state/metrics.json';
const TRUST_PREFIX = 'state/trust/';
const SOURCE_STATE_PREFIX = 'state/source/';
const MIGRATION_MARKER_KEY = 'state/migration-complete';

/**
 * R2からJSONを読み出し、存在しなければnullを返す。
 */
async function getJsonFromR2<T>(env: WorkerEnv, key: string): Promise<T | null> {
  const object = await env.R2.get(key);
  if (!object) {
    return null;
  }
  return (await object.json<T>()) ?? null;
}

/**
 * JSONをR2に保存する。content-typeも合わせて設定する。
 */
async function putJsonToR2(env: WorkerEnv, key: string, value: unknown): Promise<void> {
  await env.R2.put(key, JSON.stringify(value), {
    httpMetadata: {
      contentType: 'application/json',
    },
  });
}

/**
 * 指定したプレフィックス以下のオブジェクトをまとめて削除する。
 */
async function deleteByPrefix(env: WorkerEnv, prefix: string): Promise<void> {
  let cursor: string | undefined;
  while (true) {
    const listing = await env.R2.list({ prefix, cursor });
    if (listing.objects.length) {
      await Promise.all(listing.objects.map((object) => env.R2.delete(object.key)));
    }
    if (!listing.truncated) {
      break;
    }
    cursor = (listing as unknown as { cursor?: string }).cursor;
    if (!cursor) {
      break;
    }
  }
}

// KV→R2移行を一度だけ実行するためのフラグ。
let migrationAttempted = false;

/**
 * KVに残っているコードデータをR2へ一度だけ移行する。
 */
async function migrateFromKVIfAvailable(env: WorkerEnv): Promise<void> {
  if (migrationAttempted) {
    return;
  }
  migrationAttempted = true;

  if (!env.SHIFT_STATE) {
    return;
  }

  const marker = await env.R2.get(MIGRATION_MARKER_KEY);
  if (marker) {
    return;
  }

  let cursor: string | undefined;
  while (true) {
    const kvListing = await env.SHIFT_STATE.list({ prefix: 'code:', cursor });
    if (kvListing.keys.length) {
      await Promise.all(
        kvListing.keys.map(async (entry) => {
          const code = await env.SHIFT_STATE!.get<ShiftCode>(entry.name, 'json');
          if (!code) {
            return;
          }
          const key = `${CODE_PREFIX}${code.id}.json`;
          const existing = await getJsonFromR2<ShiftCode>(env, key);
          if (existing) {
            return;
          }
          await putJsonToR2(env, key, code);
        }),
      );
    }
    if (!kvListing.list_complete && kvListing.cursor) {
      cursor = kvListing.cursor;
      continue;
    }
    break;
  }

  await env.R2.put(MIGRATION_MARKER_KEY, 'ok', {
    httpMetadata: { contentType: 'text/plain' },
  });
}

/**
 * コードIDを基にR2かKVからデータを読み込む。
 */
async function loadShiftCode(env: WorkerEnv, id: string): Promise<ShiftCode | null> {
  const key = `${CODE_PREFIX}${id}.json`;
  const code = await getJsonFromR2<ShiftCode>(env, key);
  if (code) {
    return code;
  }

  if (env.SHIFT_STATE) {
    const kvCode = await env.SHIFT_STATE.get<ShiftCode>(`code:${id}`, 'json');
    if (kvCode) {
      await putJsonToR2(env, key, kvCode);
      return kvCode;
    }
  }

  return null;
}

/**
 * 値に変更があったときだけR2へ保存する。
 */
async function saveShiftCodeIfChanged(env: WorkerEnv, code: ShiftCode): Promise<void> {
  const existing = await loadShiftCode(env, code.id);
  if (existing && JSON.stringify(existing) === JSON.stringify(code)) {
    return;
  }
  await putJsonToR2(env, `${CODE_PREFIX}${code.id}.json`, code);
}

export async function saveCode(env: WorkerEnv, code: ShiftCode): Promise<void> {
  await migrateFromKVIfAvailable(env);
  await saveShiftCodeIfChanged(env, code);
}

export async function getCodeById(env: WorkerEnv, id: string): Promise<ShiftCode | null> {
  await migrateFromKVIfAvailable(env);
  return loadShiftCode(env, id);
}

export async function getCodeByHash(env: WorkerEnv, hash: string): Promise<ShiftCode | null> {
  // 現状はID = ハッシュなのでそのまま流用。
  return getCodeById(env, hash);
}

export async function listCodes(env: WorkerEnv): Promise<ShiftCode[]> {
  await migrateFromKVIfAvailable(env);
  const codes: ShiftCode[] = [];
  let cursor: string | undefined;

  while (true) {
    const listing = await env.R2.list({ prefix: CODE_PREFIX, cursor });
    if (listing.objects.length) {
      const loaded = await Promise.all(
        listing.objects.map((object) => getJsonFromR2<ShiftCode>(env, object.key)),
      );
      codes.push(...loaded.filter((code): code is ShiftCode => Boolean(code)));
    }
    if (!listing.truncated) {
      break;
    }
    cursor = (listing as unknown as { cursor?: string }).cursor;
    if (!cursor) {
      break;
    }
  }

  return codes.sort((a, b) => {
    const aTime = Date.parse(a.updatedAt ?? a.createdAt);
    const bTime = Date.parse(b.updatedAt ?? b.createdAt);
    if (Number.isNaN(aTime) || Number.isNaN(bTime)) {
      return a.id.localeCompare(b.id);
    }
    return bTime - aTime;
  });
}

/**
 * 検知ログを保存する。必要に応じて上位でUUIDを割り振ってから渡すこと。
 */
export async function saveDetectionLog(env: WorkerEnv, log: DetectionLog): Promise<void> {
  await env.R2.put(`${DETECTION_PREFIX}${log.id}.json`, JSON.stringify(log), {
    httpMetadata: { contentType: 'application/json' },
  });
}

export async function listDetectionLogs(env: WorkerEnv, limit = 100): Promise<DetectionLog[]> {
  const logs: DetectionLog[] = [];
  let cursor: string | undefined;

  while (logs.length < limit) {
    const listing = await env.R2.list({ prefix: DETECTION_PREFIX, cursor });
    if (listing.objects.length) {
      const loaded = await Promise.all(
        listing.objects.map((object) => getJsonFromR2<DetectionLog>(env, object.key)),
      );
      logs.push(...loaded.filter((log): log is DetectionLog => Boolean(log)));
      if (logs.length >= limit) {
        break;
      }
    }
    if (!listing.truncated) {
      break;
    }
    cursor = (listing as unknown as { cursor?: string }).cursor;
    if (!cursor) {
      break;
    }
  }

  return logs
    .sort((a, b) => Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt))
    .slice(0, limit);
}

export async function saveNotificationLog(env: WorkerEnv, log: NotificationLog): Promise<void> {
  await env.R2.put(`${NOTIFICATION_PREFIX}${log.id}.json`, JSON.stringify(log), {
    httpMetadata: { contentType: 'application/json' },
  });
}

export async function listNotificationLogs(env: WorkerEnv, limit = 100): Promise<NotificationLog[]> {
  const logs: NotificationLog[] = [];
  let cursor: string | undefined;

  while (logs.length < limit) {
    const listing = await env.R2.list({ prefix: NOTIFICATION_PREFIX, cursor });
    if (listing.objects.length) {
      const loaded = await Promise.all(
        listing.objects.map((object) => getJsonFromR2<NotificationLog>(env, object.key)),
      );
      logs.push(...loaded.filter((log): log is NotificationLog => Boolean(log)));
      if (logs.length >= limit) {
        break;
      }
    }
    if (!listing.truncated) {
      break;
    }
    cursor = (listing as unknown as { cursor?: string }).cursor;
    if (!cursor) {
      break;
    }
  }

  return logs
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit);
}

export async function getMetrics(env: WorkerEnv): Promise<RunMetrics | null> {
  const metrics = await getJsonFromR2<RunMetrics>(env, METRICS_KEY);
  if (metrics) {
    return metrics;
  }

  if (env.SHIFT_CACHE) {
    const kvMetrics = await env.SHIFT_CACHE.get<RunMetrics>('metrics:latest', 'json');
    if (kvMetrics) {
      await putJsonToR2(env, METRICS_KEY, kvMetrics);
      return kvMetrics;
    }
  }

  return null;
}

export async function saveMetrics(env: WorkerEnv, metrics: RunMetrics): Promise<void> {
  const existing = await getMetrics(env);
  if (existing && JSON.stringify(existing) === JSON.stringify(metrics)) {
    return;
  }
  await putJsonToR2(env, METRICS_KEY, metrics);
}

export async function getSourceTrust(env: WorkerEnv, source: SourceName): Promise<SourceTrustRecord | null> {
  const record = await getJsonFromR2<SourceTrustRecord>(env, `${TRUST_PREFIX}${source}.json`);
  if (record) {
    return record;
  }
  if (env.SHIFT_CACHE) {
    const kvRecord = await env.SHIFT_CACHE.get<SourceTrustRecord>(`${source}:trust`, 'json');
    if (kvRecord) {
      await putJsonToR2(env, `${TRUST_PREFIX}${source}.json`, kvRecord);
      return kvRecord;
    }
  }
  return null;
}

export async function setSourceTrust(
  env: WorkerEnv,
  source: SourceName,
  score: number,
  timestampIso: string,
): Promise<SourceTrustRecord> {
  const record: SourceTrustRecord = {
    source,
    score,
    lastUpdated: timestampIso,
  };
  await putJsonToR2(env, `${TRUST_PREFIX}${source}.json`, record);
  return record;
}

export async function listSourceTrust(env: WorkerEnv): Promise<SourceTrustRecord[]> {
  const records: SourceTrustRecord[] = [];
  let cursor: string | undefined;
  while (true) {
    const listing = await env.R2.list({ prefix: TRUST_PREFIX, cursor });
    if (listing.objects.length) {
      const loaded = await Promise.all(
        listing.objects.map(async (object) => getJsonFromR2<SourceTrustRecord>(env, object.key)),
      );
      records.push(...loaded.filter((record): record is SourceTrustRecord => Boolean(record)));
    }
    if (!listing.truncated) {
      break;
    }
    cursor = (listing as unknown as { cursor?: string }).cursor;
    if (!cursor) {
      break;
    }
  }

  if (!records.length && env.SHIFT_CACHE) {
    const kvListing = await env.SHIFT_CACHE.list();
    for (const entry of kvListing.keys) {
      if (!entry.name.endsWith(':trust')) {
        continue;
      }
      const kvRecord = await env.SHIFT_CACHE.get<SourceTrustRecord>(entry.name, 'json');
      if (!kvRecord) {
        continue;
      }
      records.push(kvRecord);
      await putJsonToR2(env, `${TRUST_PREFIX}${kvRecord.source}.json`, kvRecord);
    }
  }

  return records.sort((a, b) => (a.source < b.source ? -1 : 1));
}

export async function getLastSourceFetchTimestamp(env: WorkerEnv, source: SourceName): Promise<string | null> {
  const object = await env.R2.get(`${SOURCE_STATE_PREFIX}${source}.txt`);
  if (object) {
    const text = await object.text();
    return text || null;
  }

  if (env.SHIFT_CACHE) {
    const kvValue = await env.SHIFT_CACHE.get<string>(`${source}:last-run`);
    if (kvValue) {
      await setLastSourceFetchTimestamp(env, source, kvValue);
      return kvValue;
    }
  }

  return null;
}

export async function setLastSourceFetchTimestamp(
  env: WorkerEnv,
  source: SourceName,
  timestampIso: string,
): Promise<void> {
  // 最終取得時刻をテキストとして保存する。
  await env.R2.put(`${SOURCE_STATE_PREFIX}${source}.txt`, timestampIso, {
    httpMetadata: { contentType: 'text/plain' },
  });
}

/**
 * ストレージ全体を初期化するユーティリティ（テストやリセット用）。
 */
export async function resetStorage(env: WorkerEnv): Promise<void> {
  await deleteByPrefix(env, CODE_PREFIX);
  await deleteByPrefix(env, DETECTION_PREFIX);
  await deleteByPrefix(env, NOTIFICATION_PREFIX);
  await deleteByPrefix(env, TRUST_PREFIX);
  await deleteByPrefix(env, SOURCE_STATE_PREFIX);
  await env.R2.delete(METRICS_KEY);
  await env.R2.delete(MIGRATION_MARKER_KEY);
}