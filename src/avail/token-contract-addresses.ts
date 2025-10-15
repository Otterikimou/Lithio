import type { Hex } from "viem";

import {
  SUPPORTED_CHAINS,
  TOKEN_CONTRACT_ADDRESSES,
  TOKEN_SYMBOLS,
  type ChainKey,
  type TokenSymbol,
} from "./generated/token-contract-addresses.generated";

type TokenChainKey<T extends TokenSymbol> =
  keyof (typeof TOKEN_CONTRACT_ADDRESSES)[T] & ChainKey;
type TokenAddress<
  T extends TokenSymbol,
  C extends TokenChainKey<T>
> = (typeof TOKEN_CONTRACT_ADDRESSES)[T][C];

export {
  SUPPORTED_CHAINS,
  TOKEN_CONTRACT_ADDRESSES,
  TOKEN_SYMBOLS,
  type ChainKey,
  type TokenSymbol,
  type TokenChainKey,
};

export const getTokenAddress = <
  T extends TokenSymbol,
  C extends TokenChainKey<T>
>(
  token: T,
  chain: C
): TokenAddress<T, C> => {
  const tokenAddresses = TOKEN_CONTRACT_ADDRESSES[token];
  const address = tokenAddresses[chain];

  if (!address) {
    throw new Error(
      `Token ${String(token)} is not registered on chain ${chain}.`
    );
  }

  return address;
};

export const BASE_USDC: Hex = getTokenAddress("USDC", "BASE");
export const OPTIMISM_USDC: Hex = getTokenAddress("USDC", "OPTIMISM");
