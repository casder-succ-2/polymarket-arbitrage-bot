/**
 * Polymarket Gamma + CLOB + optional trading client (Python `polymarket_api.py` parity).
 */

import type { ClobClient } from "@polymarket/clob-client";
import { utils } from "ethers";
import {
  clobCancelOrder,
  clobGetOrder,
  postLimitOrderGtc,
  postMarketBuyUsd,
} from "./clobTrading";
import {
  DEFAULT_POLYGON_RPC_URL,
  POLYGON_RPC_FALLBACKS,
  type PolymarketConfig,
} from "./config";
import { getContractConfig } from "./contractConfig";
import {
  checkConditionResolvedOnchain,
  sendRedeemPositions,
  sendRedeemViaGnosisSafe,
  sendRedeemViaPolymarketRelayer,
} from "./ctfRedeem";
import { requestJson } from "./httpClient";
import type { Market, MarketDetails, MarketToken } from "./models";

export function roundPriceToTick(price: number, tick: string): number {
  const t = Number.parseFloat(tick || "0.01");
  if (t <= 0)
    return Math.min(0.99, Math.max(0.01, Math.round(price * 10_000) / 10_000));
  const lo = t;
  const hi = 1.0 - t;
  const x = Math.min(Math.max(price, lo), hi);
  const n = Math.round(x / t);
  const out = n * t;
  return Math.min(Math.max(out, lo), hi);
}

function gammaPriceIsResolvedWinner(p: unknown): boolean {
  try {
    return Number.parseFloat(String(p)) >= 0.99;
  } catch {
    return false;
  }
}

function parseGammaJsonField(val: unknown): unknown[] {
  if (val == null) return [];
  if (Array.isArray(val)) return val;
  if (typeof val === "string") {
    try {
      const out = JSON.parse(val) as unknown;
      return Array.isArray(out) ? out : [];
    } catch {
      return [];
    }
  }
  return [];
}

export class PolymarketApi {
  private readonly cfg: PolymarketConfig;
  private readonly gamma: string;
  private readonly clob: string;
  private readonly clobTrading: ClobClient | null;
  private readonly makerFeeBps = new Map<string, number>();

  constructor(cfg: PolymarketConfig, clobTrading: ClobClient | null = null) {
    this.cfg = cfg;
    this.gamma = cfg.gammaApiUrl.replace(/\/$/, "");
    this.clob = cfg.clobApiUrl.replace(/\/$/, "");
    this.clobTrading = clobTrading;
  }

  async getMarketBySlug(slug: string): Promise<Market> {
    const enc = encodeURIComponent(slug).replace(/%2F/g, "/");
    const url = `${this.gamma}/events/slug/${enc}`;
    const { data } = await requestJson(url);
    if (typeof data !== "object" || data == null)
      throw new Error("Invalid gamma response");
    const d = data as Record<string, unknown>;
    let markets = d.markets as unknown;
    if (!markets && typeof d.event === "object" && d.event != null) {
      markets = (d.event as Record<string, unknown>).markets;
    }
    if (!Array.isArray(markets) || markets.length === 0)
      throw new Error("Gamma: no markets in response");
    const m = markets[0] as Record<string, unknown>;
    if (typeof m !== "object" || m == null)
      throw new Error("Invalid market object");
    return {
      conditionId: String(m.conditionId ?? m.condition_id ?? ""),
      id: m.id != null ? String(m.id) : undefined,
      question: String(m.question ?? ""),
      slug: String(m.slug ?? slug),
      active: Boolean(m.active),
      closed: Boolean(m.closed),
      tokens: Array.isArray(m.tokens)
        ? (m.tokens as Array<Record<string, unknown>>)
        : undefined,
      clobTokenIds: (m.clobTokenIds ?? m.clob_token_ids) as string | undefined,
      outcomes: m.outcomes as string | undefined,
    };
  }

  private async gammaMarketByConditionId(
    conditionId: string,
  ): Promise<Record<string, unknown> | null> {
    const cid = (conditionId || "").trim();
    if (!cid) return null;
    const url = `${this.gamma}/markets?condition_ids=${encodeURIComponent(cid)}`;
    try {
      const { data } = await requestJson(url);
      if (!Array.isArray(data) || data.length === 0) return null;
      const m = data[0];
      return typeof m === "object" && m != null
        ? (m as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  private mergeGammaResolution(
    details: MarketDetails,
    g: Record<string, unknown>,
  ): MarketDetails {
    const uma = String(g.umaResolutionStatus ?? "")
      .trim()
      .toLowerCase();
    const gClosed = Boolean(g.closed);
    const prices = parseGammaJsonField(g.outcomePrices);
    const clobIds = parseGammaJsonField(g.clobTokenIds).map((x) => String(x));
    const gammaResolved =
      gClosed ||
      uma === "resolved" ||
      prices.some((p) => gammaPriceIsResolvedWinner(p));

    if (!gammaResolved) return details;

    let winnerIdx: number | null = null;
    for (let i = 0; i < prices.length; i++) {
      if (gammaPriceIsResolvedWinner(prices[i])) {
        winnerIdx = i;
        break;
      }
    }

    const newTokens: MarketToken[] = [];
    if (details.tokens.length > 0 && clobIds.length > 0 && winnerIdx != null) {
      for (const t of details.tokens) {
        let win = false;
        if (clobIds.includes(t.tokenId)) {
          const idx = clobIds.indexOf(t.tokenId);
          if (idx >= 0) win = idx === winnerIdx;
        }
        newTokens.push({ tokenId: t.tokenId, outcome: t.outcome, winner: win });
      }
    } else if (
      details.tokens.length === 0 &&
      clobIds.length > 0 &&
      prices.length > 0
    ) {
      const outcomes = parseGammaJsonField(g.outcomes).map((x) => String(x));
      for (let i = 0; i < clobIds.length; i++) {
        const o = i < outcomes.length ? outcomes[i] : "";
        const win = winnerIdx != null && i === winnerIdx;
        newTokens.push({ tokenId: clobIds[i]!, outcome: o, winner: win });
      }
    }

    if (newTokens.length > 0)
      return {
        ...details,
        closed: true,
        tokens: newTokens,
      };
    return { ...details, closed: true };
  }

  async getMarket(conditionId: string): Promise<MarketDetails> {
    const url = `${this.clob}/markets/${encodeURIComponent(conditionId)}`;
    const { data } = await requestJson(url);
    if (typeof data !== "object" || data == null)
      throw new Error("Invalid CLOB market response");
    const j = data as Record<string, unknown>;
    if (j.error) throw new Error(`CLOB market ${conditionId}: ${j.error}`);
    const rawTokens = (j.tokens as unknown[]) || [];
    const tokens: MarketToken[] = [];
    for (const t of rawTokens) {
      if (typeof t !== "object" || t == null) continue;
      const o = t as Record<string, unknown>;
      tokens.push({
        tokenId: String(o.token_id ?? ""),
        outcome: String(o.outcome ?? ""),
        winner: Boolean(o.winner),
      });
    }
    let details: MarketDetails = {
      conditionId: String(j.condition_id ?? conditionId),
      acceptingOrders: Boolean(j.accepting_orders),
      active: Boolean(j.active),
      closed: Boolean(j.closed),
      makerBaseFee: String(j.maker_base_fee ?? "0"),
      tokens,
      negRisk: Boolean(j.neg_risk),
      minimumTickSize: String(j.minimum_tick_size ?? "0.01"),
    };
    const resolved = details.closed || tokens.some((t) => t.winner);
    if (!resolved) {
      const g = await this.gammaMarketByConditionId(conditionId);
      if (g) details = this.mergeGammaResolution(details, g);
    }
    return details;
  }

  async getMakerFeeBps(conditionId: string): Promise<number> {
    const hit = this.makerFeeBps.get(conditionId);
    if (hit != null) return hit;
    const m = await this.getMarket(conditionId);
    const bps = Math.round(Number.parseFloat(m.makerBaseFee));
    this.makerFeeBps.set(conditionId, bps);
    return bps;
  }

  async getPrice(tokenId: string, side: string): Promise<number> {
    const q = new URLSearchParams({ token_id: tokenId, side });
    const url = `${this.clob}/price?${q}`;
    const { data } = await requestJson(url);
    if (
      typeof data !== "object" ||
      data == null ||
      (data as { price?: unknown }).price == null
    )
      throw new Error("Invalid price response");
    return Number((data as { price: string }).price);
  }

  async placeMarketOrder(
    tokenId: string,
    amount: number,
    side: string,
    conditionId: string,
    _tickSize = "0.01",
    options?: { referencePrice?: number },
  ): Promise<Record<string, unknown>> {
    void _tickSize;
    if (this.clobTrading == null) {
      throw new Error(
        "Нет аутентифицированного ClobClient. Установите @polymarket/clob-client, PRODUCTION=true и PRIVATE_KEY.",
      );
    }
    const s = side.toUpperCase();
    if (s !== "BUY")
      throw new Error("Поддерживается только сторона BUY для этой стратегии.");
    const feeRateBps = await this.getMakerFeeBps(conditionId);
    const ref = options?.referencePrice ?? 0;
    return postMarketBuyUsd(this.clobTrading, {
      tokenId,
      shares: amount,
      referencePrice: ref,
      slippageMult: this.cfg.orderUsdSlippageMult,
      feeRateBps,
    }) as Promise<Record<string, unknown>>;
  }

  async placeLimitOrder(
    tokenId: string,
    side: string,
    price: number,
    size: number,
    conditionId: string,
  ): Promise<Record<string, unknown>> {
    if (this.clobTrading == null) {
      throw new Error(
        "Нет ClobClient для лимитных ордеров (PRODUCTION=true, PRIVATE_KEY).",
      );
    }
    const details = await this.getMarket(conditionId);
    const tick = details.minimumTickSize || "0.01";
    const feeRateBps = await this.getMakerFeeBps(conditionId);
    return postLimitOrderGtc(this.clobTrading, {
      tokenId,
      side: side.toUpperCase() as "BUY" | "SELL",
      price: roundPriceToTick(price, tick),
      size,
      tickSize: tick,
      negRisk: details.negRisk,
      feeRateBps,
    }) as Promise<Record<string, unknown>>;
  }

  async cancelClobOrder(orderId: string): Promise<void> {
    if (this.clobTrading == null) return;
    await clobCancelOrder(this.clobTrading, orderId);
  }

  async cancelClobOrdersForMarket(conditionId: string): Promise<void> {
    if (this.clobTrading == null) return;
    try {
      await this.clobTrading.cancelMarketOrders({ market: conditionId });
    } catch {
      /* ignore */
    }
  }

  async getClobOrder(orderId: string): Promise<Record<string, unknown> | null> {
    if (this.clobTrading == null) return null;
    try {
      const o = await clobGetOrder(this.clobTrading, orderId);
      return typeof o === "object" && o != null
        ? (o as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  static orderFullyFilled(order: Record<string, unknown>): boolean {
    const st = String(order.status ?? "").toUpperCase();
    if (st.includes("CANCEL")) return false;
    if (
      st.includes("MATCH") ||
      st.includes("FILLED") ||
      st === "CLOSED" ||
      st === "FILLED"
    )
      return true;
    try {
      const om = Number(order.size_matched ?? order.sizeMatched ?? 0);
      const oz = Number(
        order.original_size ?? order.originalSize ?? order.size ?? 0,
      );
      if (oz > 0 && om >= oz - 1e-9) return true;
    } catch {
      /* ignore */
    }
    return false;
  }

  async isResolvedOnchain(conditionId: string): Promise<boolean> {
    let negRisk = false;
    try {
      const details = await this.getMarket(conditionId);
      negRisk = details.negRisk;
    } catch {
      negRisk = false;
    }
    const cc = getContractConfig(this.cfg.chainId, negRisk);
    const rpc =
      (this.cfg.polygonRpcUrl ?? "").trim() || DEFAULT_POLYGON_RPC_URL;
    return checkConditionResolvedOnchain({
      rpcUrl: rpc,
      ctfContract: cc.conditionalTokens,
      conditionIdHex: conditionId,
      rpcFallbacks: POLYGON_RPC_FALLBACKS,
    });
  }

  async redeemPositionsForCondition(
    conditionId: string,
  ): Promise<Record<string, unknown>> {
    if (!this.cfg.autoRedeem) {
      return {
        status: "skipped",
        reason: "AUTO_REDEEM=false",
        condition_id: conditionId,
      };
    }
    const pk = (this.cfg.privateKey ?? "").trim();
    if (!pk) {
      return {
        status: "skipped",
        reason: "PRIVATE_KEY unset",
        condition_id: conditionId,
      };
    }

    const details = await this.getMarket(conditionId);
    const cc = getContractConfig(this.cfg.chainId, details.negRisk);

    if (this.cfg.redeemUseRelayer) {
      const k = (this.cfg.polyBuilderApiKey ?? "").trim();
      const s = (this.cfg.polyBuilderSecret ?? "").trim();
      const p = (this.cfg.polyBuilderPassphrase ?? "").trim();
      if (!k || !s || !p) {
        return {
          status: "skipped",
          reason:
            "REDEEM_USE_RELAYER=true, нужны POLY_BUILDER_API_KEY/SECRET/PASSPHRASE",
          condition_id: conditionId,
        };
      }
      try {
        const out = await sendRedeemViaPolymarketRelayer({
          relayerUrl: this.cfg.relayerUrl,
          privateKey: pk,
          chainId: this.cfg.chainId,
          collateralToken: cc.collateral,
          ctfContract: cc.conditionalTokens,
          conditionIdHex: conditionId,
          builderApiKey: k,
          builderSecret: s,
          builderPassphrase: p,
        });
        return { ...out, condition_id: conditionId };
      } catch (e) {
        return {
          status: "error",
          reason: String(e),
          condition_id: conditionId,
        };
      }
    }

    const rpc =
      (this.cfg.polygonRpcUrl ?? "").trim() || DEFAULT_POLYGON_RPC_URL;
    const proxy = (this.cfg.proxyWalletAddress ?? "").trim();

    try {
      if (proxy) {
        const out = await sendRedeemViaGnosisSafe({
          rpcUrl: rpc,
          privateKey: pk,
          chainId: this.cfg.chainId,
          safeAddress: utils.getAddress(proxy),
          collateralToken: cc.collateral,
          ctfContract: cc.conditionalTokens,
          conditionIdHex: conditionId,
          rpcFallbacks: POLYGON_RPC_FALLBACKS,
        });
        return { ...out, condition_id: conditionId };
      }
      const out = await sendRedeemPositions({
        rpcUrl: rpc,
        privateKey: pk,
        chainId: this.cfg.chainId,
        collateralToken: cc.collateral,
        ctfContract: cc.conditionalTokens,
        conditionIdHex: conditionId,
        proxyWalletAddress: proxy || undefined,
        rpcFallbacks: POLYGON_RPC_FALLBACKS,
      });
      return { ...out, condition_id: conditionId };
    } catch (e) {
      return {
        status: "error",
        reason: String(e),
        condition_id: conditionId,
      };
    }
  }

  async redeemTokens(
    conditionId: string,
    _tokenId: string,
    _outcome: string,
  ): Promise<Record<string, unknown>> {
    return this.redeemPositionsForCondition(conditionId);
  }
}
