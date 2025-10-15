import { base } from "viem/chains";
import { Contracts } from "./pyth/addresses";
import { PythClient } from "./pyth/client";
import { logger } from "./utils/logger";

const pyth = PythClient.create({
  chain: base,
  contractAddress: Contracts.EvmPriceFeedContracts.base.address,
  rpcUrl: "https://mainnet.base.org",
  pythNetwork: "pythnet",
});

try {
  const price = await pyth.getPrice({
    symbol: "Crypto.ETH_USD",
    maxStaleness: 60 * 300,
  });

  logger.info(
    {
      symbol: price.symbol,
      price: price.value,
      confidence: price.confidenceValue,
      exponent: price.exponent,
      publishTime: price.publishedAt.toISOString(),
      priceId: price.priceId,
    },
    "Fetched ETH/USD price"
  );
} catch (error) {
  if (error instanceof PythClient.StalePriceError) {
    logger.warn(
      { symbol: "Crypto.ETH_USD", maxStaleness: 60 },
      "ETH/USD price is older than the requested staleness window"
    );
  } else {
    logger.error({ err: error }, "Failed to fetch price");
  }
}

try {
  const twap = await pyth.getTwap({
    symbol: "Crypto.ETH_USD",
    windowSeconds: 300,
  });

  logger.info(
    {
      symbol: twap.symbol,
      price: twap.value,
      confidence: twap.confidenceValue,
      startTime: new Date(twap.startTime * 1000).toISOString(),
      endTime: new Date(twap.endTime * 1000).toISOString(),
      windowSeconds: twap.windowSeconds,
    },
    "Fetched ETH/USD TWAP"
  );
} catch (error) {
  logger.error({ err: error }, "Failed to fetch TWAP");
}

try {
  logger.info("Streaming price updates for ETH/USD, US_AMD, ADA...");
  const stream = await pyth.streamPriceUpdates({
    symbols: [
      "Crypto.ETH_USD",
      "Crypto.ADA_USD",
      "Crypto.AERO_USD",
      // "Equity.US_AMD_USD",
      // "FX.USD_HKD",
    ],
    onUpdate: (update) => {
      logger.info({
        symbol: update.symbol,
        price: update.value,
        // confidence: update.confidenceValue,
        // publishTime: timestamp,
      });
    },
    onError: (error) => {
      logger.error({ err: error }, "Stream error");
    },
  });

  logger.info("Press Ctrl+C to stop streaming.");
  process.on("SIGINT", () => {
    logger.info("Closing price stream...");
    stream.close();
    process.exit(0);
  });
} catch (error) {
  logger.error({ err: error }, "Failed to start streaming price updates");
}
