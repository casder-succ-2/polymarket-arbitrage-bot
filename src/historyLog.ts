/** Period-scoped history files (Python `history_log.py` parity). */

import * as fs from "node:fs";
import * as path from "node:path";

let historyStream: fs.WriteStream | null = null;
let activePeriod: number | null = null;
let activePath: string | null = null;

let baseDir = "logs";

export function configureHistoryDir(dirPath: string): void {
  baseDir = dirPath;
}

export function setHistoryLogPeriod(periodTimestamp: number): string {
  if (activePeriod === periodTimestamp && historyStream != null) {
    return activePath ?? "";
  }

  if (historyStream != null) {
    historyStream.end();
    historyStream = null;
  }

  activePeriod = periodTimestamp;
  fs.mkdirSync(baseDir, { recursive: true });
  const full = path.join(baseDir, `period-${periodTimestamp}.toml`);
  historyStream = fs.createWriteStream(full, { flags: "a", encoding: "utf8" });
  activePath = full;
  process.stderr.write(`[history] Log file: ${full}\n`);
  return full;
}

export function logToHistory(message: string): void {
  process.stderr.write(message);
  if (historyStream != null) {
    historyStream.write(message);
  }
}

export function logPrintln(...args: unknown[]): void {
  logToHistory(args.map(String).join(" ") + "\n");
}
