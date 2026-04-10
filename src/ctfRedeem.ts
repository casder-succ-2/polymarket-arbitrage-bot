/**
 * CTF redeem (Python `ctf_redeem.py` parity).
 * JSON-RPC via fetch; txs via ethers v5.
 */

import { RelayClient } from "@polymarket/builder-relayer-client";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import {
  constants,
  BigNumber,
  Contract,
  Wallet,
  providers,
  utils,
} from "ethers";
import { http, type WalletClient, createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

const ZERO = "0x0000000000000000000000000000000000000000";

function normalizePk(privateKey: string): string {
  const pk = privateKey.trim();
  return pk.startsWith("0x") ? pk : `0x${pk}`;
}

function conditionToBytes32(conditionIdHex: string): string {
  let cid = conditionIdHex.trim();
  if (cid.startsWith("0x")) cid = cid.slice(2);
  if (cid.length !== 64)
    throw new Error(
      `condition_id must be 32 bytes hex, got ${cid.length / 2} bytes`,
    );
  return `0x${cid}`;
}

async function rpcCall(
  url: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method,
    params,
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const out = (await res.json()) as { error?: unknown; result?: unknown };
  if (out.error) throw new Error(String(out.error));
  return out.result;
}

class RpcRouter {
  private readonly urls: string[];
  private activeIdx = 0;

  constructor(primary: string, fallbacks: string[]) {
    const seen = new Set<string>();
    this.urls = [];
    for (const u of [primary, ...fallbacks]) {
      const x = u.trim().replace(/\/$/, "");
      if (x && !seen.has(x)) {
        seen.add(x);
        this.urls.push(x);
      }
    }
    if (this.urls.length === 0) throw new Error("No RPC URLs configured");
  }

  get activeUrl(): string {
    return this.urls[this.activeIdx]!;
  }

  async call(
    method: string,
    params: unknown[],
    timeoutMs = 90_000,
  ): Promise<unknown> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < this.urls.length; attempt++) {
      const idx = (this.activeIdx + attempt) % this.urls.length;
      const url = this.urls[idx]!;
      try {
        const result = await Promise.race([
          rpcCall(url, method, params),
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error("RPC timeout")), timeoutMs),
          ),
        ]);
        if (idx !== this.activeIdx) {
          process.stderr.write(`[RPC] Switched to ${url}\n`);
          this.activeIdx = idx;
        }
        return result;
      } catch (e) {
        const msg = String(e);
        const lo = msg.toLowerCase();
        const transient =
          msg.includes("403") ||
          msg.includes("429") ||
          msg.includes("500") ||
          msg.includes("502") ||
          msg.includes("503") ||
          lo.includes("timeout") ||
          lo.includes("econnreset");
        if (transient) {
          process.stderr.write(
            `[RPC] ${url} → ${msg.slice(0, 120)} (trying next...)\n`,
          );
          lastErr = e;
          continue;
        }
        throw e;
      }
    }
    throw new Error(
      `All ${this.urls.length} RPCs failed. Last: ${String(lastErr)}`,
    );
  }
}

const redeemIface = new utils.Interface([
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
]);

const payoutIface = new utils.Interface([
  "function payoutDenominator(bytes32 conditionId) view returns (uint256)",
]);

export function encodeRedeemPositionsCalldata(args: {
  collateralToken: string;
  conditionIdHex: string;
  indexSets?: number[];
}): string {
  const idx = args.indexSets ?? [1, 2];
  return redeemIface.encodeFunctionData("redeemPositions", [
    utils.getAddress(args.collateralToken),
    constants.HashZero,
    conditionToBytes32(args.conditionIdHex),
    idx,
  ]);
}

export async function checkConditionResolvedOnchain(args: {
  rpcUrl: string;
  ctfContract: string;
  conditionIdHex: string;
  rpcFallbacks?: string[];
}): Promise<boolean> {
  const rpc = new RpcRouter(args.rpcUrl, args.rpcFallbacks ?? []);
  const ctf = utils.getAddress(args.ctfContract);
  const data = payoutIface.encodeFunctionData("payoutDenominator", [
    conditionToBytes32(args.conditionIdHex),
  ]);
  try {
    const result = (await rpc.call(
      "eth_call",
      [{ to: ctf, data }, "latest"],
      30_000,
    )) as string;
    if (result && result !== "0x") {
      const val = BigNumber.from(result);
      return val.gt(0);
    }
  } catch (e) {
    process.stderr.write(`[Redeem] on-chain resolution check failed: ${e}\n`);
  }
  return false;
}

function warnProxyMismatch(
  signerAddress: string,
  proxyWallet?: string | null,
): void {
  if (!proxyWallet?.trim()) return;
  try {
    const p = utils.getAddress(proxyWallet.trim());
    const s = utils.getAddress(signerAddress);
    if (p !== s) {
      process.stderr.write(
        "Внимание: PROXY_WALLET_ADDRESS ≠ адрес из PRIVATE_KEY. Прямой EOA-redeem " +
          "не заберёт токены с proxy/Safe. Используйте redeem через Gnosis Safe " +
          "(задайте PROXY_WALLET_ADDRESS) или REDEEM_USE_RELAYER=true.\n",
      );
    }
  } catch {
    /* ignore */
  }
}

export async function sendRedeemPositions(args: {
  rpcUrl: string;
  privateKey: string;
  chainId: number;
  collateralToken: string;
  ctfContract: string;
  conditionIdHex: string;
  indexSets?: number[];
  proxyWalletAddress?: string | null;
  waitForReceipt?: boolean;
  rpcFallbacks?: string[];
}): Promise<Record<string, unknown>> {
  const idx = args.indexSets ?? [1, 2];
  const pk = normalizePk(args.privateKey);
  const wallet = new Wallet(pk);
  warnProxyMismatch(wallet.address, args.proxyWalletAddress);
  const rpc = new RpcRouter(args.rpcUrl, args.rpcFallbacks ?? []);
  const provider = new providers.JsonRpcProvider(rpc.activeUrl);
  const signer = wallet.connect(provider);
  const ctf = utils.getAddress(args.ctfContract);
  const data = encodeRedeemPositionsCalldata({
    collateralToken: args.collateralToken,
    conditionIdHex: args.conditionIdHex,
    indexSets: idx,
  });

  const addr = await signer.getAddress();
  const nonce = await provider.getTransactionCount(addr, "pending");
  const gasEst = await provider.estimateGas({ from: addr, to: ctf, data });
  const gasLimit = gasEst.mul(115).div(100);

  const fee = await provider.getFeeData();
  let txRequest: providers.TransactionRequest = {
    chainId: args.chainId,
    nonce,
    to: ctf,
    value: 0,
    data,
    gasLimit,
  };
  if (fee.maxFeePerGas != null && fee.maxPriorityFeePerGas != null) {
    txRequest = {
      ...txRequest,
      maxFeePerGas: fee.maxFeePerGas,
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
      type: 2,
    };
  } else {
    txRequest.gasPrice = fee.gasPrice ?? undefined;
  }

  const tx = await signer.sendTransaction(txRequest);
  const out: Record<string, unknown> = {
    tx_hash: tx.hash,
    status: "submitted",
    mode: "rpc",
    rpc_used: rpc.activeUrl,
  };
  if (args.waitForReceipt !== false) {
    const receipt = await tx.wait(1);
    if (!receipt?.status)
      throw new Error(`Redeem transaction reverted: ${tx.hash}`);
    out.receipt_status = receipt.status;
    out.status = "ok";
  }
  return out;
}

const safeIface = new utils.Interface([
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool)",
]);

export async function sendRedeemViaGnosisSafe(args: {
  rpcUrl: string;
  privateKey: string;
  chainId: number;
  safeAddress: string;
  collateralToken: string;
  ctfContract: string;
  conditionIdHex: string;
  indexSets?: number[];
  waitForReceipt?: boolean;
  rpcFallbacks?: string[];
}): Promise<Record<string, unknown>> {
  const idx = args.indexSets ?? [1, 2];
  const pk = normalizePk(args.privateKey);
  const wallet = new Wallet(pk);
  const rpc = new RpcRouter(args.rpcUrl, args.rpcFallbacks ?? []);
  const provider = new providers.JsonRpcProvider(rpc.activeUrl);

  const safe = utils.getAddress(args.safeAddress);
  const ctf = utils.getAddress(args.ctfContract);
  const zero = utils.getAddress(ZERO);

  const innerData = encodeRedeemPositionsCalldata({
    collateralToken: args.collateralToken,
    conditionIdHex: args.conditionIdHex,
    indexSets: idx,
  });
  const innerBytes = utils.arrayify(innerData);

  process.stderr.write(
    `[Redeem] Gnosis Safe ${safe} | RPC: ${rpc.activeUrl}\n`,
  );

  const safeContract = new Contract(safe, safeIface, provider);
  const safeNonce: BigNumber = await safeContract.nonce();

  const safeTxHashData = safeIface.encodeFunctionData("getTransactionHash", [
    ctf,
    0,
    innerBytes,
    0,
    0,
    0,
    0,
    zero,
    zero,
    safeNonce,
  ]);
  const safeTxHashHex = (await rpc.call("eth_call", [
    { to: safe, data: safeTxHashData },
    "latest",
  ])) as string;
  const safeTxHash = utils.arrayify(safeTxHashHex);

  const flat = wallet._signingKey().signDigest(safeTxHash);
  const sig = utils.arrayify(utils.joinSignature(flat));

  const execData = safeIface.encodeFunctionData("execTransaction", [
    ctf,
    0,
    innerBytes,
    0,
    0,
    0,
    0,
    zero,
    zero,
    sig,
  ]);

  const signer = wallet.connect(provider);
  const eoaAddr = await signer.getAddress();
  const eoaNonce = await provider.getTransactionCount(eoaAddr, "pending");
  const gasEst = await provider.estimateGas({
    from: eoaAddr,
    to: safe,
    data: execData,
  });
  const gasLimit = gasEst.mul(120).div(100);

  const fee = await provider.getFeeData();
  let txRequest: providers.TransactionRequest = {
    chainId: args.chainId,
    nonce: eoaNonce,
    to: safe,
    value: 0,
    data: execData,
    gasLimit,
  };
  if (fee.maxFeePerGas != null && fee.maxPriorityFeePerGas != null) {
    txRequest = {
      ...txRequest,
      maxFeePerGas: fee.maxFeePerGas,
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
      type: 2,
    };
  } else {
    txRequest.gasPrice = fee.gasPrice ?? undefined;
  }

  const tx = await signer.sendTransaction(txRequest);
  const out: Record<string, unknown> = {
    tx_hash: tx.hash,
    status: "submitted",
    mode: "gnosis_safe",
    rpc_used: rpc.activeUrl,
  };
  if (args.waitForReceipt !== false) {
    const receipt = await tx.wait(1);
    if (!receipt?.status)
      throw new Error(`Safe redeem transaction reverted: ${tx.hash}`);
    out.receipt_status = receipt.status;
    out.status = "ok";
  }
  return out;
}

export async function sendRedeemViaPolymarketRelayer(args: {
  relayerUrl: string;
  privateKey: string;
  chainId: number;
  collateralToken: string;
  ctfContract: string;
  conditionIdHex: string;
  builderApiKey: string;
  builderSecret: string;
  builderPassphrase: string;
  indexSets?: number[];
}): Promise<Record<string, unknown>> {
  const idx = args.indexSets ?? [1, 2];
  const pk = normalizePk(args.privateKey);
  const data = encodeRedeemPositionsCalldata({
    collateralToken: args.collateralToken,
    conditionIdHex: args.conditionIdHex,
    indexSets: idx,
  });

  const builderConfig = new BuilderConfig({
    localBuilderCreds: {
      key: args.builderApiKey.trim(),
      secret: args.builderSecret.trim(),
      passphrase: args.builderPassphrase.trim(),
    },
  });

  const hex = pk as `0x${string}`;
  const account = privateKeyToAccount(hex);
  const rpc =
    process.env.POLYGON_RPC_URL?.trim() ||
    "https://polygon-bor-rpc.publicnode.com";
  const viemWallet: WalletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http(rpc),
  });

  const client = new RelayClient(
    args.relayerUrl.replace(/\/$/, ""),
    args.chainId,
    viemWallet as never,
    builderConfig,
  );

  const safeAddr = await (
    client as unknown as { getExpectedSafe: () => Promise<string> }
  ).getExpectedSafe();
  const deployed = await client.getDeployed(safeAddr);
  if (!deployed) {
    throw new Error(
      `Для relayer-redeem нужен задеплоенный Safe (${safeAddr}). ` +
        "См. https://docs.polymarket.com/developers/builders/relayer-client",
    );
  }

  const resp = await client.execute(
    [{ to: utils.getAddress(args.ctfContract), data, value: "0" }],
    "Redeem CTF positions (bot)",
  );
  const result = await resp.wait();
  if (result == null) {
    throw new Error(
      `Relayer redeem не дошёл до успешного состояния (id=${resp.transactionID})`,
    );
  }
  return {
    status: "ok",
    mode: "relayer",
    tx_hash: resp.transactionHash,
    transaction_id: resp.transactionID,
  };
}
