/**
 * CLOB trading helpers (Python `clob_trading.py` parity).
 */

import {
  type ApiKeyCreds,
  type Chain,
  ClobClient,
  OrderType,
  Side,
  type TickSize,
  type UserOrder,
} from "@polymarket/clob-client";
import { Wallet, utils } from "ethers";
import type { PolymarketConfig } from "./config";

export function warnProductionWalletSettings(cfg: PolymarketConfig): void {
  if (
    (cfg.signatureType === 1 || cfg.signatureType === 2) &&
    !(cfg.proxyWalletAddress ?? "").trim()
  ) {
    process.stderr.write(
      "Предупреждение: SIGNATURE_TYPE 1 или 2 обычно требует PROXY_WALLET_ADDRESS " +
        "(адрес, где лежат средства). Иначе ордера могут отклоняться.\n",
    );
  }
}

function isValidApiKeyCreds(c: unknown): c is ApiKeyCreds {
  if (c == null || typeof c !== "object") return false;
  const o = c as Record<string, unknown>;
  return (
    typeof o.key === "string" &&
    o.key.length > 0 &&
    typeof o.secret === "string" &&
    o.secret.length > 0 &&
    typeof o.passphrase === "string" &&
    o.passphrase.length > 0
  );
}

async function deriveOrCreateApiCreds(
  tempClient: ClobClient,
): Promise<ApiKeyCreds> {
  const derived = await tempClient.deriveApiKey();
  if (isValidApiKeyCreds(derived)) return derived;
  const created = await tempClient.createApiKey();
  if (isValidApiKeyCreds(created)) return created;
  throw new Error(
    "Could not derive or create CLOB API credentials. Check PRIVATE_KEY.",
  );
}

export async function buildClobClient(
  cfg: PolymarketConfig,
): Promise<ClobClient> {
  const pk = (cfg.privateKey ?? "").trim();
  if (!pk) throw new Error("Для реальной торговли задайте PRIVATE_KEY в .env");
  const signer = new Wallet(pk);
  let funder: string | undefined;
  if (cfg.proxyWalletAddress?.trim()) {
    funder = utils.getAddress(cfg.proxyWalletAddress.trim());
  }
  let creds: ApiKeyCreds;
  const envKey = cfg.apiKey?.trim();
  const envSec = cfg.apiSecret?.trim();
  const envPass = cfg.apiPassphrase?.trim();
  if (envKey && envSec && envPass) {
    creds = { key: envKey, secret: envSec, passphrase: envPass };
  } else if (envKey || envSec || envPass) {
    throw new Error(
      "Задайте все три: API_KEY, API_SECRET, API_PASSPHRASE — или ни одного (derive из PRIVATE_KEY).",
    );
  } else {
    const temp = new ClobClient(cfg.clobApiUrl, cfg.chainId as Chain, signer);
    creds = await deriveOrCreateApiCreds(temp);
  }
  return new ClobClient(
    cfg.clobApiUrl,
    cfg.chainId as Chain,
    signer,
    creds,
    cfg.signatureType,
    funder,
  );
}

function asTickSize(t: string): TickSize {
  if (t === "0.1" || t === "0.01" || t === "0.001" || t === "0.0001") return t;
  return "0.01";
}

export async function postMarketBuyUsd(
  client: ClobClient,
  args: {
    tokenId: string;
    shares: number;
    referencePrice: number;
    slippageMult: number;
    feeRateBps: number;
  },
): Promise<unknown> {
  if (args.referencePrice <= 0)
    throw new Error(
      "reference_price должен быть > 0 для расчёта бюджета ордера",
    );
  if (args.shares <= 0) throw new Error("shares должен быть > 0");
  let usd = args.shares * args.referencePrice * args.slippageMult;
  if (usd < 1.0) usd = Math.max(usd, 1.0);
  const signed = await client.createMarketBuyOrder(
    {
      tokenID: args.tokenId,
      amount: usd,
      price: args.referencePrice,
      feeRateBps: args.feeRateBps,
    },
    await client.getTickSize(args.tokenId),
  );
  return client.postOrder(signed, OrderType.FOK);
}

export async function postLimitOrderGtc(
  client: ClobClient,
  args: {
    tokenId: string;
    side: "BUY" | "SELL";
    price: number;
    size: number;
    tickSize: string;
    negRisk: boolean;
    feeRateBps: number;
  },
): Promise<unknown> {
  if (args.size <= 0) throw new Error("size must be > 0");
  if (args.price <= 0) throw new Error("price must be > 0");
  const side = args.side === "BUY" ? Side.BUY : Side.SELL;
  const userOrder: UserOrder = {
    tokenID: args.tokenId,
    price: args.price,
    size: args.size,
    side,
    feeRateBps: args.feeRateBps,
  };
  const signed = await client.createOrder(userOrder, asTickSize(args.tickSize));
  return client.postOrder(signed, OrderType.GTC);
}

export async function clobCancelOrder(
  client: ClobClient,
  orderId: string,
): Promise<unknown> {
  return client.cancelOrder({ orderID: orderId });
}

export async function clobGetOrder(
  client: ClobClient,
  orderId: string,
): Promise<unknown> {
  return client.getOrder(orderId);
}
