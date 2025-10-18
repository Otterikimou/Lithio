export type HermesTwapNode = {
  price?: string | number | bigint;
  value?: string | number | bigint;
  conf?: string | number | bigint;
  confidence?: string | number | bigint;
  expo?: number | string | bigint;
  exponent?: number | string | bigint;
  publish_time?: number | string;
  publishTime?: number | string;
  price_id?: string;
  priceId?: string;
};

export type HermesTwapEntry = {
  id?: string;
  price_id?: string;
  priceId?: string;
  twap_price?: HermesTwapNode;
  twapPrice?: HermesTwapNode;
  twap?: HermesTwapNode & {
    publish_time?: number | string;
    publishTime?: number | string;
  };
  start_time?: number | string;
  startTime?: number | string;
  start_timestamp?: number | string;
  startTimestamp?: number | string;
  end_time?: number | string;
  endTime?: number | string;
  end_timestamp?: number | string;
  endTimestamp?: number | string;
  down_slots_ratio?: number | string;
  downSlotsRatio?: number | string;
};

export type HermesTwapResponse = {
  parsed?: HermesTwapEntry[];
};

export type ReadonlyFlattenedFeeds = Readonly<Record<string, `0x${string}`>>;


/**
 * Flattens the generated catalog (grouped by category) into a simple
 * `symbol -> priceId` record for quick lookups.
 */
export const flattenCatalog = <T extends Record<string, unknown>>(
  catalog: T
): ReadonlyFlattenedFeeds => {
  const flattened: Record<string, `0x${string}`> = {};

  for (const [groupName, entries] of Object.entries(catalog)) {
    if (typeof entries !== "object" || entries === null) continue;

    for (const [symbol, id] of Object.entries(entries as Record<string, unknown>)) {
      if (typeof id !== "string") continue;
      flattened[`${groupName}.${symbol}`] = id as `0x${string}`;
    }
  }

  return flattened as Readonly<Record<string, `0x${string}`>>;
};

/**
 * Produces a reverse mapping of `priceId -> symbol` for logging and metadata.
 */
export const invertCatalog = (
  catalog: ReadonlyFlattenedFeeds
 ): Record<string, string> => {
  const inverted: Record<string, string> = {};
  for (const [symbol, id] of Object.entries(catalog)) {
    inverted[id.toLowerCase()] = symbol;
  }
  return inverted;
};

/**
 * Normalises an id into a lower-case hex string with 0x prefix.
 */
export const ensureHexId = (id: string): `0x${string}` => {
  const normalized = id.startsWith("0x") ? id : `0x${id}`;
  return normalized.toLowerCase() as `0x${string}`;
};

/**
 * Looks up a symbol by price id using the inverted catalog map.
 */
export const resolveSymbolForPriceId = (
  priceId: `0x${string}`,
  inverted: Record<string, string>
 ): string | undefined => {
  return inverted[priceId.toLowerCase()];
};

/**
 * Attempts to coerce the first non-empty value for the provided keys
 * into a bigint. Returns undefined if no valid representation exists.
 */
export const coerceBigInt = (
  source: Record<string, unknown>,
  keys: string[]
): bigint | undefined => {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "bigint") return value;
    if (typeof value === "number" && Number.isFinite(value)) {
      return BigInt(Math.trunc(value));
    }
    if (typeof value === "string" && value.trim().length > 0) {
      try {
        return BigInt(value);
      } catch {
        continue;
      }
    }
  }
  return undefined;
};

/**
 * Attempts to coerce the first non-empty value for the provided keys
 * into an integer (number). Returns undefined if conversion fails.
 */
export const coerceInteger = (
  source: Record<string, unknown>,
  keys: string[]
): number | undefined => {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.trunc(value);
    }
    if (typeof value === "bigint") {
      return Number(value);
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (!Number.isNaN(parsed)) {
        return Math.trunc(parsed);
      }
    }
  }
  return undefined;
};

/**
 * Same as `coerceBigInt`, but throws if conversion fails.
 */
export const requireBigInt = (value: unknown, fieldName: string): bigint => {
  const result = coerceBigInt({ value }, ["value"]);
  if (result === undefined) {
    throw new Error(`${fieldName} is not a valid integer value.`);
  }
  return result;
};

/**
 * Retrieves the price id from a TWAP entry irrespective of key naming.
 */
export const extractPriceIdFromTwapEntry = (
  entry: HermesTwapEntry
): string | undefined => {
  return (
    entry.id ??
    entry.price_id ??
    entry.priceId ??
    entry.twap_price?.price_id ??
    entry.twapPrice?.price_id
  );
};
