# Script Configuration

All generator scripts under this directory read their data sources and output
targets from `config.ts`. Update that file to change where the scripts read
from or write to.

## Data Sources

- **Hermes endpoints**  
  `DATA_SOURCES.hermes` lists the base URLs for `pythnet` and `pythtest`. Use
  these when you want the price feed scripts to pull from a different Hermes
  deployment or a mirrored endpoint.

- **Contract manager store**  
  `DATA_SOURCES.contractManager.store` points at the JSON snapshots shipped in
  `resources/pyth-crosschain/contract_manager/store`. Replace it with another
  directory if you have a different source of contract metadata.

## Outputs

- **Price feed generation**  
  `OUTPUT_PATHS.pricefeed` controls where `00-pricefeed.ts` writes the generated
  feed catalogs (`src/pyth/generated`) and the top-level barrel file
  (`src/pyth/pricefeed.ts`).

- **Address generation**  
  `OUTPUT_PATHS.addresses` controls the output directory for contract/vault
  maps (`src/pyth/generated/addresses`) and the barrel file
  (`src/pyth/addresses.ts`).

Each block also carries a `generatorSource` field used for the headers the
scripts embed in generated files.

## Updating Configuration

1. Edit `config.ts` to point at the desired source URLs or local directories.
2. Re-run `bun run ./src/pyth` (or `bun run gen`) to regenerate the outputs with
   the new configuration.
3. Inspect the generated files under `src/pyth/generated` to confirm the changes
   were applied.
