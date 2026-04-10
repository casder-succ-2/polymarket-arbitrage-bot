/** Period-scoped history files (Python `history_log.py` parity). */

import * as fs from "node:fs";
import * as path from "node:path";

let historyStream: fs.WriteStream | null = null;
let activePeriod: number | null = null;
let activePath: string | null = null;

let baseDir = "logs";

/** Если true — в stderr/period-файл попадают только строки из `logTradeOpen` (ордера / открытие ног). */
let tradeOpenLogsOnly = false;

/** Если false — файлы `period-*.toml` не создаются (логи только в stderr). */
let historyFilesEnabled = true;

export function configureHistoryDir(dirPath: string): void {
  baseDir = dirPath;
}

export function configureHistoryFilesEnabled(enabled: boolean): void {
  historyFilesEnabled = enabled;
}

export function configureTradeOpenLogsOnly(enabled: boolean): void {
  tradeOpenLogsOnly = enabled;
}

function emitHistory(message: string, tradeEvent: boolean): void {
  if (tradeOpenLogsOnly && !tradeEvent) return;
  process.stderr.write(message);
  if (historyStream != null) {
    historyStream.write(message);
  }
}

export function setHistoryLogPeriod(periodTimestamp: number): string {
  if (
    historyFilesEnabled &&
    activePeriod === periodTimestamp &&
    historyStream != null
  ) {
    return activePath ?? "";
  }

  if (historyStream != null) {
    historyStream.end();
    historyStream = null;
  }

  activePeriod = periodTimestamp;
  activePath = null;

  if (!historyFilesEnabled) {
    return "";
  }

  fs.mkdirSync(baseDir, { recursive: true });
  const full = path.join(baseDir, `period-${periodTimestamp}.toml`);
  historyStream = fs.createWriteStream(full, { flags: "a", encoding: "utf8" });
  activePath = full;
  if (!tradeOpenLogsOnly) {
    process.stderr.write(`[history] Log file: ${full}\n`);
  }
  return full;
}

export function logToHistory(message: string): void {
  emitHistory(message, false);
}

export function logPrintln(...args: unknown[]): void {
  emitHistory(args.map(String).join(" ") + "\n", false);
}

/** События открытия/исполнения сделки (видны при TRADE_OPEN_LOGS_ONLY=true). */
export function logTradeOpen(...args: unknown[]): void {
  emitHistory(args.map(String).join(" ") + "\n", true);
}
