import dotenv from "dotenv";

dotenv.config();

export const DEFAULT_POLYGON_RPC_URL = "https://rpc-mainnet.matic.quiknode.pro";

export const POLYGON_RPC_FALLBACKS: string[] = [
  "https://rpc-mainnet.matic.quiknode.pro",
  "https://polygon.gateway.tenderly.co",
  "https://1rpc.io/matic",
  "https://api.zan.top/polygon-mainnet",
];

export const DEFAULT_RELAYER_URL = "https://relayer-v2.polymarket.com";

function env(key: string, defaultValue?: string): string {
  const v = process.env[key] ?? defaultValue;
  if (v === undefined || v === "") throw new Error(`Missing env: ${key}`);
  return v;
}

function envOpt(key: string): string | undefined {
  const v = process.env[key];
  if (v == null) return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

function envBool(key: string, defaultValue: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === "") return defaultValue;
  return ["true", "1", "yes"].includes(v.toLowerCase());
}

function envInt(key: string, defaultValue: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return defaultValue;
  return Number.parseInt(v, 10);
}

function envFloat(key: string, defaultValue: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return defaultValue;
  return Number.parseFloat(v);
}

function envList(key: string, defaultList: string[]): string[] {
  const v = process.env[key];
  if (v === undefined || v.trim() === "") return [...defaultList];
  return v
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

export type UpDownTimeframe = "5m" | "15m" | "1h";

export function parseUpDownTimeframe(raw: string): UpDownTimeframe {
  const s = raw.toLowerCase().trim();
  if (s === "5m" || s === "15m" || s === "1h") return s;
  throw new Error(`Invalid UP_DOWN_TIMEFRAME: "${raw}". Use 5m, 15m, or 1h.`);
}

export function timeframeDurationSeconds(tf: UpDownTimeframe): number {
  if (tf === "5m") return 300;
  if (tf === "15m") return 900;
  if (tf === "1h") return 3600;
  throw new Error(tf);
}

export interface PolymarketConfig {
  gammaApiUrl: string;
  clobApiUrl: string;
  apiKey?: string;
  apiSecret?: string;
  apiPassphrase?: string;
  privateKey?: string;
  proxyWalletAddress?: string;
  signatureType: number;
  chainId: number;
  orderUsdSlippageMult: number;
  polygonRpcUrl?: string;
  autoRedeem: boolean;
  redeemUseRelayer: boolean;
  relayerUrl: string;
  /** Как раньше: gasless redeem через Settings → API Key (не POLY_BUILDER). */
  relayerApiKey?: string;
  relayerApiKeyAddress?: string;
  polyBuilderApiKey?: string;
  polyBuilderSecret?: string;
  polyBuilderPassphrase?: string;
}

export interface TradingConfig {
  checkIntervalMs: number;
  clobWsUrl: string;
  websocketDebounceMs: number;
  monitorUseHttp: boolean;
  marketClosureCheckIntervalSeconds: number;
  markets: string[];
  upDownTimeframe: UpDownTimeframe;
  dumpHedgeShares: number;
  dumpHedgeSumTarget: number;
  dumpHedgeMoveThreshold: number;
  dumpHedgeWindowMinutes: number;
  dumpHedgeStopLossMaxWaitMinutes: number;
  dumpHedgeStopLossPercentage: number;
  dumpHedgeStopLossUseLimitLadder: boolean;
}

export interface AppConfig {
  polymarket: PolymarketConfig;
  trading: TradingConfig;
  simulation: boolean;
  historyLogDir: string;
}

export function loadConfig(options?: {
  forceProductionCli?: boolean;
}): AppConfig {
  const production =
    envBool("PRODUCTION", false) || Boolean(options?.forceProductionCli);
  const simulation = !production;
  const tf = parseUpDownTimeframe(envOpt("UP_DOWN_TIMEFRAME") ?? "15m");
  const relayerTrim = (envOpt("RELAYER_URL") ?? "").trim();

  return {
    polymarket: {
      gammaApiUrl: env("GAMMA_API_URL", "https://gamma-api.polymarket.com"),
      clobApiUrl: env("CLOB_API_URL", "https://clob.polymarket.com"),
      apiKey: envOpt("API_KEY"),
      apiSecret: envOpt("API_SECRET"),
      apiPassphrase: envOpt("API_PASSPHRASE"),
      privateKey: envOpt("PRIVATE_KEY"),
      proxyWalletAddress: envOpt("PROXY_WALLET_ADDRESS"),
      signatureType: envInt("SIGNATURE_TYPE", 2),
      chainId: envInt("CHAIN_ID", 137),
      orderUsdSlippageMult: envFloat("ORDER_USD_SLIPPAGE_MULT", 1.02),
      polygonRpcUrl: envOpt("POLYGON_RPC_URL"),
      autoRedeem: envBool("AUTO_REDEEM", true),
      redeemUseRelayer: envBool("REDEEM_USE_RELAYER", false),
      relayerUrl: relayerTrim || DEFAULT_RELAYER_URL,
      relayerApiKey: envOpt("RELAYER_API_KEY"),
      relayerApiKeyAddress: envOpt("RELAYER_API_KEY_ADDRESS"),
      polyBuilderApiKey: envOpt("POLY_BUILDER_API_KEY"),
      polyBuilderSecret: envOpt("POLY_BUILDER_SECRET"),
      polyBuilderPassphrase: envOpt("POLY_BUILDER_PASSPHRASE"),
    },
    trading: {
      checkIntervalMs: envInt("CHECK_INTERVAL_MS", 1000),
      clobWsUrl: env(
        "CLOB_WS_URL",
        "wss://ws-subscriptions-clob.polymarket.com/ws/market",
      ),
      websocketDebounceMs: envInt("WEBSOCKET_DEBOUNCE_MS", 0),
      monitorUseHttp: envBool("MONITOR_USE_HTTP", false),
      marketClosureCheckIntervalSeconds: envInt(
        "MARKET_CLOSURE_CHECK_INTERVAL_SECONDS",
        20,
      ),
      markets: envList("MARKETS", ["btc"]).map((m) => m.toLowerCase()),
      upDownTimeframe: tf,
      dumpHedgeShares: envFloat("DUMP_HEDGE_SHARES", 10),
      dumpHedgeSumTarget: envFloat("DUMP_HEDGE_SUM_TARGET", 0.95),
      dumpHedgeMoveThreshold: envFloat("DUMP_HEDGE_MOVE_THRESHOLD", 0.15),
      dumpHedgeWindowMinutes: envInt("DUMP_HEDGE_WINDOW_MINUTES", 2),
      dumpHedgeStopLossMaxWaitMinutes: envInt(
        "DUMP_HEDGE_STOP_LOSS_MAX_WAIT_MINUTES",
        5,
      ),
      dumpHedgeStopLossPercentage: envFloat(
        "DUMP_HEDGE_STOP_LOSS_PERCENTAGE",
        0.2,
      ),
      dumpHedgeStopLossUseLimitLadder: envBool(
        "DUMP_HEDGE_STOP_LOSS_USE_LIMIT_LADDER",
        true,
      ),
    },
    simulation,
    historyLogDir: (envOpt("HISTORY_LOG_DIR") ?? "logs").trim() || "logs",
  };
}
