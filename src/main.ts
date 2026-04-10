/**
 * Polymarket dump-and-hedge bot (Python `main.py` parity).
 *
 *   npm run sim   — без ордеров
 *   npm run prod  — реальные ордера (@polymarket/clob-client)
 */

import type { ClobClient } from "@polymarket/clob-client";
import { PolymarketApi } from "./api";
import { buildClobClient, warnProductionWalletSettings } from "./clobTrading";
import {
  DEFAULT_POLYGON_RPC_URL,
  loadConfig,
  timeframeDurationSeconds,
} from "./config";
import { DumpHedgeTrader } from "./dumpHedgeTrader";
import {
  configureHistoryDir,
  configureHistoryFilesEnabled,
  configureTradeOpenLogsOnly,
  logPrintln,
  setHistoryLogPeriod,
} from "./historyLog";
import type { Market } from "./models";
import { MarketMonitor } from "./monitor";

function parseArgs(): { production: boolean; simulation: boolean } {
  const argv = process.argv.slice(2);
  return {
    production: argv.includes("--production"),
    simulation: argv.includes("--simulation"),
  };
}

async function discoverMarketForAsset(
  api: PolymarketApi,
  asset: string,
  timeframe: string,
  periodSecs: number,
): Promise<Market> {
  const al = asset.toLowerCase();
  const slugPrefix =
    al === "btc"
      ? "btc"
      : al === "eth"
        ? "eth"
        : al === "sol"
          ? "sol"
          : al === "xrp"
            ? "xrp"
            : (() => {
                throw new Error(
                  `Unsupported asset: ${asset}. Supported: BTC, ETH, SOL, XRP`,
                );
              })();

  const now = Math.floor(Date.now() / 1000);
  const rounded = Math.floor(now / periodSecs) * periodSecs;
  const slug = `${slugPrefix}-updown-${timeframe}-${rounded}`;

  const trySlug = async (s: string): Promise<Market | null> => {
    try {
      const m = await api.getMarketBySlug(s);
      if (m.active && !m.closed) return m;
    } catch {
      /* ignore */
    }
    return null;
  };

  let market = await trySlug(slug);
  if (market) {
    process.stderr.write(
      `Found ${asset} ${timeframe} market by slug: ${market.slug} | Condition ID: ${market.conditionId}\n`,
    );
    return market;
  }

  for (let offset = 1; offset < 4; offset++) {
    const tryTime = rounded - offset * periodSecs;
    const trySlugStr = `${slugPrefix}-updown-${timeframe}-${tryTime}`;
    process.stderr.write(`Trying previous market by slug: ${trySlugStr}\n`);
    market = await trySlug(trySlugStr);
    if (market) {
      process.stderr.write(
        `Found ${asset} ${timeframe} market by slug: ${market.slug} | Condition ID: ${market.conditionId}\n`,
      );
      return market;
    }
  }

  throw new Error(
    `Could not find active ${asset} ${timeframe} up/down market. Check .env MARKETS.`,
  );
}

async function periodRotationLoop(
  api: PolymarketApi,
  trader: DumpHedgeTrader,
  asset: string,
  marketName: string,
  tf: string,
  periodSecs: number,
  box: { monitor: MarketMonitor },
): Promise<void> {
  let lastProcessed: number | null = null;
  for (;;) {
    const m = box.monitor;
    const currentTsSlug = m.getCurrentMarketTimestamp();
    const nextPeriod = currentTsSlug + periodSecs;
    const now = Math.floor(Date.now() / 1000);
    const sleepS = Math.max(0, nextPeriod - now);
    await new Promise((r) => setTimeout(r, sleepS * 1000));

    const now2 = Math.floor(Date.now() / 1000);
    const currentPeriod = Math.floor(now2 / periodSecs) * periodSecs;
    if (lastProcessed != null && currentPeriod === lastProcessed) {
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    process.stderr.write(
      `New period detected for ${marketName}! (Period: ${currentPeriod}) Discovering new market...\n`,
    );
    lastProcessed = currentPeriod;
    try {
      const nm = await discoverMarketForAsset(api, asset, tf, periodSecs);
      m.updateMarket(nm);
      setHistoryLogPeriod(currentPeriod);
      trader.resetPeriod();
    } catch (e) {
      process.stderr.write(
        `Failed to discover new ${marketName} market: ${e}\n`,
      );
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const forceProduction = args.production;
  const forceSimulation = args.simulation;
  if (forceProduction && forceSimulation) {
    process.stderr.write(
      "Both --production and --simulation; using production for config resolution.\n",
    );
  }

  const cfg = loadConfig({ forceProductionCli: forceProduction });
  const simulation = forceProduction
    ? false
    : forceSimulation
      ? true
      : cfg.simulation;

  let clobClient: ClobClient | null = null;
  if (!simulation) {
    warnProductionWalletSettings(cfg.polymarket);
    try {
      clobClient = await buildClobClient(cfg.polymarket);
    } catch (e) {
      process.stderr.write(
        `Ошибка инициализации CLOB-клиента (проверьте PRIVATE_KEY, npm install): ${e}\n`,
      );
      process.exit(2);
    }
  }

  configureHistoryDir(cfg.historyLogDir);
  configureHistoryFilesEnabled(cfg.historyLogEnabled);
  configureTradeOpenLogsOnly(cfg.trading.tradeOpenLogsOnly);
  if (!cfg.historyLogEnabled) {
    process.stderr.write(
      "[history] HISTORY_LOG_ENABLED=false — файлы period-*.toml не пишутся.\n",
    );
  }

  if (!simulation && cfg.polymarket.autoRedeem) {
    if (cfg.polymarket.redeemUseRelayer) {
      const miss =
        !(cfg.polymarket.polyBuilderApiKey ?? "").trim() ||
        !(cfg.polymarket.polyBuilderSecret ?? "").trim() ||
        !(cfg.polymarket.polyBuilderPassphrase ?? "").trim();
      if (miss) {
        process.stderr.write(
          "Предупреждение: REDEEM_USE_RELAYER=true, но не заданы " +
            "POLY_BUILDER_API_KEY / POLY_BUILDER_SECRET / POLY_BUILDER_PASSPHRASE.\n",
        );
      }
    } else if (
      cfg.polymarket.signatureType !== 0 &&
      (cfg.polymarket.relayerApiKey ?? "").trim() &&
      (cfg.polymarket.relayerApiKeyAddress ?? "").trim()
    ) {
      process.stderr.write(
        "Redeem: gasless RelayClient (RELAYER_API_KEY + RELAYER_API_KEY_ADDRESS), " +
          "PROXY при SIGNATURE_TYPE=1, SAFE при 2.\n",
      );
    } else {
      const proxy = (cfg.polymarket.proxyWalletAddress ?? "").trim();
      const rpc =
        (cfg.polymarket.polygonRpcUrl ?? "").trim() || DEFAULT_POLYGON_RPC_URL;
      if (proxy) {
        process.stderr.write(
          `Redeem через Gnosis Safe (${proxy.slice(0, 10)}…) → ${rpc}. ` +
            "EOA подпишет Safe-транзакцию (нужен POL на EOA для gas).\n",
        );
      } else {
        process.stderr.write(
          `Redeem напрямую от EOA → ${rpc}. ` +
            "При ошибках лимита задайте POLYGON_RPC_URL или включите REDEEM_USE_RELAYER.\n",
        );
      }
    }
  }

  const api = new PolymarketApi(cfg.polymarket, clobClient);
  const tc = cfg.trading;

  if (!simulation && cfg.polymarket.autoRedeem) {
    void api.sweepRedeemablePositions().catch((e) => {
      process.stderr.write(`[sweep redeemable startup] ${e}\n`);
    });
  }

  if (!tc.markets.length) {
    process.stderr.write("No markets configured. Set MARKETS in .env\n");
    process.exit(1);
  }

  const periodSecs = timeframeDurationSeconds(tc.upDownTimeframe);
  const tf = tc.upDownTimeframe;

  const trader = new DumpHedgeTrader(api, simulation, tc);

  type ValidRow = { asset: string; marketName: string; market: Market };
  const valid: ValidRow[] = [];
  for (const asset of tc.markets) {
    const name = `${asset.toUpperCase()} ${tf}`;
    process.stderr.write(`Discovering ${name} market...\n`);
    try {
      const m = await discoverMarketForAsset(api, asset, tf, periodSecs);
      valid.push({ asset, marketName: name, market: m });
    } catch (e) {
      process.stderr.write(
        `Failed to discover ${name} market: ${e} Skipping...\n`,
      );
    }
  }

  if (!valid.length) {
    process.stderr.write(
      "No valid markets found. Check MARKETS in .env and network.\n",
    );
    process.exit(1);
  }

  const initialPeriod = MarketMonitor.extractTimestampFromSlug(
    valid[0]!.market.slug,
  );
  setHistoryLogPeriod(initialPeriod);

  process.stderr.write("Starting Polymarket Hedge Trading Bot\n");
  const mode = simulation ? "SIMULATION" : "PRODUCTION (реальные ордера)";
  process.stderr.write(`Mode: ${mode}\n`);
  logPrintln(`[startup] period=${initialPeriod} | ${mode}`);
  process.stderr.write("Strategy: DUMP-AND-HEDGE\n");

  setInterval(() => {
    try {
      trader.checkMarketClosure();
      if (!simulation && cfg.polymarket.autoRedeem) {
        void api.sweepRedeemablePositions().catch((e) => {
          process.stderr.write(`[sweep redeemable] ${e}\n`);
        });
      }
      const tp = trader.getTotalProfit();
      const pp = trader.getPeriodProfit();
      if (tp !== 0 || pp !== 0) {
        logPrintln(
          `Current Profit - Period: $${pp.toFixed(2)} | Total: $${tp.toFixed(2)}`,
        );
      }
    } catch (e) {
      process.stderr.write(`Error checking market closure: ${e}\n`);
    }
  }, tc.marketClosureCheckIntervalSeconds * 1000);

  const tasks: Promise<unknown>[] = [];
  for (const { asset, marketName, market } of valid) {
    const box: { monitor: MarketMonitor } = {
      monitor: new MarketMonitor(
        api,
        marketName,
        market,
        tc.checkIntervalMs,
        periodSecs,
        {
          clobWsUrl: tc.clobWsUrl,
          websocketDebounceMs: tc.websocketDebounceMs,
          monitorUseHttp: tc.monitorUseHttp,
        },
      ),
    };

    tasks.push(
      (async () => {
        await box.monitor.startMonitoringLoop(async (snap) => {
          try {
            trader.processSnapshot(snap);
          } catch (e) {
            process.stderr.write(`Error processing snapshot: ${e}\n`);
          }
        });
      })(),
    );

    tasks.push(
      periodRotationLoop(api, trader, asset, marketName, tf, periodSecs, box),
    );
  }

  process.stderr.write(`Started monitoring ${valid.length} market(s)\n`);
  await Promise.all(tasks);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
