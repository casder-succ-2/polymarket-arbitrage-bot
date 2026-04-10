/**
 * Market monitor: CLOB WebSocket or HTTP polling (Python `monitor.py` parity).
 */

import WebSocket from "ws";
import type { PolymarketApi } from "./api";
import { logToHistory, setHistoryLogPeriod } from "./historyLog";
import type { Market, MarketData, MarketSnapshot, TokenPrice } from "./models";

function parsePx(x: unknown): number {
  try {
    return Number.parseFloat(String(x));
  } catch {
    return 0;
  }
}

export class MarketMonitor {
  private static readonly LOG_THROTTLE_SECS = 1.0;

  private readonly api: PolymarketApi;
  private readonly marketName: string;
  private market: Market;
  private readonly checkIntervalMs: number;
  private readonly periodDurationSecs: number;
  private readonly clobWsUrl: string;
  private readonly wsDebounceMs: number;
  private readonly monitorUseHttp: boolean;

  private upTokenId: string | null = null;
  private downTokenId: string | null = null;
  private lastMarketRefresh: number | null = null;
  private readonly quotes = new Map<string, { bid?: number; ask?: number }>();
  private lastEmitMs = 0;
  private lastLogTime = 0;
  private wsActive: WebSocket | null = null;
  private currentPeriodTs: number;

  constructor(
    api: PolymarketApi,
    marketName: string,
    market: Market,
    checkIntervalMs: number,
    periodDurationSecs: number,
    options?: {
      clobWsUrl?: string;
      websocketDebounceMs?: number;
      monitorUseHttp?: boolean;
    },
  ) {
    this.api = api;
    this.marketName = marketName;
    this.market = market;
    this.checkIntervalMs = checkIntervalMs;
    this.periodDurationSecs = periodDurationSecs;
    this.clobWsUrl =
      (options?.clobWsUrl ?? "").replace(/\/$/, "") ||
      "wss://ws-subscriptions-clob.polymarket.com/ws/market";
    this.wsDebounceMs = Math.max(0, options?.websocketDebounceMs ?? 0);
    this.monitorUseHttp = options?.monitorUseHttp ?? false;
    const now = Math.floor(Date.now() / 1000);
    this.currentPeriodTs =
      Math.floor(now / periodDurationSecs) * periodDurationSecs;
  }

  updateMarket(market: Market): void {
    process.stderr.write(
      `Updating ${this.marketName} market...\nNew ${this.marketName} Market: ${market.slug} (${market.conditionId})\n`,
    );
    this.market = market;
    this.upTokenId = null;
    this.downTokenId = null;
    this.lastMarketRefresh = null;
    this.quotes.clear();
    if (this.wsActive) {
      try {
        this.wsActive.close();
      } catch {
        /* ignore */
      }
      this.wsActive = null;
    }
    const now = Math.floor(Date.now() / 1000);
    this.currentPeriodTs =
      Math.floor(now / this.periodDurationSecs) * this.periodDurationSecs;
  }

  getCurrentConditionId(): string {
    return this.market.conditionId;
  }

  getCurrentMarketTimestamp(): number {
    return MarketMonitor.extractTimestampFromSlug(this.market.slug);
  }

  static extractTimestampFromSlug(slug: string): number {
    const i = slug.lastIndexOf("-");
    if (i === -1) return 0;
    const n = Number.parseInt(slug.slice(i + 1), 10);
    return Number.isNaN(n) ? 0 : n;
  }

  static extractDurationFromSlug(slug: string): number {
    if (slug.includes("-5m-")) return 300;
    if (slug.includes("-15m-")) return 900;
    if (slug.includes("-1h-")) return 3600;
    return 900;
  }

  private async refreshMarketTokens(): Promise<void> {
    const now = Date.now() / 1000;
    const should =
      this.lastMarketRefresh == null ||
      now - this.lastMarketRefresh >= this.periodDurationSecs;
    if (!should) return;
    const mid = this.getCurrentConditionId();
    process.stderr.write(
      `${this.marketName}: Refreshing tokens for market: ${mid.slice(0, 16)}...\n`,
    );
    try {
      const details = await this.api.getMarket(mid);
      for (const token of details.tokens) {
        const ou = token.outcome.toUpperCase();
        if (ou.includes("UP") || ou === "1") {
          this.upTokenId = token.tokenId;
          process.stderr.write(
            `${this.marketName} Up token_id: ${token.tokenId}\n`,
          );
        } else if (ou.includes("DOWN") || ou === "0") {
          this.downTokenId = token.tokenId;
          process.stderr.write(
            `${this.marketName} Down token_id: ${token.tokenId}\n`,
          );
        }
      }
    } catch {
      /* ignore */
    }
    this.lastMarketRefresh = now;
  }

  private async fetchTokenPrice(
    tokenId: string | null,
    outcome: string,
  ): Promise<TokenPrice | null> {
    if (!tokenId) return null;
    let bid: number | null = null;
    let ask: number | null = null;
    try {
      bid = await this.api.getPrice(tokenId, "BUY");
    } catch (e) {
      process.stderr.write(
        `Failed to fetch ${this.marketName} ${outcome} BUY price: ${e}\n`,
      );
    }
    try {
      ask = await this.api.getPrice(tokenId, "SELL");
    } catch (e) {
      process.stderr.write(
        `Failed to fetch ${this.marketName} ${outcome} SELL price: ${e}\n`,
      );
    }
    if (bid != null || ask != null) return { tokenId, bid, ask };
    return null;
  }

  private async snapshotFromQuotesHttp(): Promise<MarketSnapshot> {
    await this.refreshMarketTokens();
    const slug = this.market.slug;
    const conditionId = this.market.conditionId;
    const periodTs = MarketMonitor.extractTimestampFromSlug(slug);
    setHistoryLogPeriod(periodTs);
    const currentTs = Math.floor(Date.now() / 1000);
    const duration = MarketMonitor.extractDurationFromSlug(slug);
    const periodEnd = periodTs + duration;
    const remaining = periodEnd > currentTs ? periodEnd - currentTs : 0;

    const upPrice = await this.fetchTokenPrice(this.upTokenId, "Up");
    const downPrice = await this.fetchTokenPrice(this.downTokenId, "Down");

    const fmtRem = (s: number) => {
      if (s <= 0) return "0s";
      const m = Math.floor(s / 60);
      const sec = s % 60;
      return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
    };
    const fmtP = (p: TokenPrice) => {
      const b = p.bid ?? 0;
      const a = p.ask ?? 0;
      return `BID:$${b.toFixed(2)} ASK:$${a.toFixed(2)}`;
    };
    const upStr = upPrice ? fmtP(upPrice) : "N/A";
    const downStr = downPrice ? fmtP(downPrice) : "N/A";
    logToHistory(
      `${this.marketName} Up Token ${upStr} Down Token ${downStr} ` +
        `remaining time:${fmtRem(remaining)} market_timestamp:${periodTs}\n`,
    );

    const data: MarketData = {
      conditionId,
      marketName: this.marketName,
      upToken: upPrice,
      downToken: downPrice,
    };
    return {
      marketName: this.marketName,
      btcMarket15m: data,
      timestampMs: Date.now(),
      btc15mTimeRemaining: remaining,
      btc15mPeriodTimestamp: periodTs,
    };
  }

  private tokenPriceFromQuote(tokenId: string | null): TokenPrice | null {
    if (!tokenId) return null;
    const q = this.quotes.get(tokenId);
    if (!q) return null;
    const bid = q.bid;
    const ask = q.ask;
    if (bid == null && ask == null) return null;
    return { tokenId, bid: bid ?? null, ask: ask ?? null };
  }

  private snapshotFromQuotesWs(): MarketSnapshot | null {
    const slug = this.market.slug;
    const conditionId = this.market.conditionId;
    const periodTs = MarketMonitor.extractTimestampFromSlug(slug);
    setHistoryLogPeriod(periodTs);
    const nowF = Date.now() / 1000;
    const currentTs = Math.floor(nowF);
    const duration = MarketMonitor.extractDurationFromSlug(slug);
    const periodEnd = periodTs + duration;
    const remaining = periodEnd > currentTs ? periodEnd - currentTs : 0;

    const upPrice = this.tokenPriceFromQuote(this.upTokenId);
    const downPrice = this.tokenPriceFromQuote(this.downTokenId);
    if (!upPrice || !downPrice) return null;
    if ((upPrice.bid ?? 0) <= 0 || (upPrice.ask ?? 0) <= 0) return null;
    if ((downPrice.bid ?? 0) <= 0 || (downPrice.ask ?? 0) <= 0) return null;

    if (nowF - this.lastLogTime >= MarketMonitor.LOG_THROTTLE_SECS) {
      this.lastLogTime = nowF;
      const fmtRem = (s: number) => {
        if (s <= 0) return "0s";
        const m = Math.floor(s / 60);
        const sec = s % 60;
        return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
      };
      const fmtP = (p: TokenPrice) => {
        const b = p.bid ?? 0;
        const a = p.ask ?? 0;
        return `BID:$${b.toFixed(2)} ASK:$${a.toFixed(2)}`;
      };
      logToHistory(
        `${this.marketName} Up Token ${fmtP(upPrice)} Down Token ${fmtP(downPrice)} ` +
          `remaining time:${fmtRem(remaining)} market_timestamp:${periodTs}\n`,
      );
    }

    const data: MarketData = {
      conditionId,
      marketName: this.marketName,
      upToken: upPrice,
      downToken: downPrice,
    };
    return {
      marketName: this.marketName,
      btcMarket15m: data,
      timestampMs: Math.floor(nowF * 1000),
      btc15mTimeRemaining: remaining,
      btc15mPeriodTimestamp: periodTs,
    };
  }

  private bestFromBook(
    bids: unknown,
    asks: unknown,
  ): [number | null, number | null] {
    let bestBid: number | null = null;
    let bestAsk: number | null = null;
    if (Array.isArray(bids) && bids.length > 0) {
      const ps: number[] = [];
      for (const x of bids) {
        if (typeof x === "object" && x != null && "price" in x) {
          ps.push(parsePx((x as { price: unknown }).price));
        }
      }
      if (ps.length) bestBid = Math.max(...ps);
    }
    if (Array.isArray(asks) && asks.length > 0) {
      const ps: number[] = [];
      for (const x of asks) {
        if (typeof x === "object" && x != null && "price" in x) {
          ps.push(parsePx((x as { price: unknown }).price));
        }
      }
      if (ps.length) bestAsk = Math.min(...ps);
    }
    return [bestBid, bestAsk];
  }

  private applyWsEvent(ev: Record<string, unknown>): boolean {
    let changed = false;
    const et = (ev.event_type ?? ev.type) as string | undefined;
    if (et === "book") {
      const aid = String(ev.asset_id ?? "");
      if (!aid) return false;
      const [bb, ba] = this.bestFromBook(ev.bids, ev.asks);
      const slot = this.quotes.get(aid) ?? {};
      if (bb != null && slot.bid !== bb) {
        slot.bid = bb;
        changed = true;
      }
      if (ba != null && slot.ask !== ba) {
        slot.ask = ba;
        changed = true;
      }
      this.quotes.set(aid, slot);
      return changed;
    }
    if (et === "best_bid_ask") {
      const aid = String(ev.asset_id ?? "");
      if (!aid) return false;
      const slot = this.quotes.get(aid) ?? {};
      const bb = ev.best_bid;
      const ba = ev.best_ask;
      if (bb != null) {
        const v = parsePx(bb);
        if (slot.bid !== v) {
          slot.bid = v;
          changed = true;
        }
      }
      if (ba != null) {
        const v = parsePx(ba);
        if (slot.ask !== v) {
          slot.ask = v;
          changed = true;
        }
      }
      this.quotes.set(aid, slot);
      return changed;
    }
    if (et === "price_change") {
      const pch = ev.price_changes as unknown[] | undefined;
      for (const ch of pch ?? []) {
        if (typeof ch !== "object" || ch == null) continue;
        const c = ch as Record<string, unknown>;
        const aid = String(c.asset_id ?? "");
        if (!aid) continue;
        const slot = this.quotes.get(aid) ?? {};
        const bb = c.best_bid;
        const ba = c.best_ask;
        if (bb != null) {
          const v = parsePx(bb);
          if (slot.bid !== v) {
            slot.bid = v;
            changed = true;
          }
        }
        if (ba != null) {
          const v = parsePx(ba);
          if (slot.ask !== v) {
            slot.ask = v;
            changed = true;
          }
        }
        this.quotes.set(aid, slot);
      }
      return changed;
    }
    return false;
  }

  private emitWsCallback(callback: (snap: MarketSnapshot) => void): void {
    const nowMs = Date.now();
    if (this.wsDebounceMs > 0 && nowMs - this.lastEmitMs < this.wsDebounceMs)
      return;
    this.lastEmitMs = nowMs;
    const snap = this.snapshotFromQuotesWs();
    if (snap == null) return;
    callback(snap);
  }

  private onWsMessage(
    callback: (snap: MarketSnapshot) => void,
    message: WebSocket.RawData,
  ): void {
    const raw = typeof message === "string" ? message : message.toString();
    if (raw === "PONG") return;
    try {
      const data = JSON.parse(raw) as unknown;
      if (Array.isArray(data)) {
        for (const item of data) {
          if (
            typeof item === "object" &&
            item != null &&
            this.applyWsEvent(item as Record<string, unknown>)
          ) {
            this.emitWsCallback(callback);
          }
        }
      } else if (typeof data === "object" && data != null) {
        if (this.applyWsEvent(data as Record<string, unknown>)) {
          this.emitWsCallback(callback);
        }
      }
    } catch (e) {
      process.stderr.write(`${this.marketName} WS message error: ${e}\n`);
    }
  }

  private runWebsocketSession(
    callback: (snap: MarketSnapshot) => void,
    up: string,
    down: string,
  ): Promise<void> {
    return new Promise((resolve) => {
      const ws = new WebSocket(this.clobWsUrl);
      this.wsActive = ws;
      const pingIv = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send("PING");
          } catch {
            /* ignore */
          }
        }
      }, 10_000);
      ws.on("open", () => {
        const sub = JSON.stringify({
          assets_ids: [up, down],
          type: "market",
          custom_feature_enabled: true,
        });
        ws.send(sub);
      });
      ws.on("message", (msg) => {
        try {
          this.onWsMessage(callback, msg);
        } catch (e) {
          process.stderr.write(`${this.marketName} WS message error: ${e}\n`);
        }
      });
      ws.on("error", (err) => {
        process.stderr.write(`${this.marketName} WebSocket error: ${err}\n`);
      });
      ws.on("close", () => {
        clearInterval(pingIv);
        if (this.wsActive === ws) this.wsActive = null;
        resolve();
      });
    });
  }

  async startMonitoringLoop(
    callback: (snap: MarketSnapshot) => void,
  ): Promise<void> {
    if (this.monitorUseHttp) {
      process.stderr.write(
        "Starting market monitoring via HTTP (MONITOR_USE_HTTP=true)...\n",
      );
      for (;;) {
        try {
          const snap = await this.snapshotFromQuotesHttp();
          callback(snap);
        } catch (e) {
          process.stderr.write(`Error fetching market data: ${e}\n`);
        }
        await new Promise((r) => setTimeout(r, this.checkIntervalMs));
      }
    }

    process.stderr.write(
      `Starting market monitoring via WebSocket (${this.clobWsUrl})...\n`,
    );
    for (;;) {
      await this.refreshMarketTokens();
      const up = this.upTokenId;
      const down = this.downTokenId;
      if (!up || !down) {
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      this.quotes.clear();
      this.lastEmitMs = 0;
      try {
        await this.runWebsocketSession(callback, up, down);
      } catch (e) {
        process.stderr.write(
          `${this.marketName} WebSocket session ended: ${e}\n`,
        );
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  async fetchMarketData(): Promise<MarketSnapshot> {
    return this.snapshotFromQuotesHttp();
  }
}
