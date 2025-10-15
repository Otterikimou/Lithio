import { grpc } from "@improbable-eng/grpc-web";
import {
  NexusSDK,
  type EthereumProvider,
  type ExactInSwapInput,
  type SwapInputOptionalParams,
  type SwapIntent,
  type SwapResult,
} from "@avail-project/nexus-core";
import { webcrypto as nodeWebCrypto } from "node:crypto";
import { isHex, type Hex, type WalletClient } from "viem";

export type AvailNetwork = "mainnet" | "testnet";

export interface AvailHooks {
  onIntent?: Parameters<NexusSDK["setOnIntentHook"]>[0];
  onAllowance?: Parameters<NexusSDK["setOnAllowanceHook"]>[0];
}

export interface AvailClientOptions {
  network?: AvailNetwork;
  signerOrProvider: EthereumProvider | WalletClient;
  hooks?: AvailHooks;
}

export interface SwapExactInInput {
  fromChainId: number;
  fromToken: Hex;
  amount: bigint;
  toChainId: number;
  toToken: Hex;
}

type AnyWalletClient = WalletClient<any, any, any, any>;

const USER_DENIED_INTENT_MESSAGE = "User denied swap";

export class AvailClient {
  private constructor(private readonly sdk: NexusSDK) {}

  static async create(options: AvailClientOptions): Promise<AvailClient> {
    assertBrowserEnvironment();
    ensureSdkBrowserShim();
    ensureGrpcTransport();
    const { network = "mainnet", signerOrProvider, hooks } = options;
    const sdk = new NexusSDK({ network });

    if (hooks?.onIntent) {
      sdk.setOnIntentHook(hooks.onIntent);
    }

    if (hooks?.onAllowance) {
      sdk.setOnAllowanceHook(hooks.onAllowance);
    }

    const provider = normalizeProvider(signerOrProvider);
    await sdk.initialize(provider);

    return new AvailClient(sdk);
  }

  get chainList() {
    return this.sdk.chainList;
  }

  on(eventName: string, listener: (...args: unknown[]) => void) {
    this.sdk.nexusEvents.on(eventName, listener);
    return () => this.sdk.nexusEvents.removeListener(eventName, listener);
  }

  async simulateSwapExactIn(input: SwapExactInInput): Promise<SwapIntent> {
    const exactIn = toExactInInput(input);
    let capturedIntent: SwapIntent | undefined;

    try {
      await this.sdk.swapWithExactIn(exactIn, {
        swapIntentHook: ({ intent, deny }) => {
          capturedIntent = intent;
          deny();
        },
      });
    } catch (error) {
      if (!isUserDeniedIntent(error)) {
        throw error;
      }
    }

    if (!capturedIntent) {
      throw new Error("Simulation failed to produce an intent.");
    }

    return capturedIntent;
  }

  async swapExactIn(
    input: SwapExactInInput,
    overrides?: SwapInputOptionalParams
  ): Promise<SwapResult> {
    const exactIn = toExactInInput(input);
    return this.sdk.swapWithExactIn(exactIn, overrides);
  }
}

const toExactInInput = (input: SwapExactInInput): ExactInSwapInput => ({
  from: [
    {
      chainId: input.fromChainId,
      amount: input.amount,
      tokenAddress: input.fromToken,
    },
  ],
  toChainId: input.toChainId,
  toTokenAddress: input.toToken,
});

const isEthereumProvider = (input: unknown): input is EthereumProvider => {
  if (!input || typeof input !== "object") {
    return false;
  }

  const provider = input as Partial<EthereumProvider>;
  return (
    typeof provider.request === "function" &&
    typeof provider.on === "function" &&
    typeof provider.removeListener === "function"
  );
};

const isWalletClient = (input: unknown): input is AnyWalletClient => {
  if (!input || typeof input !== "object") {
    return false;
  }

  const candidate = input as Partial<AnyWalletClient>;
  return (
    typeof candidate.request === "function" &&
    typeof candidate.transport === "object" &&
    typeof candidate.extend === "function"
  );
};

const normalizeProvider = (
  signerOrProvider: EthereumProvider | WalletClient
): EthereumProvider => {
  if (isEthereumProvider(signerOrProvider)) {
    return signerOrProvider;
  }

  if (isWalletClient(signerOrProvider)) {
    return walletClientToEthereumProvider(signerOrProvider);
  }

  throw new Error("Unsupported signerOrProvider type for AvailClient.");
};

const walletClientToEthereumProvider = (
  walletClient: AnyWalletClient
): EthereumProvider => {
  const listeners = new Map<
    string | symbol,
    Set<(...args: unknown[]) => void>
  >();
  const accountAddress = walletClient.account?.address;
  const initialChainId = walletClient.chain?.id;
  let currentChainId = initialChainId;

  const provider: EthereumProvider = {
    request: async (args) => {
      switch (args.method) {
        case "eth_chainId": {
          if (currentChainId !== undefined) {
            return `0x${currentChainId.toString(16)}`;
          }
          break;
        }
        case "eth_accounts":
        case "eth_requestAccounts": {
          return accountAddress ? [accountAddress] : [];
        }
        case "personal_sign": {
          const { account, message } = normalizePersonalSignParams(
            args.params,
            accountAddress
          );
          return signMessageWithWallet(walletClient, account, message);
        }
        case "eth_sign": {
          const { account, message } = normalizeEthSignParams(
            args.params,
            accountAddress
          );
          return signMessageWithWallet(walletClient, account, message);
        }
        case "wallet_switchEthereumChain": {
          const params = Array.isArray(args.params)
            ? args.params[0]
            : undefined;
          const chainIdHex =
            typeof params === "object" && params
              ? (params as { chainId?: string }).chainId
              : undefined;
          if (chainIdHex) {
            const parsed = Number.parseInt(chainIdHex, 16);
            if (!Number.isNaN(parsed)) {
              currentChainId = parsed;
              listeners
                .get("chainChanged")
                ?.forEach((listener) => listener(chainIdHex));
            }
          }
          return null;
        }
        default:
          break;
      }

      return walletClient.request(
        args as Parameters<AnyWalletClient["request"]>[0]
      );
    },
    on: (eventName, listener) => {
      if (!listeners.has(eventName)) {
        listeners.set(eventName, new Set());
      }
      listeners.get(eventName)!.add(listener);
      return provider;
    },
    removeListener: (eventName, listener) => {
      listeners.get(eventName)?.delete(listener);
      if (listeners.get(eventName)?.size === 0) {
        listeners.delete(eventName);
      }
      return provider;
    },
  };

  return provider;
};

type SignableMessage = string | { raw: Hex };

const isAddress = (value: unknown): value is `0x${string}` =>
  typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);

const toSignableMessage = (value: string) =>
  isHex(value) ? ({ raw: value } as SignableMessage) : value;

const normalizePersonalSignParams = (
  params: unknown,
  fallbackAccount?: string
): {
  account: `0x${string}`;
  message: SignableMessage;
} => {
  const [first, second] = Array.isArray(params)
    ? (params as unknown[])
    : [undefined, undefined];

  const accountCandidate =
    (isAddress(second) && (second as `0x${string}`)) ||
    (isAddress(first) && (first as `0x${string}`)) ||
    (isAddress(fallbackAccount) ? (fallbackAccount as `0x${string}`) : undefined);

  if (!accountCandidate) {
    throw new Error("personal_sign request missing account address.");
  }

  const messageCandidate =
    (typeof first === "string" && !isAddress(first) && first) ||
    (typeof second === "string" && !isAddress(second) && second);

  if (!messageCandidate) {
    throw new Error("personal_sign request missing message payload.");
  }

  return {
    account: accountCandidate,
    message: toSignableMessage(messageCandidate),
  };
};

const normalizeEthSignParams = (
  params: unknown,
  fallbackAccount?: string
): {
  account: `0x${string}`;
  message: SignableMessage;
} => {
  const [first, second] = Array.isArray(params)
    ? (params as unknown[])
    : [undefined, undefined];

  const accountCandidate =
    (isAddress(first) && (first as `0x${string}`)) ||
    (isAddress(second) && (second as `0x${string}`)) ||
    (isAddress(fallbackAccount) ? (fallbackAccount as `0x${string}`) : undefined);

  if (!accountCandidate) {
    throw new Error("eth_sign request missing account address.");
  }

  const messageCandidate =
    (typeof second === "string" && !isAddress(second) && second) ||
    (typeof first === "string" && !isAddress(first) && first);

  if (!messageCandidate) {
    throw new Error("eth_sign request missing message payload.");
  }

  return {
    account: accountCandidate,
    message: toSignableMessage(messageCandidate),
  };
};

const signMessageWithWallet = async (
  walletClient: AnyWalletClient,
  account: `0x${string}`,
  message: SignableMessage
) => {
  const signer = walletClient.account as
    | {
        signMessage?: (args: { message: SignableMessage }) => Promise<Hex>;
      }
    | undefined;

  if (signer?.signMessage) {
    return signer.signMessage({
      message: message as any,
    });
  }

  if (typeof walletClient.signMessage === "function") {
    // As a fallback, delegate to the wallet client itself.
    return walletClient.signMessage({
      account: account as any,
      message: message as any,
    });
  }

  throw new Error("Wallet client does not support local message signing.");
};

const isUserDeniedIntent = (error: unknown) =>
  error instanceof Error && error.message === USER_DENIED_INTENT_MESSAGE;

type GlobalWithWindow = typeof globalThis & {
  window?: {
    location?: {
      protocol?: string;
      host?: string;
      origin?: string;
    };
    crypto?: typeof globalThis.crypto;
    setInterval?: typeof setInterval;
    clearInterval?: typeof clearInterval;
    setTimeout?: typeof setTimeout;
    clearTimeout?: typeof clearTimeout;
  };
  crypto?: typeof globalThis.crypto;
};

const ensureSdkBrowserShim = () => {
  const globalScope = globalThis as GlobalWithWindow;
  const origin =
    process.env.AVAIL_SDK_ORIGIN ??
    process.env.PUBLIC_URL ??
    "https://localhost";

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    parsedOrigin = new URL("https://localhost");
  }

  if (!globalScope.window) {
    globalScope.window = {};
  }

  const win = globalScope.window;

  if (!win.location) {
    win.location = {
      protocol: parsedOrigin.protocol,
      host: parsedOrigin.host,
      origin: parsedOrigin.origin,
    };
  } else {
    win.location.protocol ??= parsedOrigin.protocol;
    win.location.host ??= parsedOrigin.host;
    win.location.origin ??= parsedOrigin.origin;
  }

  const cryptoImpl =
    globalScope.crypto ??
    win.crypto ??
    (nodeWebCrypto as unknown as typeof globalThis.crypto) ??
    undefined;

  if (cryptoImpl) {
    win.crypto = cryptoImpl;
    globalScope.crypto ??= cryptoImpl;
  }

  win.setInterval ??= globalThis.setInterval.bind(globalThis);
  win.clearInterval ??= globalThis.clearInterval.bind(globalThis);
  win.setTimeout ??= globalThis.setTimeout.bind(globalThis);
  win.clearTimeout ??= globalThis.clearTimeout.bind(globalThis);
};

let grpcTransportConfigured = false;

const assertBrowserEnvironment = () => {
  const isBunRuntime =
    typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  const globalProcess = (globalThis as {
    process?: { release?: { name?: string } };
  }).process;
  const isNodeRuntime =
    typeof globalProcess?.release?.name === "string" &&
    globalProcess.release.name.toLowerCase() === "node";
  const hasBrowserGlobals =
    typeof window !== "undefined" &&
    typeof document !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.userAgent === "string";

  if (!hasBrowserGlobals || isBunRuntime || isNodeRuntime) {
    const docsPath =
      "resources/nexus-docs/app/nexus/nexus-overview/page.mdx";
    throw new Error(
      [
        "AvailClient requires a browser runtime.",
        "Run swaps from a web app (see docs for details).",
        `Docs: ${docsPath}`,
      ].join(" ")
    );
  }
};

const ensureGrpcTransport = () => {
  if (grpcTransportConfigured) {
    return;
  }

  grpcTransportConfigured = true;

  try {
    if (typeof grpc.FetchReadableStreamTransport === "function") {
      grpc.setDefaultTransport(grpc.FetchReadableStreamTransport({}));
      return;
    }
  } catch (error) {
    console.warn("AvailClient: failed to configure fetch transport", error);
  }

  try {
    if (typeof grpc.CrossBrowserHttpTransport === "function") {
      grpc.setDefaultTransport(
        grpc.CrossBrowserHttpTransport({ withCredentials: false })
      );
    }
  } catch (error) {
    console.warn("AvailClient: failed to configure cross-browser transport", error);
  }
};
