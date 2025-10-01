/**
 * monitor.ts
 *
 * 各ソースからSHiFTコードを収集し、保存と通知を行う監視処理の中核。
 * - 新規コードは保存し、通知対象に積む
 * - 既存コードはメタデータやソース一覧をマージして更新
 * - 通知送信後は `notifiedAt` を反映
 */
import { listCodes, getCodeById, saveCode } from './storage';
import { dispatchNotifications } from './notifications';
import { ensureUnique, hashCode, toIsoString } from './utils';
import type { WorkerEnv } from './env';
import type { ShiftCode, CodeStatus, SourceName } from './models';

export interface MonitorResult {
  runId: string;
  runAt: string;
  totalCodes: number;
  newCodes: number;
  duplicatesSkipped: number;
  notificationsSent: number;
  errors: number;
  http429: number;
  http5xx: number;
  sourcesScanned: string[];
  scheduleDelaySeconds: number;
}

export async function runMonitor(env: WorkerEnv, now = new Date()): Promise<MonitorResult> {
  // 実行IDとタイムスタンプを採番
  const runId = crypto.randomUUID();
  const runAt = now.toISOString();
  const startTime = now.getTime();

  console.log(`Starting monitor run ${runId} at ${runAt}`);

  // 既存コードの全件を読み込み（重複判定・更新に利用）
  const allCodes = await listCodes(env);
  const newCodes: ShiftCode[] = [];
  const codesForNotification: ShiftCode[] = [];

  // 環境変数で有効化されたソースのみを対象にする
  const sources = [
    { name: 'OFFICIAL_SITE', url: env.SOURCE_OFFICIAL_SITE_URL },
    { name: 'OFFICIAL_X', url: env.SOURCE_OFFICIAL_X_URL },
    { name: 'MEDIA_TRUSTED', url: env.SOURCE_MEDIA_TRUSTED_URL },
    { name: 'COMMUNITY_AUX', url: env.SOURCE_COMMUNITY_AUX_URL },
  ].filter((source) => source.url);

  const sourcesScanned: string[] = [];
  let errors = 0;
  let http429 = 0;
  let http5xx = 0;

  // 各ソースを順次収集
  for (const source of sources) {
    try {
      console.log(`Fetching from ${source.name}: ${source.url}`);
      sourcesScanned.push(source.name);

      const fetchContext = {
        source: source.name as any,
        url: source.url!,
        runId,
        runAt,
      };

      const codes = await fetchFromSource(env, fetchContext);
      console.log(`Fetched ${codes.length} codes from ${source.name}`);

      for (const code of codes) {
        const existing = allCodes.find((c) => c.hash === code.hash);

        if (!existing) {
          // 新規コード: 保存して通知候補へ
          await saveCode(env, code);
          allCodes.push(code);
          newCodes.push(code);
          codesForNotification.push(code);
          console.log(`New code saved: ${code.id} (${code.normalizedCodeText})`);
        } else {
          // 既存コード: ソース統合・メタデータマージ・更新時刻反映
          const updated = {
            ...existing,
            sources: [...new Set([...existing.sources, ...code.sources])],
            updatedAt: code.updatedAt ?? toIsoString(now),
            metadata: {
              ...existing.metadata,
              ...code.metadata,
            },
          };

          await saveCode(env, updated);
          const index = allCodes.findIndex((c) => c.hash === code.hash);
          if (index >= 0) {
            allCodes[index] = updated;
          }

          if (!existing.metadata?.notifiedAt && shouldNotify(updated, now)) {
            codesForNotification.push(updated);
          }

          console.log(`Updated existing code: ${code.id} (${code.normalizedCodeText})`);
        }
      }
    } catch (error) {
      console.error(`Error fetching from ${source.name}:`, error);
      errors++;

      if (error instanceof Error) {
        // 簡易的なHTTP分類（429/5xx）
        if (error.message.includes('429')) {
          http429++;
        } else if (error.message.includes('5')) {
          http5xx++;
        }
      }
    }
  }

  // 通知をまとめてディスパッチ
  const { sent: notificationsSent, sentRecords } = await dispatchNotifications(env, codesForNotification);

  // 送信成功したコードに `notifiedAt` を反映
  for (const { codeId, sentAt } of sentRecords) {
    const code = allCodes.find((c) => c.id === codeId);
    if (code) {
      const updated = {
        ...code,
        metadata: {
          ...code.metadata,
          notifiedAt: sentAt,
        },
      };
      await saveCode(env, updated);
      const index = allCodes.findIndex((c) => c.id === codeId);
      if (index >= 0) {
        allCodes[index] = updated;
      }
    }
  }

  const endTime = new Date().getTime();
  const scheduleDelaySeconds = Math.round((endTime - startTime) / 1000);

  const result: MonitorResult = {
    runId,
    runAt,
    totalCodes: allCodes.length,
    newCodes: newCodes.length,
    duplicatesSkipped: allCodes.length - newCodes.length, // 単純差分で重複スキップ数の概算
    notificationsSent,
    errors,
    http429,
    http5xx,
    sourcesScanned,
    scheduleDelaySeconds,
  };

  console.log(`Monitor run ${runId} completed:`, result);
  return result;
}

/**
 * 通知可否の判定。
 * - フォールバックは通知しない
 * - 非Activeは通知しない
 * - 期限切れは通知しない
 */
function shouldNotify(code: ShiftCode, now: Date): boolean {
  if (code.metadata?.isFallback) {
    return false;
  }
  if (code.status !== 'Active') {
    return false;
  }
  if (code.expiresAt) {
    const expiresAt = Date.parse(code.expiresAt);
    if (!Number.isNaN(expiresAt) && expiresAt <= now.getTime()) {
      return false;
    }
  }
  return true;
}

async function fetchFromSource(
  env: WorkerEnv,
  context: { source: string; url: string; runId: string; runAt: string },
): Promise<ShiftCode[]> {
  const { source, url } = context;
  const sourceName = source as SourceName;

  switch (sourceName) {
    case 'OFFICIAL_SITE':
    case 'OFFICIAL_X':
    case 'COMMUNITY_AUX':
      // JSON配列 or { codes: [...] } を期待
      return fetchJsonFeed(env, url, sourceName);
    case 'MEDIA_TRUSTED':
      // PC Gamer の記事HTMLをパース
      return fetchPcGamerShiftCodes(env, url, sourceName);
    default:
      throw new Error(`Unknown source: ${source}`);
  }
}
const CODE_TITLE = 'BL4';
const SHIFT_CODE_PATTERN = /^[A-Z0-9]{5}(?:-[A-Z0-9]{5}){4}$/;
const SHIFT_CODE_FINDER = /[A-Z0-9]{5}(?:-[A-Z0-9]{5}){4}/g;
const STATUS_LOOKUP: Record<string, CodeStatus> = {
  active: 'Active',
  expired: 'Expired',
  hold: 'Hold',
};

interface ShiftCodeDraft {
  code: string;
  rewardType?: string;
  status?: string | CodeStatus;
  expiresAt?: string | null;
  firstSeenAt?: string;
  url?: string;
  notes?: string;
  isFallback?: boolean;
}

/**
 * JSONフィードを取得してドラフト配列へ正規化。
 */
async function fetchJsonFeed(env: WorkerEnv, url: string, sourceName: SourceName): Promise<ShiftCode[]> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Borderlands4-SHiFT-Monitor/1.0',
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const payload = await response.json();
  const entriesRaw: unknown[] = Array.isArray(payload)
    ? (payload as unknown[])
    : Array.isArray((payload as Record<string, unknown>)?.codes)
    ? ((payload as Record<string, unknown>).codes as unknown[])
    : [];

  if (!entriesRaw.length) {
    return [];
  }

  const entries = entriesRaw;
  const collectedAt = new Date();
  const drafts: ShiftCodeDraft[] = [];

  for (const rawEntry of entries) {
    if (!rawEntry || typeof rawEntry !== 'object') {
      continue;
    }
    const record = rawEntry as Record<string, unknown>;
    const code = pickString(record, ['code', 'code_text', 'shiftCode', 'shift_code']);
    if (!code) {
      continue;
    }

    drafts.push({
      code,
      rewardType: pickString(record, ['rewardType', 'reward_type', 'reward', 'description']),
      status: pickString(record, ['status']),
      expiresAt: pickString(record, ['expiresAt', 'expires_at', 'expires']),
      firstSeenAt: pickString(record, ['firstSeenAt', 'first_seen_at']),
      url: pickString(record, ['url']) ?? url,
      notes: pickString(record, ['notes']),
      isFallback: false,
    });
  }

  return draftsToShiftCodes(sourceName, drafts, collectedAt);
}

/**
 * PC Gamer のBL4シフトコード記事をスクレイピングし、テーブル/テキストからコード候補を抽出。
 */
async function fetchPcGamerShiftCodes(env: WorkerEnv, url: string, sourceName: SourceName): Promise<ShiftCode[]> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Borderlands4-SHiFT-Monitor/1.0',
      Accept: 'text/html,application/xhtml+xml',
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const html = await response.text();
  const collectedAt = new Date();
  const drafts: ShiftCodeDraft[] = [];

  const tableMatch = html.match(/<caption[^>]*>\s*Active Borderlands 4 Shift codes\s*<\/caption>[\s\S]*?<\/table>/i);
  if (tableMatch) {
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch: RegExpExecArray | null;

    while ((rowMatch = rowRegex.exec(tableMatch[0])) !== null) {
      const rowHtml = rowMatch[1];
      if (/table__head__row/i.test(rowHtml)) {
        continue;
      }

      const cells = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => stripHtml(match[1]));
      if (cells.length < 3) {
        continue;
      }

      const expiryText = cells[0];
      const rewardText = cells[1];
      const codeCellText = cells[2];
      const candidates = codeCellText.match(SHIFT_CODE_FINDER);
      if (!candidates) {
        continue;
      }

      for (const candidate of candidates) {
        drafts.push({
          code: candidate,
          rewardType: rewardText,
          status: 'Active',
          expiresAt: expiryText,
          url,
          notes: buildNotes(expiryText, rewardText),
          isFallback: false,
        });
      }
    }
  }

  if (!drafts.length) {
    const fallbackRegex = new RegExp(SHIFT_CODE_PATTERN.source, 'gi');
    let match: RegExpExecArray | null;
    while ((match = fallbackRegex.exec(html)) !== null) {
      const code = match[0];
      drafts.push({
        code,
        rewardType: 'Unknown',
        status: 'Active',
        notes: extractHtmlSnippet(html, match.index, code.length),
        url,
        isFallback: false,
      });
    }
  }

  return draftsToShiftCodes(sourceName, drafts, collectedAt);
}

// 複数候補キーから最初に見つかった非空文字列を返す
function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return undefined;
}

// コード文字列を大文字・正規フォーマットへ整形
function normalizeShiftCode(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return '';
  }
  const replaced = trimmed
    .replace(/[–—―]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[^A-Z0-9-]/gi, '')
    .replace(/-+/g, '-');
  return replaced.toUpperCase();
}

// ステータス文字列を標準化（未知は Active）
function sanitizeStatus(value: string | CodeStatus | undefined): CodeStatus {
  if (!value) {
    return 'Active';
  }
  const normalized = value.toString().trim().toLowerCase();
  return STATUS_LOOKUP[normalized] ?? 'Active';
}

// 初出日時の決定（解析可能ならその値、不可なら収集時刻）
function resolveFirstSeenAt(value: string | undefined, fallbackIso: string): string {
  if (value) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return toIsoString(new Date(parsed));
    }
  }
  return fallbackIso;
}

// 期限の正規化（補足括弧を削除してからDate.parse）
function resolveExpiresAt(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const cleaned = value.replace(/\(.*?\)/g, '').trim();
  if (!cleaned) {
    return null;
  }
  const parsed = Date.parse(cleaned);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return toIsoString(new Date(parsed));
}

// ドラフトからメタデータを構築（空なら undefined）
function buildMetadata(draft: ShiftCodeDraft): ShiftCode['metadata'] | undefined {
  const metadata: ShiftCode['metadata'] = {};
  if (draft.url) {
    metadata.url = draft.url;
  }
  if (draft.notes) {
    metadata.notes = draft.notes;
  }
  if (typeof draft.isFallback === 'boolean') {
    metadata.isFallback = draft.isFallback;
  }
  return Object.keys(metadata).length ? metadata : undefined;
}

// ドラフト1件をShiftCodeに変換（妥当性を満たさなければ null）
async function draftToShiftCode(
  sourceName: SourceName,
  draft: ShiftCodeDraft,
  collectedAt: Date,
): Promise<ShiftCode | null> {
  const normalized = normalizeShiftCode(draft.code);
  if (!SHIFT_CODE_PATTERN.test(normalized)) {
    return null;
  }

  const collectedIso = toIsoString(collectedAt);
  const firstSeenIso = resolveFirstSeenAt(draft.firstSeenAt, collectedIso);
  const expiresIso = resolveExpiresAt(draft.expiresAt);
  const rewardType = draft.rewardType && draft.rewardType.trim().length > 0 ? draft.rewardType.trim() : 'Unknown';
  const status = sanitizeStatus(draft.status as string | CodeStatus | undefined);
  const metadata = buildMetadata(draft);
  const hash = await hashCode(`${CODE_TITLE}:${normalized}`);

  const code: ShiftCode = {
    id: crypto.randomUUID(),
    title: CODE_TITLE,
    codeText: normalized,
    normalizedCodeText: normalized,
    rewardType,
    expiresAt: expiresIso,
    firstSeenAt: firstSeenIso,
    status,
    sources: [sourceName],
    hash,
    createdAt: collectedIso,
    updatedAt: collectedIso,
  };

  if (metadata) {
    code.metadata = metadata;
  }

  return code;
}

// 複数ドラフトをShiftCode配列へ。重複(hash)は情報をマージして除去
async function draftsToShiftCodes(
  sourceName: SourceName,
  drafts: ShiftCodeDraft[],
  collectedAt: Date,
): Promise<ShiftCode[]> {
  if (!drafts.length) {
    return [];
  }

  const results = await Promise.all(drafts.map((draft) => draftToShiftCode(sourceName, draft, collectedAt)));
  const deduped = new Map<string, ShiftCode>();

  for (const code of results) {
    if (!code) {
      continue;
    }
    const existing = deduped.get(code.hash);
    if (existing) {
      existing.sources = ensureUnique([...existing.sources, ...code.sources]);
      if ((!existing.rewardType || existing.rewardType === 'Unknown') && code.rewardType) {
        existing.rewardType = code.rewardType;
      }
      if (!existing.expiresAt && code.expiresAt) {
        existing.expiresAt = code.expiresAt;
      }
      if (!existing.metadata?.url && code.metadata?.url) {
        existing.metadata = { ...existing.metadata, url: code.metadata.url };
      }
      if (!existing.metadata?.notes && code.metadata?.notes) {
        existing.metadata = { ...existing.metadata, notes: code.metadata.notes };
      }
      continue;
    }
    deduped.set(code.hash, code);
  }

  return Array.from(deduped.values());
}

function stripHtml(raw: string): string {
  return raw
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildNotes(...parts: string[]): string | undefined {
  const combined = parts.map((part) => part.trim()).filter(Boolean).join(' ').trim();
  return combined.length ? combined : undefined;
}

function extractHtmlSnippet(html: string, index: number, length: number): string | undefined {
  const start = Math.max(0, index - 200);
  const end = Math.min(html.length, index + length + 200);
  const snippet = stripHtml(html.slice(start, end));
  return snippet.length ? snippet : undefined;
}export interface ResendOptions {
  codeIds?: string[];
  statuses?: CodeStatus[];
  limit?: number;
  includeFallback?: boolean;
  includeExpired?: boolean;
}

export interface ResendSummary {
  requested: number;
  attempted: number;
  sent: number;
  skipped: number;
}

export async function resendNotifications(
  env: WorkerEnv,
  options: ResendOptions = {},
): Promise<ResendSummary> {
  const allCodes = await listCodes(env);
  const codeIdSet = options.codeIds ? new Set(options.codeIds) : undefined;
  const statuses = options.statuses && options.statuses.length > 0 ? options.statuses : ['Active'];
  const limit = options.limit && options.limit > 0 ? options.limit : undefined;

  let selected = allCodes.filter((code) => {
    if (!options.includeFallback && code.metadata?.isFallback) {
      return false;
    }
    if (!options.includeExpired && code.expiresAt) {
      const expiresAtMs = Date.parse(code.expiresAt);
      if (!Number.isNaN(expiresAtMs) && expiresAtMs <= Date.now()) {
        return false;
      }
    }
    if (codeIdSet && !codeIdSet.has(code.id)) {
      return false;
    }
    if (statuses.length > 0 && !statuses.includes(code.status as CodeStatus)) {
      return false;
    }
    return true;
  });

  if (limit !== undefined && selected.length > limit) {
    selected = selected.slice(0, limit);
  }

  if (!selected.length) {
    return { requested: 0, attempted: 0, sent: 0, skipped: 0 };
  }

  const candidatesMap = new Map<string, ShiftCode>();
  for (const code of selected) {
    candidatesMap.set(code.id, {
      ...code,
      metadata: {
        ...code.metadata,
        notifiedAt: undefined,
      },
    });
  }

  const notificationCandidates = Array.from(candidatesMap.values());
  const dispatchResult = await dispatchNotifications(env, notificationCandidates);

  for (const { codeId, sentAt } of dispatchResult.sentRecords) {
    const stored = await getCodeById(env, codeId);
    if (!stored) {
      continue;
    }
    await saveCode(env, {
      ...stored,
      metadata: {
        ...stored.metadata,
        notifiedAt: sentAt,
      },
    });
  }

  return {
    requested: selected.length,
    attempted: dispatchResult.attempted,
    sent: dispatchResult.sent,
    skipped: dispatchResult.attempted - dispatchResult.sent,
  };
}












