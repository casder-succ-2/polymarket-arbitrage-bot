export interface Market {
  conditionId: string;
  id?: string;
  question: string;
  slug: string;
  active: boolean;
  closed: boolean;
  tokens?: Array<Record<string, unknown>>;
  clobTokenIds?: string;
  outcomes?: string;
}

export interface MarketToken {
  tokenId: string;
  outcome: string;
  winner: boolean;
}

export interface MarketDetails {
  conditionId: string;
  acceptingOrders: boolean;
  active: boolean;
  closed: boolean;
  makerBaseFee: string;
  tokens: MarketToken[];
  negRisk: boolean;
  minimumTickSize: string;
}

export interface TokenPrice {
  tokenId: string;
  bid: number | null;
  ask: number | null;
}

export function tokenPriceAsk(p: TokenPrice): number {
  return p.ask ?? 0;
}

export function tokenPriceBid(p: TokenPrice): number {
  return p.bid ?? 0;
}

export interface MarketData {
  conditionId: string;
  marketName: string;
  upToken: TokenPrice | null;
  downToken: TokenPrice | null;
}

export interface MarketSnapshot {
  marketName: string;
  btcMarket15m: MarketData;
  timestampMs: number;
  btc15mTimeRemaining: number;
  btc15mPeriodTimestamp: number;
}

export interface CycleTrade {
  conditionId: string;
  periodTimestamp: number;
  upTokenId: string | null;
  downTokenId: string | null;
  upShares: number;
  downShares: number;
  upAvgPrice: number;
  downAvgPrice: number;
  expectedProfit: number;
}
