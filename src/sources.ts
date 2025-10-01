/**
 * sources.ts
 *
 * 各種ソース（公式サイト/X/メディア/コミュニティ）からコードを収集するための
 * フェッチャーと整形処理を提供します。Cloudflare Worker 以外の実行環境からも
 * 再利用できるよう、純粋関数で構成しています。
 */
import type {
  SourceFetcher,
  SourceFetchResult,
  CollectedCode,
  SourceFetchContext,
  SourceName,
  CodeStatus,
} from './models';
import { toIsoString } from './utils';
import type { WorkerEnv } from './env';

// 環境変数キーとフォールバック用サンプルの束
interface SourceConfigEntry {
  envKey: keyof WorkerEnv | string;
  defaultCodes: CollectedCode[];
}

// メディア信頼ソースの既定URL（PC Gamer）
const DEFAULT_PC_GAMER_URL =
  'https://www.pcgamer.com/games/fps/borderlands-4-shift-codes/';
// 4-5桁ブロック×4-5の候補を抽出する正規表現（寛容）
const SHIFT_CODE_REGEX = /\b[A-Z0-9]{4,5}(?:-[A-Z0-9]{4,5}){3,4}\b/g;

const nowIso = () => toIsoString(new Date());

// 環境未設定時に返すサンプル（isFallback=true）
const SAMPLE_CODES: Record<SourceName, CollectedCode[]> = {
  OFFICIAL_SITE: [
    {
      code: 'BL4A1-EDGE0-CR0N0-G0LDN-KEY00',
      rewardType: 'Golden Keys',
      status: 'Active',
      firstSeenAt: nowIso(),
      notes: 'Sample code from official site feed',
      isFallback: true,
    },
  ],
  OFFICIAL_X: [
    {
      code: 'BL4TW-1TT3R-FAK3-C0D3-EDGE0',
      rewardType: 'Vault Card',
      status: 'Active',
      firstSeenAt: nowIso(),
      notes: 'Sample code from X (Twitter)',
      isFallback: true,
    },
  ],
  MEDIA_TRUSTED: [
    {
      code: 'BL4MD-PR3SS-FAK3-C0D3-EDGE0',
      rewardType: 'Cosmetic',
      status: 'Hold',
      firstSeenAt: nowIso(),
      notes: 'Sample code from media partner',
      isFallback: true,
    },
  ],
  COMMUNITY_AUX: [
    {
      code: 'BL4CM-UNITY-AUX0-FAK3-C0D3',
      rewardType: 'Shift Pack',
      status: 'Hold',
      firstSeenAt: nowIso(),
      notes: 'Sample community-discovered code',
      isFallback: true,
    },
  ],
};

const SOURCE_CONFIG: Record<SourceName, SourceConfigEntry> = {
  OFFICIAL_SITE: {
    envKey: 'SOURCE_OFFICIAL_SITE_URL',
    defaultCodes: SAMPLE_CODES.OFFICIAL_SITE,
  },
  OFFICIAL_X: {
    envKey: 'SOURCE_OFFICIAL_X_URL',
    defaultCodes: SAMPLE_CODES.OFFICIAL_X,
  },
  MEDIA_TRUSTED: {
    envKey: 'SOURCE_MEDIA_TRUSTED_URL',
    defaultCodes: SAMPLE_CODES.MEDIA_TRUSTED,
  },
  COMMUNITY_AUX: {
    envKey: 'SOURCE_COMMUNITY_AUX_URL',
    defaultCodes: SAMPLE_CODES.COMMUNITY_AUX,
  },
};

// 簡易HTML除去（改行/空白整理含む）
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

// コンテキスト文からリワード名/数量を推定
function extractReward(text: string): string {
  const rewardMatches = [
    /([0-9]+)\s+Golden\s+Keys?/i,
    /([0-9]+)\s+Diamond\s+Keys?/i,
    /([0-9]+)\s+Skeleton\s+Keys?/i,
    /([0-9]+)x\s+Golden\s+Key/i,
    /([0-9]+)x\s+Diamond\s+Key/i,
    /([0-9]+)x\s+Skeleton\s+Key/i,
    /Vault\s+Card/i,
    /Cosmetic/i,
  ];

  for (const pattern of rewardMatches) {
    const match = text.match(pattern);
    if (match) {
      if (match.length > 1) {
        const quantity = match[1];
        const descriptor = stripHtml(match[0]).replace(quantity, '').trim();
        return `${quantity} ${descriptor}`.trim();
      }
      return stripHtml(match[0]);
    }
  }

  const cleaned = stripHtml(text);
  return cleaned.length > 0 ? cleaned : 'Unknown';
}

// コンテキスト文からステータスを推定
function extractStatus(text: string): CodeStatus {
  if (/expired/i.test(text)) {
    return 'Expired';
  }
  if (/hold/i.test(text)) {
    return 'Hold';
  }
  return 'Active';
}

// コンテキスト文から期限（ISO）を抽出
function extractExpiry(text: string): string | null {
  const cleaned = stripHtml(text.replace(/\(.*?\)/g, '').trim());
  const parsed = Date.parse(cleaned);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString();
  }
  return null;
}

// コード文字列と併記文から収集レコードを構築
function buildCodeFromContext(code: string, context: string): CollectedCode {
  return {
    code,
    rewardType: extractReward(context),
    status: extractStatus(context),
    expiresAt: extractExpiry(context),
    firstSeenAt: nowIso(),
    notes: context,
    isFallback: false,
  };
}

/**
 * PC Gamer 記事をスクレイピングしてコード候補を抽出。
 * テーブル優先、なければ全体から正規表現で後方互換的に抽出。
 */
async function fetchPcGamerShiftCodes(url?: string): Promise<CollectedCode[]> {
  const targetUrl = url ?? DEFAULT_PC_GAMER_URL;
  const response = await fetch(targetUrl, {
    headers: {
      'User-Agent': 'shift-code-monitor-worker/1.0',
      Accept: 'text/html,application/xhtml+xml',
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const html = await response.text();
  const codesById = new Map<string, CollectedCode>();

  const activeTableMatch = html.match(
    /<caption[^>]*>\s*Active Borderlands 4 Shift codes\s*<\/caption>[\s\S]*?<\/table>/i,
  );

  if (activeTableMatch) {
    const tableHtml = activeTableMatch[0];
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch: RegExpExecArray | null;

    while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
      const rowHtml = rowMatch[1];
      if (/table__head__row/i.test(rowHtml)) {
        continue;
      }

      const cellMatches = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)];
      if (!cellMatches.length) {
        continue;
      }

      const cells = cellMatches.map((cell) => stripHtml(cell[1]));
      if (cells.length < 3) {
        continue;
      }

      const expiryText = cells[0];
      const rewardText = cells[1];
      const codeText = cells[2];
      const codeMatches = codeText.match(SHIFT_CODE_REGEX);
      if (!codeMatches) {
        continue;
      }

      for (const code of codeMatches) {
        const normalized = code.toUpperCase();
        if (codesById.has(normalized)) {
          continue;
        }
        const context = `${expiryText} ${rewardText}`;
        codesById.set(normalized, {
          code: normalized,
          rewardType: extractReward(rewardText),
          status: 'Active',
          expiresAt: extractExpiry(expiryText),
          firstSeenAt: nowIso(),
          url: targetUrl,
          notes: context,
          isFallback: false,
        });
      }
    }
  }

  if (!codesById.size) {
    let regexMatch: RegExpExecArray | null;
    while ((regexMatch = SHIFT_CODE_REGEX.exec(html)) !== null) {
      const code = regexMatch[0].toUpperCase();
      if (codesById.has(code)) {
        continue;
      }
      const start = Math.max(0, regexMatch.index - 200);
      const end = Math.min(html.length, regexMatch.index + code.length + 200);
      const snippet = stripHtml(html.slice(start, end));
      codesById.set(code, {
        ...buildCodeFromContext(code, snippet),
        url: targetUrl,
      });
    }
  }

  return Array.from(codesById.values());
}

/**
 * JSONフィードから `CollectedCode[]` を構築。
 * - 配列 or { codes: [...] } の2形をサポート
 */
async function fetchJsonFeed(url: string): Promise<CollectedCode[]> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'shift-code-monitor-worker/1.0',
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const body = await response.json();
  if (Array.isArray(body)) {
    return body
      .map((entry) => normalizeEntry(entry as Record<string, unknown>))
      .filter(Boolean) as CollectedCode[];
  }

  const candidate = (body as Record<string, unknown>).codes;
  if (Array.isArray(candidate)) {
    return candidate
      .map((entry: unknown) => normalizeEntry(entry as Record<string, unknown>))
      .filter(Boolean) as CollectedCode[];
  }

  throw new Error('Unexpected feed format');
}

// JSONの1エントリを正規化（不足項目は既定で補完）
function normalizeEntry(entry: Record<string, unknown>): CollectedCode | null {
  const code =
    typeof entry.code === 'string'
      ? entry.code
      : typeof entry.code_text === 'string'
      ? entry.code_text
      : null;
  if (!code) {
    return null;
  }
  const reward =
    typeof entry.rewardType === 'string'
      ? entry.rewardType
      : typeof entry.reward_type === 'string'
      ? (entry.reward_type as string)
      : 'Unknown';
  const status =
    typeof entry.status === 'string' && ['Active', 'Expired', 'Hold'].includes(entry.status)
      ? (entry.status as CollectedCode['status'])
      : 'Active';
  const expiresAt =
    typeof entry.expiresAt === 'string'
      ? (entry.expiresAt as string)
      : typeof entry.expires_at === 'string'
      ? (entry.expires_at as string)
      : null;
  const firstSeenAt =
    typeof entry.firstSeenAt === 'string'
      ? (entry.firstSeenAt as string)
      : typeof entry.first_seen_at === 'string'
      ? (entry.first_seen_at as string)
      : undefined;
  const url = typeof entry.url === 'string' ? entry.url : undefined;
  const notes = typeof entry.notes === 'string' ? entry.notes : undefined;
  return {
    code,
    rewardType: reward,
    status,
    expiresAt,
    firstSeenAt,
    url,
    notes,
    isFallback: false,
  };
}

/**
 * ソース別フェッチャーの実体。
 * - MEDIA_TRUSTED は PC Gamer HTML パース
 * - その他は JSON フィード
 * - 失敗時はフォールバックサンプルに切替
 */
async function runSourceFetcher(
  env: WorkerEnv,
  source: SourceName,
  context: SourceFetchContext,
): Promise<SourceFetchResult> {
  const config = SOURCE_CONFIG[source];
  const url = (env as unknown as Record<string, string | undefined>)[config.envKey];
  let http429 = 0;
  let http5xx = 0;

  if (source === 'MEDIA_TRUSTED') {
    try {
      const codes = await fetchPcGamerShiftCodes(url);
      return { source, codes, http429, http5xx };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('HTTP ')) {
        if (error.message.includes('429')) {
          http429 += 1;
        }
        if (error.message.match(/5\d{2}/)) {
          http5xx += 1;
        }
      }
      console.error(`Failed to fetch media source ${url ?? DEFAULT_PC_GAMER_URL}`, error);
    }
  } else if (url) {
    try {
      const codes = await fetchJsonFeed(url);
      return { source, codes, http429, http5xx };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('HTTP ')) {
        if (error.message.includes('429')) {
          http429 += 1;
        }
        if (error.message.match(/5\d{2}/)) {
          http5xx += 1;
        }
      }
      console.error(`Failed to fetch ${url}`, error);
    }
  }

  const fallback = config.defaultCodes.map((entry) => ({
    ...entry,
    firstSeenAt: entry.firstSeenAt ?? nowIso(),
    isFallback: true,
  }));
  return {
    source,
    codes: fallback,
    http429,
    http5xx,
  };
}

export const sourceFetchers: Record<SourceName, SourceFetcher> = {
  OFFICIAL_SITE: (env, context) => runSourceFetcher(env, 'OFFICIAL_SITE', context),
  OFFICIAL_X: (env, context) => runSourceFetcher(env, 'OFFICIAL_X', context),
  MEDIA_TRUSTED: (env, context) => runSourceFetcher(env, 'MEDIA_TRUSTED', context),
  COMMUNITY_AUX: (env, context) => runSourceFetcher(env, 'COMMUNITY_AUX', context),
};



