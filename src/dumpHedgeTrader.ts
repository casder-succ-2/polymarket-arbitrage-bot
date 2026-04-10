/**
 * Dump-and-hedge trader (Python `dump_hedge_trader.py` parity).
 */

import { PolymarketApi } from "./api";
import type { AppConfig } from "./config";
import { timeframeDurationSeconds } from "./config";
import { logPrintln } from "./historyLog";
import type { CycleTrade, MarketData, MarketSnapshot } from "./models";
import { tokenPriceAsk, tokenPriceBid } from "./models";

const BALANCE_RE = /balance:\s*(\d+)/i;

interface BuyResult {
  done: boolean;
  success: boolean;
}

type Phase =
  | { kind: "WatchingForDump"; roundStartTime: number; windowEndTime: number }
  | {
      kind: "PendingLeg1Buy";
      leg1Side: string;
      leg1TokenId: string;
      leg1Price: number;
      leg1Shares: number;
      buyResult: BuyResult;
      roundStartTime: number;
      windowEndTime: number;
    }
  | {
      kind: "WaitingForHedge";
      leg1Side: string;
      leg1TokenId: string;
      leg1EntryPrice: number;
      leg1Shares: number;
    }
  | {
      kind: "CycleComplete";
      leg1Side: string;
      leg1EntryPrice: number;
      leg1Shares: number;
      leg2Side: string;
      leg2EntryPrice: number;
      leg2Shares: number;
      totalCost: number;
    }
  | {
      kind: "StopLadderInsuranceHeld";
      leg1Side: string;
      leg1EntryPrice: number;
      leg1Shares: number;
      insuranceSide: string;
      insuranceTokenId: string;
      insuranceBuyPrice: number;
      insuranceShares: number;
      hedgePrice: number;
      marketName: string;
      periodTimestamp: number;
      cycleCount: number;
      priceDipped: boolean;
      sellOrderId: string | null;
      lastPollTime: number;
      sellFailures: number;
    }
  | {
      kind: "StopLadderWaitingReentry";
      leg1Side: string;
      leg1EntryPrice: number;
      leg1Shares: number;
      insuranceSide: string;
      insuranceTokenId: string;
      insuranceBuyPrice: number;
      insuranceShares: number;
      hedgePrice: number;
      marketName: string;
      periodTimestamp: number;
      cycleCount: number;
      priceDipped: boolean;
    };

interface MarketState {
  conditionId: string;
  periodTimestamp: number;
  upTokenId: string | null;
  downTokenId: string | null;
  upPriceHistory: Array<[number, number]>;
  downPriceHistory: Array<[number, number]>;
  phase: Phase;
  closureChecked: boolean;
}

export class DumpHedgeTrader {
  private static readonly FEE_BUFFER = 0.965;
  private static readonly MAX_LADDER_CYCLES = 50;
  private static readonly MAX_SELL_RETRIES = 5;
  private static readonly ORDER_POLL_INTERVAL = 2.0;
  private static readonly DUMP_LOOKBACK_MIN = 1.0;
  private static readonly DUMP_LOOKBACK_MAX = 5.0;
  private static readonly HISTORY_WINDOW_SECS = 10.0;

  private readonly api: PolymarketApi;
  private readonly simulation: boolean;
  private readonly shares: number;
  private readonly sumTarget: number;
  private readonly moveThreshold: number;
  private readonly windowMinutes: number;
  private readonly stopLossMaxWait: number;
  private readonly periodSecs: number;
  private readonly useStopLimitLadder: boolean;

  private readonly marketStates = new Map<string, MarketState>();
  private readonly trades = new Map<string, CycleTrade>();
  private totalProfit = 0;
  private periodProfit = 0;
  private snapshotChain: Promise<void> = Promise.resolve();
  private closureChain: Promise<void> = Promise.resolve();

  constructor(
    api: PolymarketApi,
    simulationMode: boolean,
    cfg: AppConfig["trading"],
  ) {
    this.api = api;
    this.simulation = simulationMode;
    this.shares = cfg.dumpHedgeShares;
    this.sumTarget = cfg.dumpHedgeSumTarget;
    this.moveThreshold = cfg.dumpHedgeMoveThreshold;
    this.windowMinutes = cfg.dumpHedgeWindowMinutes;
    this.stopLossMaxWait = cfg.dumpHedgeStopLossMaxWaitMinutes;
    this.periodSecs = timeframeDurationSeconds(cfg.upDownTimeframe);
    this.useStopLimitLadder = cfg.dumpHedgeStopLossUseLimitLadder;
  }

  processSnapshot(snapshot: MarketSnapshot): void {
    this.snapshotChain = this.snapshotChain.then(() =>
      this.processSnapshotUnlocked(snapshot),
    );
  }

  private appendPrice(
    history: Array<[number, number]>,
    now: number,
    price: number,
  ): void {
    const last = history[history.length - 1];
    if (last && last[1] === price) return;
    history.push([now, price]);
  }

  private pruneHistory(
    history: Array<[number, number]>,
    now: number,
    window: number,
  ): void {
    const cutoff = now - window;
    while (history.length > 0 && history[0]![0] < cutoff) {
      history.shift();
    }
  }

  private async processSnapshotUnlocked(
    snapshot: MarketSnapshot,
  ): Promise<void> {
    const marketName = snapshot.marketName;
    const md = snapshot.btcMarket15m;
    const periodTimestamp = snapshot.btc15mPeriodTimestamp;
    const conditionId = md.conditionId;
    const nowF = Date.now() / 1000;
    const currentTime = Math.floor(nowF);

    let state = this.marketStates.get(conditionId);
    const shouldReset =
      state == null || state.periodTimestamp !== periodTimestamp;

    if (shouldReset) {
      const roundStart = periodTimestamp;
      const windowEnd = roundStart + this.windowMinutes * 60;
      let phase: Phase;
      if (currentTime <= windowEnd) {
        logPrintln(
          `${marketName}: New round started (period: ${periodTimestamp}) | Watch window: ${this.windowMinutes} minutes (active)`,
        );
        phase = {
          kind: "WatchingForDump",
          roundStartTime: roundStart,
          windowEndTime: windowEnd,
        };
      } else {
        logPrintln(
          `${marketName}: New round detected (period: ${periodTimestamp}) | Watch window already passed`,
        );
        phase = {
          kind: "CycleComplete",
          leg1Side: "",
          leg1EntryPrice: 0,
          leg1Shares: 0,
          leg2Side: "",
          leg2EntryPrice: 0,
          leg2Shares: 0,
          totalCost: 0,
        };
      }
      const upTok = md.upToken?.tokenId ?? null;
      const downTok = md.downToken?.tokenId ?? null;
      state = {
        conditionId: md.conditionId,
        periodTimestamp,
        upTokenId: upTok,
        downTokenId: downTok,
        upPriceHistory: [],
        downPriceHistory: [],
        phase,
        closureChecked: false,
      };
      this.marketStates.set(conditionId, state);
    }

    const s = this.marketStates.get(conditionId)!;
    if (md.upToken) s.upTokenId = md.upToken.tokenId;
    if (md.downToken) s.downTokenId = md.downToken.tokenId;

    const upAsk = md.upToken ? tokenPriceAsk(md.upToken) : 0;
    const downAsk = md.downToken ? tokenPriceAsk(md.downToken) : 0;

    if (upAsk <= 0 || downAsk <= 0) return;

    this.appendPrice(s.upPriceHistory, nowF, upAsk);
    this.appendPrice(s.downPriceHistory, nowF, downAsk);
    this.pruneHistory(
      s.upPriceHistory,
      nowF,
      DumpHedgeTrader.HISTORY_WINDOW_SECS,
    );
    this.pruneHistory(
      s.downPriceHistory,
      nowF,
      DumpHedgeTrader.HISTORY_WINDOW_SECS,
    );

    const ph = s.phase;

    if (ph.kind === "WatchingForDump") {
      if (currentTime > ph.windowEndTime) return;
      if (this.checkDump(s.upPriceHistory, nowF)) {
        logPrintln(
          `${marketName}: UP dump detected! Buying ${this.shares} shares @ $${upAsk.toFixed(4)}`,
        );
        if (s.upTokenId) {
          const result: BuyResult = { done: false, success: false };
          this.executeBuyAsync(
            marketName,
            "Up",
            s.upTokenId,
            this.shares,
            upAsk,
            s.conditionId,
            result,
          );
          s.phase = {
            kind: "PendingLeg1Buy",
            leg1Side: "Up",
            leg1TokenId: s.upTokenId,
            leg1Price: upAsk,
            leg1Shares: this.shares,
            buyResult: result,
            roundStartTime: ph.roundStartTime,
            windowEndTime: ph.windowEndTime,
          };
        }
        return;
      }
      if (this.checkDump(s.downPriceHistory, nowF)) {
        logPrintln(
          `${marketName}: DOWN dump detected! Buying ${this.shares} shares @ $${downAsk.toFixed(4)}`,
        );
        if (s.downTokenId) {
          const result: BuyResult = { done: false, success: false };
          this.executeBuyAsync(
            marketName,
            "Down",
            s.downTokenId,
            this.shares,
            downAsk,
            s.conditionId,
            result,
          );
          s.phase = {
            kind: "PendingLeg1Buy",
            leg1Side: "Down",
            leg1TokenId: s.downTokenId,
            leg1Price: downAsk,
            leg1Shares: this.shares,
            buyResult: result,
            roundStartTime: ph.roundStartTime,
            windowEndTime: ph.windowEndTime,
          };
        }
        return;
      }
    }

    if (ph.kind === "PendingLeg1Buy") {
      if (!ph.buyResult.done) return;
      if (ph.buyResult.success) {
        logPrintln(
          `${marketName}: Leg1 BUY ${ph.leg1Side} подтверждён @ $${ph.leg1Price.toFixed(4)}`,
        );
        this.recordTrade(
          s.conditionId,
          periodTimestamp,
          ph.leg1Side,
          ph.leg1TokenId,
          ph.leg1Shares,
          ph.leg1Price,
        );
        s.phase = {
          kind: "WaitingForHedge",
          leg1Side: ph.leg1Side,
          leg1TokenId: ph.leg1TokenId,
          leg1EntryPrice: ph.leg1Price,
          leg1Shares: ph.leg1Shares,
        };
      } else {
        logPrintln(
          `${marketName}: Leg1 BUY ${ph.leg1Side} FAILED — возврат к мониторингу`,
        );
        s.phase = {
          kind: "WatchingForDump",
          roundStartTime: ph.roundStartTime,
          windowEndTime: ph.windowEndTime,
        };
      }
      return;
    }

    if (ph.kind === "WaitingForHedge") {
      const minutesSinceMarketOpen = Math.floor(
        (currentTime - periodTimestamp) / 60,
      );
      const oppositeAsk = ph.leg1Side === "Up" ? downAsk : upAsk;
      const oppositeSide = ph.leg1Side === "Up" ? "Down" : "Up";
      const oppositeToken = ph.leg1Side === "Up" ? s.downTokenId : s.upTokenId;
      const totalPrice = ph.leg1EntryPrice + oppositeAsk;

      if (minutesSinceMarketOpen >= this.stopLossMaxWait) {
        if (oppositeToken) {
          if (this.useStopLimitLadder) {
            await this.beginStopLadder(
              marketName,
              s,
              ph,
              oppositeSide,
              oppositeToken,
              oppositeAsk,
              periodTimestamp,
            );
          } else {
            logPrintln(
              `${marketName}: STOP LOSS TRIGGERED (Hedge not met after ${this.stopLossMaxWait} min from market open) | Buying opposite to hedge`,
            );
            await this.executeStopLossHedge(
              marketName,
              s,
              ph.leg1Side,
              ph.leg1EntryPrice,
              ph.leg1Shares,
              oppositeSide,
              oppositeToken,
              oppositeAsk,
              periodTimestamp,
            );
          }
        }
        return;
      }

      if (totalPrice <= this.sumTarget && oppositeToken) {
        logPrintln(
          `${marketName}: Hedge condition met! Leg1: $${ph.leg1EntryPrice.toFixed(4)} + Opposite: $${oppositeAsk.toFixed(4)} = $${totalPrice.toFixed(4)} <= ${this.sumTarget}`,
        );
        logPrintln(
          `${marketName}: Buying ${this.shares} ${oppositeSide} shares @ $${oppositeAsk.toFixed(4)} (Leg 2)`,
        );
        await this.executeBuy(
          marketName,
          oppositeSide,
          oppositeToken,
          this.shares,
          oppositeAsk,
          s.conditionId,
        );
        this.recordTrade(
          s.conditionId,
          periodTimestamp,
          oppositeSide,
          oppositeToken,
          this.shares,
          oppositeAsk,
        );
        const totalCost =
          ph.leg1EntryPrice * ph.leg1Shares + oppositeAsk * this.shares;
        const expectedProfit = this.shares * 1 - totalCost;
        const profitPercent =
          totalPrice > 0 ? ((1 - totalPrice) / totalPrice) * 100 : 0;
        logPrintln(
          `${marketName}: Cycle complete! Locked in ~${profitPercent.toFixed(2)}% profit | Expected profit: $${expectedProfit.toFixed(2)}`,
        );
        this.periodProfit += expectedProfit;
        this.totalProfit += expectedProfit;
        const key = `${s.conditionId}:${periodTimestamp}`;
        const tr = this.trades.get(key);
        if (tr) tr.expectedProfit = expectedProfit;
        s.phase = {
          kind: "CycleComplete",
          leg1Side: ph.leg1Side,
          leg1EntryPrice: ph.leg1EntryPrice,
          leg1Shares: ph.leg1Shares,
          leg2Side: oppositeSide,
          leg2EntryPrice: oppositeAsk,
          leg2Shares: this.shares,
          totalCost,
        };
        return;
      }
      if (currentTime % 10 === 0) {
        logPrintln(
          `${marketName}: Waiting for hedge... Leg1: $${ph.leg1EntryPrice.toFixed(4)} + ${oppositeSide}: $${oppositeAsk.toFixed(4)} = $${totalPrice.toFixed(4)} (need <= ${this.sumTarget}) | min since market open: ${minutesSinceMarketOpen}m`,
        );
      }
    }

    const ph2 = s.phase;
    if (ph2.kind === "StopLadderInsuranceHeld") {
      await this.tickStopLadderInsurance(s, ph2, md, upAsk, downAsk);
      return;
    }
    if (ph2.kind === "StopLadderWaitingReentry") {
      await this.tickStopLadderReentry(s, ph2, md, upAsk, downAsk);
    }
  }

  private static extractOrderId(resp: unknown): string | null {
    if (typeof resp !== "object" || resp == null) return null;
    const o = resp as Record<string, unknown>;
    const v = o.orderID ?? o.orderId ?? o.id;
    return v != null ? String(v) : null;
  }

  private async beginStopLadder(
    marketName: string,
    state: MarketState,
    ph: Extract<Phase, { kind: "WaitingForHedge" }>,
    oppositeSide: string,
    oppositeTokenId: string,
    oppositeAsk: number,
    periodTimestamp: number,
  ): Promise<void> {
    const hedgePrice = this.sumTarget - ph.leg1EntryPrice;
    logPrintln(
      `${marketName}: STOP LOSS (time) — лимитная лестница | BUY ${oppositeSide} @ $${oppositeAsk.toFixed(4)} (страховка), цель хеджа: $${hedgePrice.toFixed(4)}`,
    );
    const sz = Math.round(ph.leg1Shares * 10000) / 10000;
    if (!this.simulation) {
      try {
        await this.executeBuy(
          marketName,
          oppositeSide,
          oppositeTokenId,
          sz,
          oppositeAsk,
          state.conditionId,
        );
      } catch (e) {
        logPrintln(
          `${marketName}: Не удалось купить страховку (${e}), fallback — рыночный хедж`,
        );
        await this.executeStopLossHedge(
          marketName,
          state,
          ph.leg1Side,
          ph.leg1EntryPrice,
          ph.leg1Shares,
          oppositeSide,
          oppositeTokenId,
          oppositeAsk,
          periodTimestamp,
        );
        return;
      }
    }
    const sellSz = Math.round(sz * DumpHedgeTrader.FEE_BUFFER * 10000) / 10000;
    this.recordTrade(
      state.conditionId,
      periodTimestamp,
      oppositeSide,
      oppositeTokenId,
      sellSz,
      oppositeAsk,
    );
    state.phase = {
      kind: "StopLadderInsuranceHeld",
      leg1Side: ph.leg1Side,
      leg1EntryPrice: ph.leg1EntryPrice,
      leg1Shares: ph.leg1Shares,
      insuranceSide: oppositeSide,
      insuranceTokenId: oppositeTokenId,
      insuranceBuyPrice: oppositeAsk,
      insuranceShares: sellSz,
      hedgePrice,
      marketName,
      periodTimestamp,
      cycleCount: 0,
      priceDipped: false,
      sellOrderId: null,
      lastPollTime: 0,
      sellFailures: 0,
    };
  }

  private async tickStopLadderInsurance(
    state: MarketState,
    ph: Extract<Phase, { kind: "StopLadderInsuranceHeld" }>,
    md: MarketData,
    upAsk: number,
    downAsk: number,
  ): Promise<void> {
    const insTp = ph.insuranceSide === "Down" ? md.downToken : md.upToken;
    if (!insTp) return;
    const insAsk = ph.insuranceSide === "Down" ? downAsk : upAsk;
    const insBid = tokenPriceBid(insTp);

    const dipThreshold = ph.insuranceBuyPrice * 0.97;
    if (!ph.priceDipped && insAsk < dipThreshold - 1e-9) {
      ph.priceDipped = true;
      logPrintln(
        `${ph.marketName}: Ladder: ${ph.insuranceSide} дипнул (ask=$${insAsk.toFixed(4)} < порог $${dipThreshold.toFixed(4)})`,
      );
    }

    if (ph.sellOrderId != null) {
      const now = Date.now() / 1000;
      if (now - ph.lastPollTime < DumpHedgeTrader.ORDER_POLL_INTERVAL) return;
      ph.lastPollTime = now;
      const o = await this.api.getClobOrder(ph.sellOrderId);
      if (o == null) return;
      if (PolymarketApi.orderFullyFilled(o)) {
        logPrintln(
          `${ph.marketName}: Ladder SELL ${ph.insuranceSide} исполнен @ $${ph.insuranceBuyPrice.toFixed(4)} — мониторим реентри`,
        );
        this.recordSell(
          state.conditionId,
          ph.periodTimestamp,
          ph.insuranceSide,
          ph.insuranceTokenId,
          ph.insuranceShares,
          ph.insuranceBuyPrice,
        );
        state.phase = {
          kind: "StopLadderWaitingReentry",
          leg1Side: ph.leg1Side,
          leg1EntryPrice: ph.leg1EntryPrice,
          leg1Shares: ph.leg1Shares,
          insuranceSide: ph.insuranceSide,
          insuranceTokenId: ph.insuranceTokenId,
          insuranceBuyPrice: ph.insuranceBuyPrice,
          insuranceShares: ph.insuranceShares,
          hedgePrice: ph.hedgePrice,
          marketName: ph.marketName,
          periodTimestamp: ph.periodTimestamp,
          cycleCount: ph.cycleCount + 1,
          priceDipped: false,
        };
        return;
      }
      const st = String(o.status ?? "").toUpperCase();
      if (st.includes("CANCEL")) {
        logPrintln(
          `${ph.marketName}: Ladder SELL отменён биржей — пересоздаём`,
        );
        ph.sellOrderId = null;
      }
      return;
    }

    if (ph.priceDipped && insBid >= ph.insuranceBuyPrice - 1e-9) {
      if (ph.sellFailures >= DumpHedgeTrader.MAX_SELL_RETRIES) {
        logPrintln(
          `${ph.marketName}: Ladder SELL: ${ph.sellFailures} неудач подряд — пропускаем SELL, ждём резолва`,
        );
        return;
      }
      logPrintln(
        `${ph.marketName}: Ladder: ${ph.insuranceSide} вернулся к $${ph.insuranceBuyPrice.toFixed(4)} (bid=$${insBid.toFixed(4)}) — ставим SELL`,
      );
      if (!this.simulation) {
        try {
          const r = await this.api.placeLimitOrder(
            ph.insuranceTokenId,
            "SELL",
            ph.insuranceBuyPrice,
            ph.insuranceShares,
            state.conditionId,
          );
          ph.sellOrderId = DumpHedgeTrader.extractOrderId(r);
          ph.sellFailures = 0;
        } catch (e) {
          const errStr = String(e);
          logPrintln(`${ph.marketName}: Ladder SELL ошибка: ${e}`);
          ph.sellFailures += 1;
          if (errStr.toLowerCase().includes("not enough balance")) {
            const m = BALANCE_RE.exec(errStr);
            if (m) {
              const actual = Number.parseInt(m[1]!, 10) / 1_000_000;
              const newSz = Math.round(actual * 0.99 * 10000) / 10000;
              if (newSz > 0) {
                logPrintln(
                  `${ph.marketName}: Ladder SELL: баланс ${actual.toFixed(4)}, уменьшаем размер до ${newSz.toFixed(4)}`,
                );
                ph.insuranceShares = newSz;
              }
            } else {
              ph.insuranceShares =
                Math.round(ph.insuranceShares * 0.96 * 10000) / 10000;
              logPrintln(
                `${ph.marketName}: Ladder SELL: уменьшаем размер до ${ph.insuranceShares.toFixed(4)}`,
              );
            }
          }
        }
      } else {
        logPrintln(
          `${ph.marketName}: SIM SELL ${ph.insuranceSide} ${ph.insuranceShares} @ $${ph.insuranceBuyPrice.toFixed(4)}`,
        );
        this.recordSell(
          state.conditionId,
          ph.periodTimestamp,
          ph.insuranceSide,
          ph.insuranceTokenId,
          ph.insuranceShares,
          ph.insuranceBuyPrice,
        );
        state.phase = {
          kind: "StopLadderWaitingReentry",
          leg1Side: ph.leg1Side,
          leg1EntryPrice: ph.leg1EntryPrice,
          leg1Shares: ph.leg1Shares,
          insuranceSide: ph.insuranceSide,
          insuranceTokenId: ph.insuranceTokenId,
          insuranceBuyPrice: ph.insuranceBuyPrice,
          insuranceShares: ph.insuranceShares,
          hedgePrice: ph.hedgePrice,
          marketName: ph.marketName,
          periodTimestamp: ph.periodTimestamp,
          cycleCount: ph.cycleCount + 1,
          priceDipped: false,
        };
      }
    }
  }

  private async tickStopLadderReentry(
    state: MarketState,
    ph: Extract<Phase, { kind: "StopLadderWaitingReentry" }>,
    md: MarketData,
    upAsk: number,
    downAsk: number,
  ): Promise<void> {
    void md;
    if (ph.cycleCount >= DumpHedgeTrader.MAX_LADDER_CYCLES) {
      logPrintln(
        `${ph.marketName}: Ladder: достигнут лимит циклов (${ph.cycleCount}) — стоп`,
      );
      state.phase = {
        kind: "WatchingForDump",
        roundStartTime: 0,
        windowEndTime: 0,
      };
      return;
    }

    const insAsk = ph.insuranceSide === "Down" ? downAsk : upAsk;

    if (insAsk <= ph.hedgePrice + 1e-9) {
      logPrintln(
        `${ph.marketName}: Ladder: хедж достигнут! ${ph.insuranceSide} ASK=$${insAsk.toFixed(4)} <= $${ph.hedgePrice.toFixed(4)} — BUY`,
      );
      const sz = Math.round(ph.insuranceShares * 10000) / 10000;
      if (!this.simulation) {
        try {
          await this.executeBuy(
            ph.marketName,
            ph.insuranceSide,
            ph.insuranceTokenId,
            sz,
            insAsk,
            state.conditionId,
          );
        } catch (e) {
          logPrintln(`${ph.marketName}: Ladder hedge BUY ошибка: ${e}`);
          return;
        }
      }
      this.recordTrade(
        state.conditionId,
        ph.periodTimestamp,
        ph.insuranceSide,
        ph.insuranceTokenId,
        sz,
        insAsk,
      );
      const totalCost = ph.leg1EntryPrice * ph.leg1Shares + insAsk * sz;
      const expectedProfit = sz * 1 - totalCost;
      this.periodProfit += expectedProfit;
      this.totalProfit += expectedProfit;
      const key = `${state.conditionId}:${ph.periodTimestamp}`;
      const tr = this.trades.get(key);
      if (tr) tr.expectedProfit = expectedProfit;
      state.phase = {
        kind: "CycleComplete",
        leg1Side: ph.leg1Side,
        leg1EntryPrice: ph.leg1EntryPrice,
        leg1Shares: ph.leg1Shares,
        leg2Side: ph.insuranceSide,
        leg2EntryPrice: insAsk,
        leg2Shares: sz,
        totalCost,
      };
      logPrintln(
        `${ph.marketName}: Ladder завершён (хедж @ $${insAsk.toFixed(4)}). Ожидаемый профит: $${expectedProfit.toFixed(2)}`,
      );
      return;
    }

    const dipThreshold = ph.insuranceBuyPrice * 0.97;
    if (!ph.priceDipped && insAsk < dipThreshold - 1e-9) {
      ph.priceDipped = true;
    }

    if (ph.priceDipped && insAsk >= ph.insuranceBuyPrice - 1e-9) {
      logPrintln(
        `${ph.marketName}: Ladder: повторная страховка — BUY ${ph.insuranceSide} @ $${insAsk.toFixed(4)} (цикл ${ph.cycleCount + 1})`,
      );
      const buySz = Math.round(ph.insuranceShares * 10000) / 10000;
      if (!this.simulation) {
        try {
          await this.executeBuy(
            ph.marketName,
            ph.insuranceSide,
            ph.insuranceTokenId,
            buySz,
            insAsk,
            state.conditionId,
          );
        } catch (e) {
          logPrintln(`${ph.marketName}: Ladder re-insurance BUY ошибка: ${e}`);
          return;
        }
      }
      const sellSz =
        Math.round(buySz * DumpHedgeTrader.FEE_BUFFER * 10000) / 10000;
      this.recordTrade(
        state.conditionId,
        ph.periodTimestamp,
        ph.insuranceSide,
        ph.insuranceTokenId,
        sellSz,
        insAsk,
      );
      state.phase = {
        kind: "StopLadderInsuranceHeld",
        leg1Side: ph.leg1Side,
        leg1EntryPrice: ph.leg1EntryPrice,
        leg1Shares: ph.leg1Shares,
        insuranceSide: ph.insuranceSide,
        insuranceTokenId: ph.insuranceTokenId,
        insuranceBuyPrice: insAsk,
        insuranceShares: sellSz,
        hedgePrice: ph.hedgePrice,
        marketName: ph.marketName,
        periodTimestamp: ph.periodTimestamp,
        cycleCount: ph.cycleCount,
        priceDipped: false,
        sellOrderId: null,
        lastPollTime: 0,
        sellFailures: 0,
      };
    }
  }

  private recordSell(
    conditionId: string,
    periodTimestamp: number,
    side: string,
    tokenId: string,
    shares: number,
    price: number,
  ): void {
    void tokenId;
    void price;
    const key = `${conditionId}:${periodTimestamp}`;
    const tr = this.trades.get(key);
    if (tr == null) return;
    if (side === "Up") {
      tr.upShares -= shares;
      if (tr.upShares < 1e-9) {
        tr.upShares = 0;
        tr.upAvgPrice = 0;
      }
    } else if (side === "Down") {
      tr.downShares -= shares;
      if (tr.downShares < 1e-9) {
        tr.downShares = 0;
        tr.downAvgPrice = 0;
      }
    }
  }

  private checkDump(
    priceHistory: Array<[number, number]>,
    currentTimeF: number,
  ): boolean {
    if (priceHistory.length < 2) return false;
    const last = priceHistory[priceHistory.length - 1]!;
    const newTs = last[0];
    void newTs;
    const newPrice = last[1];
    if (newPrice <= 0) return false;

    const windowStart = currentTimeF - DumpHedgeTrader.DUMP_LOOKBACK_MAX;
    const windowEnd = currentTimeF - DumpHedgeTrader.DUMP_LOOKBACK_MIN;

    let bestOldPrice = 0;
    for (const [ts, price] of priceHistory) {
      if (windowStart <= ts && ts <= windowEnd && price > bestOldPrice) {
        bestOldPrice = price;
      }
    }

    if (bestOldPrice <= 0) return false;

    const drop = bestOldPrice - newPrice;
    if (drop <= 0) return false;
    return drop / bestOldPrice >= this.moveThreshold;
  }

  private executeBuyAsync(
    marketName: string,
    side: string,
    tokenId: string,
    shares: number,
    price: number,
    conditionId: string,
    buyResult: BuyResult,
  ): void {
    logPrintln(
      `${marketName} BUY ${side} ${shares} shares @ $${price.toFixed(4)}`,
    );
    if (this.simulation) {
      logPrintln("SIMULATION: Order executed");
      buyResult.success = true;
      buyResult.done = true;
      return;
    }
    void this.executeBuyWorker(
      marketName,
      tokenId,
      shares,
      price,
      conditionId,
      buyResult,
    );
  }

  private async executeBuyWorker(
    marketName: string,
    tokenId: string,
    shares: number,
    price: number,
    conditionId: string,
    buyResult: BuyResult,
  ): Promise<void> {
    const size = Math.round(shares * 10000) / 10000;
    try {
      await this.api.placeMarketOrder(
        tokenId,
        size,
        "BUY",
        conditionId,
        "0.01",
        {
          referencePrice: price,
        },
      );
      logPrintln(`${marketName}: REAL: Order placed (async)`);
      buyResult.success = true;
      buyResult.done = true;
    } catch (e) {
      logPrintln(`${marketName}: Order FAILED: ${e}`);
      buyResult.success = false;
      buyResult.done = true;
    }
  }

  private async executeBuy(
    marketName: string,
    side: string,
    tokenId: string,
    shares: number,
    price: number,
    conditionId: string,
  ): Promise<void> {
    logPrintln(
      `${marketName} BUY ${side} ${shares} shares @ $${price.toFixed(4)}`,
    );
    if (this.simulation) {
      logPrintln("SIMULATION: Order executed");
      return;
    }
    const size = Math.round(shares * 10000) / 10000;
    try {
      await this.api.placeMarketOrder(
        tokenId,
        size,
        "BUY",
        conditionId,
        "0.01",
        {
          referencePrice: price,
        },
      );
      logPrintln("REAL: Order placed");
    } catch (e) {
      process.stderr.write(`Failed to place order: ${e}\n`);
      throw e;
    }
  }

  private async executeStopLossHedge(
    marketName: string,
    state: MarketState,
    leg1Side: string,
    leg1EntryPrice: number,
    leg1Shares: number,
    oppositeSide: string,
    oppositeTokenId: string,
    oppositeAsk: number,
    periodTimestamp: number,
  ): Promise<void> {
    logPrintln(
      `${marketName}: STOP LOSS HEDGE - Buying ${leg1Shares} ${oppositeSide} shares @ $${oppositeAsk.toFixed(4)}`,
    );
    await this.executeBuy(
      marketName,
      oppositeSide,
      oppositeTokenId,
      leg1Shares,
      oppositeAsk,
      state.conditionId,
    );
    this.recordTrade(
      state.conditionId,
      periodTimestamp,
      oppositeSide,
      oppositeTokenId,
      leg1Shares,
      oppositeAsk,
    );
    const totalCost = leg1EntryPrice * leg1Shares + oppositeAsk * leg1Shares;
    const totalPerShare = leg1EntryPrice + oppositeAsk;
    const expectedProfit = leg1Shares * 1 - totalCost;
    const profitPct =
      totalPerShare > 0 ? ((1 - totalPerShare) / totalPerShare) * 100 : 0;
    logPrintln(
      `${marketName}: Stop loss hedge complete! Expected profit: $${expectedProfit.toFixed(2)} (${profitPct.toFixed(2)}%)`,
    );
    this.periodProfit += expectedProfit;
    this.totalProfit += expectedProfit;
    const key = `${state.conditionId}:${periodTimestamp}`;
    const tr = this.trades.get(key);
    if (tr) tr.expectedProfit = expectedProfit;
    state.phase = {
      kind: "CycleComplete",
      leg1Side,
      leg1EntryPrice,
      leg1Shares,
      leg2Side: oppositeSide,
      leg2EntryPrice: oppositeAsk,
      leg2Shares: leg1Shares,
      totalCost,
    };
  }

  private recordTrade(
    conditionId: string,
    periodTimestamp: number,
    side: string,
    tokenId: string,
    shares: number,
    price: number,
  ): void {
    const key = `${conditionId}:${periodTimestamp}`;
    let tr = this.trades.get(key);
    if (tr == null) {
      tr = {
        conditionId,
        periodTimestamp,
        upTokenId: null,
        downTokenId: null,
        upShares: 0,
        downShares: 0,
        upAvgPrice: 0,
        downAvgPrice: 0,
        expectedProfit: 0,
      };
      this.trades.set(key, tr);
    }
    if (side === "Up") {
      const oldTotal = tr.upShares * tr.upAvgPrice;
      tr.upShares += shares;
      tr.upAvgPrice =
        tr.upShares > 0 ? (oldTotal + shares * price) / tr.upShares : price;
      tr.upTokenId = tokenId;
    } else if (side === "Down") {
      const oldTotal = tr.downShares * tr.downAvgPrice;
      tr.downShares += shares;
      tr.downAvgPrice =
        tr.downShares > 0 ? (oldTotal + shares * price) / tr.downShares : price;
      tr.downTokenId = tokenId;
    }
  }

  checkMarketClosure(): void {
    this.closureChain = this.closureChain.then(() =>
      this.checkMarketClosureUnlocked(),
    );
  }

  private async checkMarketClosureUnlocked(): Promise<void> {
    if (this.trades.size === 0) return;
    const currentTs = Math.floor(Date.now() / 1000);
    const items = [...this.trades.entries()];
    for (const [marketKey, trade] of items) {
      const marketEnd = trade.periodTimestamp + this.periodSecs;
      if (currentTs < marketEnd) continue;
      const state = this.marketStates.get(trade.conditionId);
      if (state?.closureChecked) continue;
      const since = currentTs - marketEnd;
      logPrintln(
        `Market ${trade.conditionId.slice(0, 8)} closed ${Math.floor(since / 60)}m ${since % 60}s ago | Checking resolution...`,
      );
      if (!this.simulation) {
        await this.api.cancelClobOrdersForMarket(trade.conditionId);
        logPrintln(
          `Market ${trade.conditionId.slice(0, 8)}: запрошена отмена открытых CLOB-ордеров по рынку`,
        );
      }
      let market;
      try {
        market = await this.api.getMarket(trade.conditionId);
      } catch (e) {
        process.stderr.write(`Failed to fetch market: ${e}\n`);
        continue;
      }
      const hasWinnerFlag = market.tokens.some((t) => t.winner);
      let resolved = market.closed || hasWinnerFlag;
      if (!resolved) {
        if (since >= 30 && !this.simulation) {
          try {
            const onchainOk = await this.api.isResolvedOnchain(
              trade.conditionId,
            );
            if (onchainOk) {
              logPrintln(
                `Market ${trade.conditionId.slice(0, 8)}: CLOB не обновился, но on-chain condition уже resolved — proceeding`,
              );
              resolved = true;
            }
          } catch {
            /* ignore */
          }
        }
        if (!resolved) {
          logPrintln(
            `Market ${trade.conditionId.slice(0, 8)} not yet resolved (CLOB closed=${market.closed}, winner_set=${hasWinnerFlag}), will retry`,
          );
          continue;
        }
      }
      if (hasWinnerFlag && !market.closed && !resolved) {
        logPrintln(
          `Market ${trade.conditionId.slice(0, 8)}: outcome resolved (winner) while CLOB closed=false — proceeding`,
        );
      }
      logPrintln(
        `Market ${trade.conditionId.slice(0, 8)} is closed and resolved`,
      );

      const hasPosition = trade.upShares > 0.001 || trade.downShares > 0.001;
      if (!this.simulation && hasPosition) {
        let redeemed = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const r = await this.api.redeemPositionsForCondition(
              trade.conditionId,
            );
            if (r.status === "ok") {
              logPrintln(
                `Redeem USDC (CTF): tx=${r.tx_hash} mode=${r.mode ?? "?"}`,
              );
              redeemed = true;
              break;
            }
            if (r.status === "skipped") {
              logPrintln(`Redeem пропущен: ${r.reason ?? r}`);
              break;
            }
            if (r.status === "submitted") {
              logPrintln(`Redeem отправлен: tx=${r.tx_hash}`);
              redeemed = true;
              break;
            }
          } catch (e) {
            logPrintln(`Redeem ошибка (попытка ${attempt}/3): ${e}`);
            if (attempt < 3) await new Promise((r) => setTimeout(r, 15_000));
          }
        }
        if (!redeemed) {
          logPrintln(
            `Market ${trade.conditionId.slice(0, 8)}: redeem не удался после 3 попыток — будет повторён при следующей проверке`,
          );
          continue;
        }
      }

      let upWinner = false;
      if (trade.upTokenId) {
        upWinner = market.tokens.some(
          (t) => t.tokenId === trade.upTokenId && t.winner,
        );
      }
      let downWinner = false;
      if (trade.downTokenId) {
        downWinner = market.tokens.some(
          (t) => t.tokenId === trade.downTokenId && t.winner,
        );
      }

      let actualProfit = 0;
      if (trade.upShares > 0.001) {
        if (upWinner) {
          const value = trade.upShares * 1;
          const cost = trade.upAvgPrice * trade.upShares;
          actualProfit += value - cost;
          logPrintln(
            `Market Closed - Up Winner: ${trade.upShares.toFixed(2)} @ $${trade.upAvgPrice.toFixed(4)} | Profit: $${(value - cost).toFixed(2)}`,
          );
        } else {
          actualProfit -= trade.upAvgPrice * trade.upShares;
          logPrintln(
            `Market Closed - Up Lost: ${trade.upShares.toFixed(2)} @ $${trade.upAvgPrice.toFixed(4)}`,
          );
        }
      }
      if (trade.downShares > 0.001) {
        if (downWinner) {
          const value = trade.downShares * 1;
          const cost = trade.downAvgPrice * trade.downShares;
          actualProfit += value - cost;
          logPrintln(
            `Market Closed - Down Winner: ${trade.downShares.toFixed(2)} @ $${trade.downAvgPrice.toFixed(4)} | Profit: $${(value - cost).toFixed(2)}`,
          );
        } else {
          actualProfit -= trade.downAvgPrice * trade.downShares;
          logPrintln(
            `Market Closed - Down Lost: ${trade.downShares.toFixed(2)} @ $${trade.downAvgPrice.toFixed(4)}`,
          );
        }
      }

      if (trade.expectedProfit !== 0) {
        this.totalProfit =
          this.totalProfit - trade.expectedProfit + actualProfit;
        this.periodProfit =
          this.periodProfit - trade.expectedProfit + actualProfit;
      } else {
        this.totalProfit += actualProfit;
        this.periodProfit += actualProfit;
      }

      logPrintln(
        `Period Profit: $${this.periodProfit.toFixed(2)} | Total Profit: $${this.totalProfit.toFixed(2)}`,
      );
      if (state) state.closureChecked = true;
      this.trades.delete(marketKey);
      logPrintln("Trade removed from tracking");
    }
  }

  resetPeriod(): void {
    this.marketStates.clear();
    logPrintln("Dump-Hedge Trader: Period reset");
  }

  getTotalProfit(): number {
    return this.totalProfit;
  }

  getPeriodProfit(): number {
    return this.periodProfit;
  }
}
