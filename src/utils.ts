/**
 * 共通で使うユーティリティ関数群。
 */
import type { SourceName } from './models';

/**
 * SHiFTコードの入力を英数字だけの大文字に整える。
 */
export function normalizeCode(code: string): string {
  return code.replace(/[^A-Z0-9]/gi, '').toUpperCase();
}

/**
 * DateインスタンスをISO8601の文字列に変換する。
 */
export function toIsoString(date: Date): string {
  return date.toISOString();
}

/**
 * 文字列をSHA-256でハッシュ化し、16進文字列を返す。
 */
export async function hashCode(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = Array.from(new Uint8Array(digest));
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * 文字列を数値に変換し、失敗したらフォールバック値を返す。
 */
export function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * SOURCES_WHITELISTのJSON文字列を読み取り、SourceNameの配列に整形する。
 * JSONでない場合や配列でない場合はフォールバックを返す。
 */
export function parseWhitelist(raw: string | undefined, fallback: SourceName[]): SourceName[] {
  if (!raw) {
    return fallback;
  }
  try {
    const decoded = JSON.parse(raw);
    if (Array.isArray(decoded)) {
      return decoded.filter((item): item is SourceName =>
        typeof item === 'string'
      ) as SourceName[];
    }
  } catch (error) {
    console.warn('Failed to parse SOURCES_WHITELIST, using fallback', error);
  }
  return fallback;
}

/**
 * 配列から重複要素を取り除く。
 */
export function ensureUnique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

/**
 * 指定ミリ秒だけ待機するPromiseを返す。
 */
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 値を[min, max]の範囲に収める。
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}