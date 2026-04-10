# Polymarket dump-and-hedge bot (TypeScript / Node.js)

Бот по стратегии **dump-and-hedge** для рынков Polymarket **Up/Down** (5m / 15m / 1h), порт логики репозитория на Python (`D:\new_bot`): те же env-переменные, WebSocket CLOB, лестница стоп-лосса, redeem через EOA / Gnosis Safe / Relayer.

[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5+-blue.svg)](https://www.typescriptlang.org/)

## Быстрый старт

```bash
npm install
npm run build
cp .env.example .env
# симуляция (без ордеров)
npm run sim
# прод: PRODUCTION=true и PRIVATE_KEY в .env
npm run prod
```

Логи стратегии: **stderr** + при `HISTORY_LOG_ENABLED=true` (по умолчанию) файлы `HISTORY_LOG_DIR/period-<timestamp>.toml` (как Python `history_log.py`). При `HISTORY_LOG_ENABLED=false` файлы не пишутся.

## Поведение (как в Python)

- Поиск рынка по slug `{asset}-updown-{timeframe}-{period}` (Gamma), сдвиг на 1–3 прошлых периода при необходимости.
- Мониторинг: по умолчанию **WebSocket** `CLOB_WS_URL`; при `MONITOR_USE_HTTP=true` — опрос REST и `CHECK_INTERVAL_MS`.
- Стратегия: окно дампа, асинхронный Leg1 BUY, ожидание хеджа по `DUMP_HEDGE_SUM_TARGET`, стоп по минутам от **начала периода** рынка, опционально **лимитная лестница** (`DUMP_HEDGE_STOP_LOSS_USE_LIMIT_LADDER`).
- CLOB: рыночный BUY FOK: потолок цены `min(0.99, reference_price * ORDER_USD_SLIPPAGE_MULT)`, бюджет `shares * этот_потолок` — так совпадает с формулой клиента `takerAmount ≈ amount / price` (`clob_trading`). При «order couldn't be fully filled» в stderr будет `request error`, бот **до 4 повторов** с шагом +0.04 к множителю (потолок mult 1.55); при узком стакане поднимите `ORDER_USD_SLIPPAGE_MULT`.
- Redeem: `AUTO_REDEEM`; при `REDEEM_USE_RELAYER=true` — `POLY_BUILDER_*`; иначе при `SIGNATURE_TYPE` 1/2 и пара **`RELAYER_API_KEY` + `RELAYER_API_KEY_ADDRESS`** (см. [Relayer / API keys](https://docs.polymarket.com/developers/builders/relayer-client)) — gasless `RelayClient`; далее Safe / EOA. **Claim по кошельку:** при старте и каждые `MARKET_CLOSURE_CHECK_INTERVAL_SECONDS` вызывается sweep data-api (`positions?redeemable=true` для `PROXY_WALLET_ADDRESS` или `RELAYER_API_KEY_ADDRESS` — любые redeemable позиции, до ~12 `conditionId` за проход, пагинация и пауза между вызовами relayer), не только сделки из памяти бота; `checkMarketClosure` по-прежнему ведёт учёт PnL по открытым ботом циклам.
- Закрытие периода: проверка резолва, опционально on-chain `payoutDenominator`, отмена ордеров по рынку, PnL.
- Опционально `TRADE_OPEN_LOGS_ONLY=true`: в stderr и (если включены файлы) `HISTORY_LOG_DIR` только события ордеров и открытия ног (без потока котировок из монитора).

## Структура

| Файл | Назначение |
|------|------------|
| `src/main.ts` | Точка входа, discovery, потоки мониторинга и смены периода |
| `src/config.ts` | `.env`, таймфреймы 5m/15m/1h |
| `src/api.ts` | Gamma + CLOB + merge резолва с Gamma |
| `src/monitor.ts` | WebSocket / HTTP снимки |
| `src/dumpHedgeTrader.ts` | Фазы стратегии и лестница |
| `src/clobTrading.ts` | Аутентификация CLOB, market/limit ордера |
| `src/ctfRedeem.ts` | Redeem CTF (RPC + ethers + опционально relayer) |
| `src/historyLog.ts` | Лог по периоду |
| `src/httpClient.ts` | HTTP JSON |
| `src/contractConfig.ts` | Адреса контрактов (как `py_clob_client.config`) |

## Конфигурация

Полный список переменных — в **`.env.example`** (совместим с Python `.env.example`: `UP_DOWN_TIMEFRAME`, `WEBSOCKET_DEBOUNCE_MS`, `DUMP_HEDGE_STOP_LOSS_USE_LIMIT_LADDER`, `POLY_BUILDER_*`, и т.д.).

## Скрипты

| Команда | Описание |
|---------|----------|
| `npm run build` | `tsc` → `dist/` |
| `npm start` | `node dist/main.js` (режим из `PRODUCTION`) |
| `npm run sim` | `--simulation` |
| `npm run prod` | `--production` |
| `npm run dev` | `tsx src/main.ts` |
| `npm run lint` / `format` | Biome |

## Замечания

- Торговля и redeem в проде требуют корректных `PRIVATE_KEY`, при типах подписи 1/2 — `PROXY_WALLET_ADDRESS`.
- На Polygon для прямого redeem нужен **POL** на EOA (gas); для Safe — EOA подписывает execTransaction.

## Лицензия и дисклеймер

См. [LICENSE](LICENSE). Программа для исследований; торговля несёт риски; это не финансовый совет.
