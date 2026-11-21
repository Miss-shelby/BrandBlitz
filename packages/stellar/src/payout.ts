import {
  Account,
  Keypair,
  TransactionBuilder,
  Operation,
  Memo,
  BASE_FEE,
  Transaction,
} from "@stellar/stellar-sdk";
import {
  getHorizonServer,
  getUsdcAsset,
  getNetworkPassphrase,
  withRetry,
  type NetworkName,
} from "./client";
import { MAX_OPS_PER_TX, PAYOUT_BATCH_DELAY_MS } from "./constants";
import { warn } from "./logger";
import {
  buildSequenceKeyPrefix,
  reserveSequence,
  resetSequence,
  type SequenceResetInfo,
  type SequenceStore,
} from "./sequence";

export interface PayoutRecipient {
  address: string;
  amount: string; // in USDC, e.g. "10.5000000"
}

export interface PayoutBatchResult {
  txHash: string;
  recipients: PayoutRecipient[];
  success: boolean;
  error?: string;
}

export interface SubmitBatchPayoutOptions {
  sequenceStore?: SequenceStore;
  onSequenceReset?: (info: SequenceResetInfo) => void | Promise<void>;
  maxBadSeqRetries?: number;
  onInvalidRecipient?: (recipient: PayoutRecipient, reason: string) => void;
  /**
   * When true, a batch rejected with `tx_insufficient_fee` is recovered by wrapping the
   * rejected transaction in a fee bump and submitting that instead. Off by default so
   * existing callers keep their current behaviour.
   */
  feeBumpOnInsufficientFee?: boolean;
  /** Maximum automatic fee-bump attempts per batch. Defaults to 2. */
  maxFeeBumpRetries?: number;
}

/**
 * Build and submit a batch payout transaction.
 * Up to MAX_OPS_PER_TX (50) Payment operations per transaction — atomic all-or-nothing.
 */
export async function submitBatchPayout(
  recipients: PayoutRecipient[],
  hotWalletSecret: string,
  challengeId: string,
  network: NetworkName = "testnet",
  options: SubmitBatchPayoutOptions = {}
): Promise<PayoutBatchResult[]> {
  if (recipients.length === 0) return [];

  const horizon = getHorizonServer(network);
  const usdc = getUsdcAsset(network);
  const passphrase = getNetworkPassphrase(network);
  const hotKeypair = Keypair.fromSecret(hotWalletSecret);
  const sequenceKeyPrefix = buildSequenceKeyPrefix(network, hotKeypair.publicKey());
  const maxBadSeqRetries = options.maxBadSeqRetries ?? 1;
  const maxFeeBumpRetries = options.maxFeeBumpRetries ?? 2;

  const loadBaseSequence = async () => {
    const account = await horizon.loadAccount(hotKeypair.publicKey());
    return account.sequenceNumber();
  };

  const validRecipients = recipients.filter((recipient) => {
    const reason = getInvalidRecipientReason(recipient);
    if (!reason) return true;

    if (options.onInvalidRecipient) {
      options.onInvalidRecipient(recipient, reason);
    } else {
      warn("Skipping invalid payout recipient", { recipient, reason });
    }

    return false;
  });

  if (validRecipients.length === 0) return [];

  const results: PayoutBatchResult[] = [];
  const batches = chunkArray(validRecipients, MAX_OPS_PER_TX);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    let attempts = 0;
    let feeBumpAttempts = 0;

    while (attempts <= maxBadSeqRetries) {
      let builtTx: Transaction | undefined;
      try {
        const sourceAccount = options.sequenceStore
          ? new Account(
              hotKeypair.publicKey(),
              (
                await reserveSequence({
                  store: options.sequenceStore,
                  keyPrefix: sequenceKeyPrefix,
                  loadBaseSequence,
                })
              ).accountSequence
            )
          : await horizon.loadAccount(hotKeypair.publicKey());

        const tx = new TransactionBuilder(sourceAccount, {
          fee: BASE_FEE,
          networkPassphrase: passphrase,
        })
          .addMemo(Memo.text(buildPayoutMemo(challengeId, i)))
          .setTimeout(180);

        for (const recipient of batch) {
          tx.addOperation(
            Operation.payment({
              destination: recipient.address,
              asset: usdc,
              amount: recipient.amount,
            })
          );
        }

        builtTx = tx.build() as Transaction;
        builtTx.sign(hotKeypair);

        const response = await withRetry(() => horizon.submitTransaction(builtTx), {
          maxAttempts: 5,
          baseDelayMs: 250,
          maxDelayMs: 30_000,
        });

        results.push({
          txHash: response.hash,
          recipients: batch,
          success: true,
        });

        break;
      } catch (err: any) {
        if (options.sequenceStore && isBadSequenceError(err) && attempts < maxBadSeqRetries) {
          attempts += 1;
          await resetSequence({
            store: options.sequenceStore,
            keyPrefix: sequenceKeyPrefix,
            loadBaseSequence,
            reason: "tx_bad_seq",
            onReset: options.onSequenceReset,
          });
          continue;
        }

        // Fee-rate rejection: the built transaction never reached the ledger, so wrap it
        // directly in a fee bump instead of re-building it (which would need a new sequence).
        let failure: any = err;
        let recovered = false;
        while (
          options.feeBumpOnInsufficientFee &&
          builtTx &&
          isInsufficientFeeError(failure) &&
          feeBumpAttempts < maxFeeBumpRetries
        ) {
          feeBumpAttempts += 1;
          try {
            const bumped = await submitFeeBump(
              builtTx,
              feeBumpFeeStroops(batch.length, feeBumpAttempts),
              hotKeypair,
              horizon,
              passphrase
            );
            results.push({
              txHash: bumped.feeBumpHash,
              recipients: batch,
              success: true,
            });
            recovered = true;
            break;
          } catch (bumpErr: any) {
            failure = bumpErr;
          }
        }

        if (!recovered) {
          results.push({
            txHash: "",
            recipients: batch,
            success: false,
            error: failure?.message ?? "Unknown error",
          });
        }
        break;
      }
    }

    if (!options.sequenceStore && i < batches.length - 1) {
      await delay(PAYOUT_BATCH_DELAY_MS);
    }
  }

  return results;
}

/**
 * Build a deterministic payout memo that respects Stellar's 28-byte text memo limit.
 */
function buildPayoutMemo(challengeId: string, batchIndex: number): string {
  const challengeTag = challengeId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 20);
  return `bb-${challengeTag}-${batchIndex}`;
}

function isBadSequenceError(err: unknown): boolean {
  const txCode =
    (err as any)?.response?.data?.extras?.result_codes?.transaction ??
    (err as any)?.data?.extras?.result_codes?.transaction;

  return txCode === "tx_bad_seq" || String((err as any)?.message ?? "").includes("tx_bad_seq");
}

export function isRetriableStellarError(err: unknown): boolean {
  const code = (err as any)?.code;
  const name = (err as any)?.name;
  const message = String((err as any)?.message ?? "").toLowerCase();

  return (
    code === "ECONNABORTED" ||
    name === "NetworkError" ||
    name === "TimeoutError" ||
    message.includes("networkerror") ||
    message.includes("timeout") ||
    message.includes("timed out")
  );
}

/**
 * Check if an error indicates insufficient transaction fee (tx_insufficient_fee).
 * These errors indicate the transaction could potentially be recovered with a fee bump.
 */
export function isInsufficientFeeError(err: unknown): boolean {
  const txCode =
    (err as any)?.response?.data?.extras?.result_codes?.transaction ??
    (err as any)?.data?.extras?.result_codes?.transaction;

  return (
    txCode === "tx_insufficient_fee" ||
    String((err as any)?.message ?? "").includes("tx_insufficient_fee")
  );
}

function getInvalidRecipientReason(recipient: PayoutRecipient): string | null {
  if (!recipient.address) {
    return "missing address";
  }

  if (!isValidStellarAmount(recipient.amount)) {
    return "amount must be a positive Stellar amount with up to 7 decimal places";
  }

  return null;
}

function isValidStellarAmount(amount: string): boolean {
  if (!/^\d+(?:\.\d{1,7})?$/.test(amount)) {
    return false;
  }

  return Number(amount) > 0;
}

function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wrap a transaction in a fee bump envelope and submit it to Stellar.
 * Used to recover stuck payout transactions when base fee spikes.
 *
 * @param originalTxHash - Hex hash of the stuck transaction
 * @param newMaxFeeStroops - New max fee for the bump (typically 2x current base fee)
 * @param hotWalletSecret - Hot wallet secret for signing the fee bump
 * @param network - Stellar network
 * @returns Fee bump transaction hash, or throws if submission fails
 */
export async function feeBumpTransaction(
  originalTxHash: string,
  newMaxFeeStroops: number,
  hotWalletSecret: string,
  network: NetworkName = "testnet"
): Promise<{ txHash: string; feeBumpHash: string }> {
  const horizon = getHorizonServer(network);
  const passphrase = getNetworkPassphrase(network);
  const hotKeypair = Keypair.fromSecret(hotWalletSecret);

  // Retrieve the original transaction from Stellar
  let originalTx: any;
  try {
    originalTx = await withRetry(() => horizon.transactionDetail(originalTxHash), {
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 5_000,
    });
  } catch (err) {
    throw new Error(
      `Failed to retrieve original transaction ${originalTxHash}: ${(err as Error).message}`
    );
  }

  if (!originalTx) {
    throw new Error(`Transaction ${originalTxHash} not found on Stellar`);
  }

  // Decode the original transaction envelope into a Transaction the SDK can wrap
  let innerTx: Transaction;
  try {
    innerTx = new Transaction(originalTx.envelope_xdr, passphrase);
  } catch (err) {
    throw new Error(`Failed to decode transaction XDR: ${(err as Error).message}`);
  }

  const result = await submitFeeBump(innerTx, newMaxFeeStroops, hotKeypair, horizon, passphrase);

  return {
    txHash: originalTxHash,
    feeBumpHash: result.feeBumpHash,
  };
}

/**
 * Fee-bump fee for a batch. The fee bump covers the inner operations plus itself,
 * so the total scales with (operations + 1) and doubles on each automatic attempt.
 */
function feeBumpFeeStroops(operationCount: number, attempt: number): number {
  return (operationCount + 1) * Number(BASE_FEE) * 2 ** attempt;
}

/**
 * Wrap an already-built inner transaction in a fee bump signed by the hot wallet and submit it.
 * Shared by feeBumpTransaction (for a tx found on-chain) and submitBatchPayout (for a tx
 * rejected with tx_insufficient_fee, which never reaches the ledger).
 */
async function submitFeeBump(
  innerTx: Transaction,
  newMaxFeeStroops: number,
  hotKeypair: Keypair,
  horizon: ReturnType<typeof getHorizonServer>,
  passphrase: string
): Promise<{ feeBumpHash: string }> {
  // newMaxFeeStroops is the total fee; the SDK takes a per-operation base fee
  const perOpFee = Math.ceil(newMaxFeeStroops / (innerTx.operations.length + 1));

  const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
    hotKeypair,
    perOpFee.toString(),
    innerTx,
    passphrase
  );

  feeBumpTx.sign(hotKeypair);

  const result = await withRetry(() => horizon.submitTransaction(feeBumpTx), {
    maxAttempts: 5,
    baseDelayMs: 250,
    maxDelayMs: 30_000,
  });

  return { feeBumpHash: result.hash };
}
