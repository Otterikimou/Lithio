import { createPublicClient, http, parseAbi, type PublicClient } from "viem";
import type { Chain } from "viem/chains";

import { pythnet, pythtest } from "./pricefeed";
import {
  flattenCatalog,
  invertCatalog,
  ensureHexId,
  resolveSymbolForPriceId as resolveSymbolFromCatalog,
  coerceBigInt,
  coerceInteger,
  requireBigInt,
  extractPriceIdFromTwapEntry,
  type HermesTwapEntry,
  type HermesTwapResponse,
  type ReadonlyFlattenedFeeds,
} from "./utils";

const PYTH_ABI = parseAbi([
  "function getPriceNoOlderThan(bytes32 id, uint256 age) view returns ((int64 price, uint64 conf, int32 expo, uint256 publishTime) price)",
  "function getPriceUnsafe(bytes32 id) view returns ((int64 price, uint64 conf, int32 expo, uint256 publishTime) price)",
  "function getEmaPriceNoOlderThan(bytes32 id, uint256 age) view returns ((int64 price, uint64 conf, int32 expo, uint256 publishTime) price)",
  "function getEmaPriceUnsafe(bytes32 id) view returns ((int64 price, uint64 conf, int32 expo, uint256 publishTime) price)",
  "error StalePrice()",
] as const);

const FEED_CATALOGS = {
  pythnet,
  pythtest,
} as const;

export type PythNetwork = keyof typeof FEED_CATALOGS;

type FeedCatalog = typeof pythnet;

type CatalogSymbolPaths<T> = {
  [K in keyof T]: T[K] extends Record<string, unknown>
    ? `${Extract<K, string>}.${Extract<keyof T[K], string>}`
    : never;
}[keyof T];

type NetworkSymbolMap = {
  pythnet: CatalogSymbolPaths<typeof pythnet>;
  pythtest: CatalogSymbolPaths<typeof pythtest>;
};

export type PythSymbol = NetworkSymbolMap[keyof NetworkSymbolMap];

const DEFAULT_HERMES_ENDPOINTS: Record<PythNetwork, string> = {
  pythnet: "https://hermes.pyth.network",
  pythtest: "https://hermes-beta.pyth.network",
};

interface BasePriceParams {
  /**
   * Override the configured Pyth network (pythnet / pythtest) for this call.
   */
  pythNetwork?: PythNetwork;
}

interface SymbolSelector extends BasePriceParams {
  symbol: PythSymbol;
  priceId?: never;
}

interface PriceIdSelector extends BasePriceParams {
  priceId: `0x${string}`;
  symbol?: never;
}

type PriceSelector = SymbolSelector | PriceIdSelector;

type StaleAwarePriceParams = PriceSelector & {
  /**
   * Maximum age (in seconds) the on-chain price is allowed to be.
   */
  maxStaleness: number;
};

type StreamSymbolSelector = {
  symbols: ReadonlyArray<PythSymbol>;
  priceIds?: never;
};

type StreamPriceIdSelector = {
  priceIds: ReadonlyArray<`0x${string}`>;
  symbols?: never;
};

type StreamSelector = StreamSymbolSelector | StreamPriceIdSelector;

export type StreamPriceUpdatesParams = StreamSelector &
  BasePriceParams & {
    allowUnordered?: boolean;
    benchmarksOnly?: boolean;
    ignoreInvalidPriceIds?: boolean;
    onUpdate: (update: PythPrice) => void;
    onError?: (error: unknown) => void;
  };

export interface PriceStream {
  source: unknown;
  close(): void;
}

export interface PythPrice {
  priceId: `0x${string}`;
  symbol?: PythSymbol;
  price: bigint;
  confidence: bigint;
  exponent: number;
  publishTime: bigint;
  publishedAt: Date;
  value: number;
  confidenceValue: number;
}

type TwapParams = PriceSelector &
  BasePriceParams & {
    windowSeconds: number;
    hermesEndpoint?: string;
  };

export interface PythTwap {
  priceId: `0x${string}`;
  symbol?: PythSymbol;
  price: bigint;
  confidence: bigint;
  exponent: number;
  publishTime: number;
  startTime: number;
  endTime: number;
  windowSeconds: number;
  value: number;
  confidenceValue: number;
  downSlotsRatio?: number;
}

export interface PythClientConfig {
  /**
   * Viem chain configuration for the target network.
   */
  chain: Chain;
  /**
   * RPC URL to use when creating the public client. Defaults to the chain's
   * primary HTTP URL.
   */
  rpcUrl?: string;
  /**
   * Address of the on-chain Pyth price feed contract.
   */
  contractAddress: `0x${string}`;
  /**
   * Default Pyth network catalog (pythnet or pythtest) to resolve symbols.
   */
  pythNetwork: PythNetwork;
  /**
   * Optional overrides for Hermes endpoints used for streaming price data.
   */
  hermesEndpoints?: Partial<Record<PythNetwork, string>>;
}

const FLATTENED_FEEDS: Record<PythNetwork, ReadonlyFlattenedFeeds> = {
  pythnet: flattenCatalog(pythnet),
  pythtest: flattenCatalog(pythtest),
};

type ContractPriceResult = {
  price: bigint;
  conf: bigint;
  expo: bigint | number;
  publishTime: bigint;
};
const INVERTED_FEEDS: Record<PythNetwork, Record<string, string>> = {
  pythnet: invertCatalog(FLATTENED_FEEDS.pythnet),
  pythtest: invertCatalog(FLATTENED_FEEDS.pythtest),
};

export class PythClient {
  static readonly StalePriceError = class StalePriceError extends Error {
    constructor(message = "Pyth price is older than the requested threshold.") {
      super(message);
      this.name = "StalePriceError";
    }
  };

  static create(config: PythClientConfig) {
    return new PythClient(config);
  }

  private readonly client: PublicClient;
  private readonly contractAddress: `0x${string}`;
  private readonly defaultNetwork: PythNetwork;
  private readonly hermesEndpoints: Record<PythNetwork, string>;

  private constructor({
    chain,
    rpcUrl,
    contractAddress,
    pythNetwork,
    hermesEndpoints,
  }: PythClientConfig) {
    this.client = createPublicClient({
      chain,
      transport: http(rpcUrl ?? chain.rpcUrls.default.http[0]),
    });

    this.contractAddress = contractAddress;
    this.defaultNetwork = pythNetwork;
    this.hermesEndpoints = {
      ...DEFAULT_HERMES_ENDPOINTS,
      ...(hermesEndpoints ?? {}),
    };
  }

  async getPrice(params: StaleAwarePriceParams): Promise<PythPrice> {
    const network = params.pythNetwork ?? this.defaultNetwork;
    const priceId = this.resolvePriceId({ ...params, pythNetwork: network });
    const maxStaleness = BigInt(params.maxStaleness);

    try {
      const result = await this.client.readContract({
        address: this.contractAddress,
        abi: PYTH_ABI,
        functionName: "getPriceNoOlderThan",
        args: [priceId, maxStaleness],
      });

      return this.normalizePrice(
        priceId,
        result as ContractPriceResult,
        network
      );
    } catch (error) {
      if ((error as { errorName?: string }).errorName === "StalePrice") {
        throw new PythClient.StalePriceError();
      }
      throw error;
    }
  }

  async getPriceUnsafe(params: PriceSelector): Promise<PythPrice> {
    const network = params.pythNetwork ?? this.defaultNetwork;
    const priceId = this.resolvePriceId({ ...params, pythNetwork: network });
    const result = await this.client.readContract({
      address: this.contractAddress,
      abi: PYTH_ABI,
      functionName: "getPriceUnsafe",
      args: [priceId],
    });

    return this.normalizePrice(priceId, result as ContractPriceResult, network);
  }

  async getEmaPrice(params: StaleAwarePriceParams): Promise<PythPrice> {
    const network = params.pythNetwork ?? this.defaultNetwork;
    const priceId = this.resolvePriceId({ ...params, pythNetwork: network });
    const maxStaleness = BigInt(params.maxStaleness);

    try {
      const result = await this.client.readContract({
        address: this.contractAddress,
        abi: PYTH_ABI,
        functionName: "getEmaPriceNoOlderThan",
        args: [priceId, maxStaleness],
      });

      return this.normalizePrice(
        priceId,
        result as ContractPriceResult,
        network
      );
    } catch (error) {
      if ((error as { errorName?: string }).errorName === "StalePrice") {
        throw new PythClient.StalePriceError();
      }
      throw error;
    }
  }

  async getEmaPriceUnsafe(params: PriceSelector): Promise<PythPrice> {
    const network = params.pythNetwork ?? this.defaultNetwork;
    const priceId = this.resolvePriceId({ ...params, pythNetwork: network });
    const result = await this.client.readContract({
      address: this.contractAddress,
      abi: PYTH_ABI,
      functionName: "getEmaPriceUnsafe",
      args: [priceId],
    });

    return this.normalizePrice(priceId, result as ContractPriceResult, network);
  }

  async streamPriceUpdates(
    params: StreamPriceUpdatesParams
  ): Promise<PriceStream> {
    const network = params.pythNetwork ?? this.defaultNetwork;
    const endpoint = this.hermesEndpoints[network];

    if (!endpoint) {
      throw new Error(`No Hermes endpoint configured for "${network}".`);
    }

    const ids = this.resolveStreamPriceIds(params, network);

    if (ids.length === 0) {
      throw new Error("Provide at least one symbol or priceId to stream.");
    }

    const url = new URL("/v2/updates/price/stream", endpoint);
    ids.forEach((id) => url.searchParams.append("ids[]", id));
    url.searchParams.set("parsed", "true");

    if (params.allowUnordered) {
      url.searchParams.set("allow_unordered", "true");
    }

    if (params.benchmarksOnly) {
      url.searchParams.set("benchmarks_only", "true");
    }

    if (params.ignoreInvalidPriceIds) {
      url.searchParams.set("ignore_invalid_price_ids", "true");
    }

    let EventSourceCtor: any = (globalThis as any).EventSource;

    if (!EventSourceCtor) {

      // @ts-ignore
      const polyfill = await import("eventsource");
      EventSourceCtor =
        (polyfill as { EventSource?: unknown }).EventSource ??
        (polyfill as { default?: unknown }).default;
    }

    if (!EventSourceCtor) {
      throw new Error(
        "EventSource is not available in this environment. Provide a polyfill (e.g. 'eventsource') and assign it to globalThis.EventSource."
      );
    }

    const source: any = new EventSourceCtor(url.toString());

    source.onmessage = (event: { data?: string }) => {
      if (!event?.data) {
        return;
      }

      const updates = this.parseHermesStreamPayload(event.data, network);

      for (const update of updates) {
        params.onUpdate(update);
      }
    };

    source.onerror = (error: unknown) => {
      params.onError?.(error);
    };

    return {
      source,
      close: () => {
        if (typeof source.close === "function") {
          source.close();
        }
      },
    };
  }

  async getTwap(params: TwapParams): Promise<PythTwap> {
    const network = params.pythNetwork ?? this.defaultNetwork;
    const windowSeconds = Math.trunc(params.windowSeconds);

    if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
      throw new Error("windowSeconds must be a positive integer.");
    }

    const priceId = this.resolvePriceId({
      ...params,
      pythNetwork: network,
    });

    const endpoint =
      params.hermesEndpoint ?? this.hermesEndpoints[network] ?? "";

    if (!endpoint) {
      throw new Error(`No Hermes endpoint configured for "${network}".`);
    }

    const url = new URL(`/v2/updates/twap/${windowSeconds}/latest`, endpoint);
    url.searchParams.append("ids[]", priceId.slice(2));
    url.searchParams.set("parsed", "true");

    const response = await fetch(url.toString(), {
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(
        `Hermes TWAP request failed with status ${response.status} ${response.statusText}`
      );
    }

    const body = (await response.json()) as HermesTwapResponse;
    const parsed = Array.isArray(body.parsed) ? body.parsed : [];

    if (parsed.length === 0) {
      throw new Error("Hermes TWAP response did not contain any entries.");
    }

    const entry = this.findTwapEntry(parsed, priceId);
    if (!entry) {
      throw new Error("Hermes TWAP response missing requested price ID.");
    }

    const twapNode = entry.twap ?? entry.twap_price ?? entry.twapPrice;
    if (!twapNode) {
      throw new Error("Hermes TWAP entry missing twap price payload.");
    }

    const exponent =
      coerceInteger(
        { value: twapNode.expo ?? twapNode.exponent },
        ["value"]
      ) ?? undefined;

    if (exponent === undefined) {
      throw new Error("Hermes TWAP entry missing exponent.");
    }

    const priceBigInt = requireBigInt(
      twapNode.price ?? twapNode.value,
      "Hermes TWAP price"
    );
    const confidenceBigInt = requireBigInt(
      twapNode.conf ?? twapNode.confidence,
      "Hermes TWAP confidence"
    );

    const publishTime =
      coerceInteger(
        {
          value:
            twapNode.publish_time ??
            twapNode.publishTime ??
            entry.end_time ??
            entry.endTime ??
            entry.end_timestamp ??
            entry.endTimestamp,
        },
        ["value"]
      ) ?? undefined;

    if (publishTime === undefined) {
      throw new Error("Hermes TWAP entry missing publish time.");
    }

    const startTime =
      coerceInteger(
        {
          value:
            entry.start_time ??
            entry.startTime ??
            entry.start_timestamp ??
            entry.startTimestamp,
        },
        ["value"]
      ) ?? publishTime - windowSeconds;
    const endTime =
      coerceInteger(
        {
          value:
            entry.end_time ??
            entry.endTime ??
            entry.end_timestamp ??
            entry.endTimestamp,
        },
        ["value"]
      ) ?? publishTime;

    const scale = 10 ** exponent;
    const downSlotsRatio =
      coerceInteger(
        { value: entry.down_slots_ratio ?? entry.downSlotsRatio },
        ["value"]
      ) ?? undefined;

    return {
      priceId,
      symbol: resolveSymbolFromCatalog(
        priceId,
        INVERTED_FEEDS[network]
      ) as PythSymbol | undefined,
      exponent,
      price: priceBigInt,
      confidence: confidenceBigInt,
      publishTime,
      startTime,
      endTime,
      windowSeconds,
      value: Number(priceBigInt) * scale,
      confidenceValue: Number(confidenceBigInt) * scale,
      downSlotsRatio:
        downSlotsRatio !== undefined ? downSlotsRatio / 1_000_000 : undefined,
    };
  }

  /**
   * Finds the TWAP entry whose price id matches the requested feed.
   * Falls back to the first entry exposing a price id if none match exactly.
   */
  private findTwapEntry(
    entries: HermesTwapEntry[],
    priceId: `0x${string}`
  ): HermesTwapEntry | undefined {
    const normalizedTarget = ensureHexId(priceId).toLowerCase();

    for (const entry of entries) {
      const candidate = extractPriceIdFromTwapEntry(entry);
      if (candidate) {
        const normalizedCandidate = ensureHexId(candidate).toLowerCase();
        if (normalizedCandidate === normalizedTarget) {
          return entry;
        }
      }
    }

    return entries.find((entry) => extractPriceIdFromTwapEntry(entry)) ?? entries[0];
  }

  /**
   * Converts user friendly symbol selections (or explicit price IDs) into the
   * canonical list of feed ids used for streaming.
   */
  private resolveStreamPriceIds(
    { priceIds, symbols, pythNetwork }: StreamSelector & BasePriceParams,
    network: PythNetwork
  ): `0x${string}`[] {
    if (priceIds && priceIds.length > 0) {
      return priceIds as `0x${string}`[];
    }

    if (!symbols || symbols.length === 0) {
      return [];
    }

    const targetNetwork = pythNetwork ?? network;
    const catalog = FLATTENED_FEEDS[targetNetwork];

    return symbols.map((symbol) => {
      const resolved = catalog[symbol];
      if (!resolved) {
        throw new Error(
          `Symbol "${symbol}" not found in ${targetNetwork} feed catalog.`
        );
      }
      return resolved;
    });
  }

  /**
   * Parses a raw SSE payload emitted by Hermes into structured price updates.
   */
  private parseHermesStreamPayload(
    data: string,
    network: PythNetwork
  ): PythPrice[] {
    try {
      const payload = JSON.parse(data) as unknown;
      return this.extractPriceUpdates(payload, network);
    } catch {
      return [];
    }
  }

  /**
   * Navigates the possible shapes of Hermes payloads to collect price updates.
   */
  private extractPriceUpdates(
    payload: unknown,
    network: PythNetwork
  ): PythPrice[] {
    const results: PythPrice[] = [];
    const candidateArrays: unknown[] = [];

    if (Array.isArray(payload)) {
      candidateArrays.push(payload);
    } else if (payload && typeof payload === "object") {
      const objectPayload = payload as Record<string, unknown>;

      const parsed = objectPayload.parsed;
      if (Array.isArray(parsed)) {
        candidateArrays.push(parsed);
      }

      const priceUpdate = objectPayload.price_update ?? objectPayload.priceUpdate;
      if (Array.isArray(priceUpdate)) {
        candidateArrays.push(priceUpdate);
      } else if (
        priceUpdate &&
        typeof priceUpdate === "object" &&
        Array.isArray((priceUpdate as Record<string, unknown>).parsed)
      ) {
        candidateArrays.push(
          (priceUpdate as Record<string, unknown>).parsed as unknown[]
        );
      }
    }

    for (const array of candidateArrays) {
      if (!Array.isArray(array)) continue;
      for (const entry of array) {
        const converted = this.convertParsedEntry(entry, network);
        if (converted) {
          results.push(converted);
        }
      }
    }

    if (results.length === 0) {
      const fallback = this.convertParsedEntry(payload, network);
      if (fallback) {
        results.push(fallback);
      }
    }

    return results;
  }

  /**
   * Converts a single parsed Hermes entry into a strongly typed price object.
   */
  private convertParsedEntry(
    entry: unknown,
    network: PythNetwork
  ): PythPrice | undefined {
    if (!entry || typeof entry !== "object") {
      return undefined;
    }

    const record = entry as Record<string, unknown>;
    const idValue =
      typeof record.id === "string"
        ? record.id
        : typeof record.price_id === "string"
        ? record.price_id
        : typeof record.priceId === "string"
        ? record.priceId
        : undefined;

    if (!idValue) {
      return undefined;
    }

    const priceNode =
      record.price && typeof record.price === "object"
        ? (record.price as Record<string, unknown>)
        : undefined;

    if (!priceNode) {
      return undefined;
    }

    const price = coerceBigInt(priceNode, ["price", "value", "price_value"]);
    const confidence = coerceBigInt(priceNode, [
      "conf",
      "confidence",
      "confidence_interval",
      "confidenceInterval",
    ]);
    const exponent = coerceInteger(priceNode, ["expo", "exponent"]);
    const publishTime = coerceBigInt(priceNode, [
      "publish_time",
      "publishTime",
      "publish_timestamp",
      "publishTimestamp",
    ]);

    if (
      price === undefined ||
      confidence === undefined ||
      exponent === undefined ||
      publishTime === undefined
    ) {
      return undefined;
    }

    return this.normalizePrice(
      ensureHexId(idValue),
      {
        price,
        conf: confidence,
        expo: exponent,
        publishTime,
      },
      network
    );
  }






  /**
   * Resolves the canonical feed id given either a symbol or explicit id.
   */
  private resolvePriceId({
    priceId,
    symbol,
    pythNetwork,
  }: PriceSelector): `0x${string}` {
    if (priceId) {
      return ensureHexId(priceId);
    }

    if (!symbol) {
      throw new Error("Either priceId or symbol must be provided.");
    }

    const network = pythNetwork ?? this.defaultNetwork;
    const catalog = FLATTENED_FEEDS[network];
    const resolved = catalog[symbol];

    if (!resolved) {
      throw new Error(
        `Symbol "${symbol}" not found in ${network} feed catalog.`
      );
    }

    return resolved;
  }

  /**
   * Normalises raw contract responses into a strongly typed price structure.
   */
  private normalizePrice(
    priceId: `0x${string}`,
    { price, conf, expo, publishTime }: ContractPriceResult,
    network: PythNetwork
  ): PythPrice {
    const exponent = Number(expo);
    const scale = 10 ** exponent;
    const symbol = resolveSymbolFromCatalog(
      priceId,
      INVERTED_FEEDS[network]
    ) as PythSymbol | undefined;

    return {
      priceId,
      symbol,
      price,
      confidence: conf,
      exponent,
      publishTime,
      publishedAt: new Date(Number(publishTime) * 1000),
      value: Number(price) * scale,
      confidenceValue: Number(conf) * scale,
    };
  }
}
