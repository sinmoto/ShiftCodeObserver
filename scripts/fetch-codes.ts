/**
 * fetch-codes.ts
 *
 * GitHub Actions などの汎用ランタイムから SHiFT コードの収集を行うスクリプト。
 * Cloudflare 環境に依存せず、必要な `WorkerEnv` をモックして実行します。
 * `--json` フラグで機械可読な JSON を出力し、未指定時は人間可読なサマリを出力します。
 */
import type { WorkerEnv } from "../src/env";
import type { SourceFetchContext, SourceFetchResult, SourceName } from "../src/models";
import { sourceFetchers } from "../src/sources";

// Node 互換の最小限の `process` 情報を表す型
type RuntimeProcess = { argv?: string[]; exitCode?: number };
// 環境変数のキー/値マップ（未設定は undefined）
type RuntimeEnv = Record<string, string | undefined>;

// グローバルに存在するかもしれない `process` を安全に参照するための型
type RuntimeGlobals = {
  process?: RuntimeProcess & { env?: RuntimeEnv };
};

// 実行環境から `process.env` を取り出す（存在しない環境でも動作するようフォールバック）
const runtimeGlobals = globalThis as unknown as RuntimeGlobals;
const runtimeEnv: RuntimeEnv = runtimeGlobals.process?.env ?? {};

// 収集結果を出力用にまとめた型
interface FetchOutput {
  source: SourceName; // 収集元ソース名
  count: number; // 取得したコード件数
  codes: SourceFetchResult["codes"]; // コード本体配列
}

// 実行時に外部から注入可能な `WorkerEnv` のキー一覧
const ENV_KEYS: Array<keyof WorkerEnv> = [
  "LOG_LEVEL",
  "DISCORD_WEBHOOK_URL",
  "SOURCES_WHITELIST",
  "SCHEDULE_OFFICIAL_MINUTES",
  "SCHEDULE_MEDIA_MINUTES",
  "SCHEDULE_COMMUNITY_MINUTES",
  "BACKFILL_DAYS",
  "RETRY_MAX",
  "RETRY_BASE_MS",
  "RETRY_JITTER_PCT",
  "SOURCE_OFFICIAL_SITE_URL",
  "SOURCE_OFFICIAL_X_URL",
  "SOURCE_MEDIA_TRUSTED_URL",
  "SOURCE_COMMUNITY_AUX_URL",
  "JITTER_PCT",
];

/**
 * Cloudflare 実行環境を模した `WorkerEnv` を生成します。
 * - R2 は副作用のないモックを提供
 * - MODE は `MODE=PROD` 指定時のみ `PROD`、それ以外は `DRY_RUN`
 * - ENV_KEYS に列挙したキーは `process.env` から取り込み
 */
function createMockEnv(): WorkerEnv {
  const noop = async () => undefined;

  const mockR2 = {
    get: async () => null,
    put: noop,
    delete: noop,
    list: async () => ({
      objects: [],
      truncated: false,
    }),
  } as unknown as WorkerEnv["R2"];

  const mode = runtimeEnv.MODE === "PROD" ? "PROD" : "DRY_RUN";
  const env = {
    MODE: mode,
    R2: mockR2,
  } as WorkerEnv;

  for (const key of ENV_KEYS) {
    const value = runtimeEnv[key as string];
    if (typeof value === "string" && value.length > 0) {
      (env as unknown as Record<string, string | WorkerEnv["R2"]>)[key as string] = value;
    }
  }

  return env;
}

/**
 * すべての `sourceFetchers` を走査してコードを収集します。
 * 返り値は出力用に `source`/`count`/`codes` をまとめた配列。
 */
async function fetchCodes(context: SourceFetchContext): Promise<FetchOutput[]> {
  const env = createMockEnv();
  const entries = Object.entries(sourceFetchers) as Array<[
    SourceName,
    (env: WorkerEnv, context: SourceFetchContext) => Promise<SourceFetchResult>
  ]>;

  const results: FetchOutput[] = [];
  for (const [source, fetcher] of entries) {
    const result = await fetcher(env, context);
    results.push({
      source,
      count: result.codes.length,
      codes: result.codes,
    });
  }
  return results;
}

/**
 * プレーンテキストとして結果を出力します。
 */
function printHumanReadable(results: FetchOutput[]): void {
  const total = results.reduce((sum, entry) => sum + entry.count, 0);
  console.log(`Fetched ${total} codes across ${results.length} sources.`);
  for (const entry of results) {
    console.log(`\n# ${entry.source} (${entry.count})`);
    if (!entry.codes.length) {
      console.log("(no codes)");
      continue;
    }
    for (const code of entry.codes) {
      const reward = code.rewardType ?? "Unknown";
      const status = code.status ?? "Active";
      const expires = code.expiresAt ?? "Unknown";
      console.log(`- ${code.code} | reward: ${reward} | status: ${status} | expires: ${expires}`);
    }
  }
}

/**
 * 取得の遡及期間（日）を環境変数 `BACKFILL_DAYS` から解釈。
 * 不正または未設定の場合は既定値 14 を返します。
 */
function parseBackfillDays(): number {
  const override = runtimeEnv.BACKFILL_DAYS;
  if (!override) {
    return 14;
  }
  const parsed = Number(override);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 14;
}

/**
 * エントリポイント。
 * - 引数 `--json` で JSON 出力、それ以外は人間可読出力
 * - 例外時は exitCode=1 を設定
 */
async function main() {
  try {
    const argv = runtimeGlobals.process?.argv ?? [];
    const useJson = argv.includes("--json");
    const context: SourceFetchContext = {
      mode: "DRY_RUN",
      backfillDays: parseBackfillDays(),
    };

    const results = await fetchCodes(context);

    if (useJson) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      printHumanReadable(results);
    }
  } catch (error) {
    console.error("Failed to fetch codes:", error);
    if (runtimeGlobals.process) {
      runtimeGlobals.process.exitCode = 1;
    }
  }
}

await main();
