/** Mirrors `py_clob_client.config.get_contract_config` (Polygon mainnet). */

export interface ContractConfigRow {
  exchange: string;
  collateral: string;
  conditionalTokens: string;
}

const CONFIG: Record<number, ContractConfigRow> = {
  137: {
    exchange: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
    collateral: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    conditionalTokens: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
  },
};

const NEG_RISK_CONFIG: Record<number, ContractConfigRow> = {
  137: {
    exchange: "0xC5d563A36AE78145C45a50134d48A1215220f80a",
    collateral: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
    conditionalTokens: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
  },
};

export function getContractConfig(
  chainId: number,
  negRisk = false,
): ContractConfigRow {
  const table = negRisk ? NEG_RISK_CONFIG : CONFIG;
  const row = table[chainId];
  if (!row) throw new Error(`Invalid chainID: ${chainId}`);
  return row;
}
