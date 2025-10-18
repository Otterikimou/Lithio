import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Centralized configuration for script data sources and output locations.
 *
 * Update these paths or URLs to point scripts at different sources. All paths
 * are resolved relative to the repository root unless otherwise noted.
 */
const ROOT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".."
);

export const DATA_SOURCES = {
  hermes: {
    pythnet: "https://hermes.pyth.network",
    pythtest: "https://hermes-beta.pyth.network",
  },
  contractManager: {
    /**
     * Source: clone https://github.com/pyth-network/pyth-crosschain/tree/main/contract_manager
     * into the local repository and keep the store snapshots in sync.
     */
    store: path.join(
      ROOT_DIR,
      "resources/pyth-crosschain/contract_manager/store"
    ),
  },
} as const;

export const OUTPUT_PATHS = {
  pricefeed: {
    generatorSource: "src/pyth/scripts/00-pricefeed.ts",
    directory: path.join(ROOT_DIR, "src/pyth/generated"),
    entrypoint: path.join(ROOT_DIR, "src/pyth/pricefeed.ts"),
  },
  addresses: {
    generatorSource: "src/pyth/scripts/01-addresses.ts",
    directory: path.join(ROOT_DIR, "src/pyth/generated/addresses"),
    entrypoint: path.join(ROOT_DIR, "src/pyth/addresses.ts"),
  },
} as const;

export type HermesNetwork = keyof typeof DATA_SOURCES.hermes;
