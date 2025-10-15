import { createWalletClient, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, optimism } from "viem/chains";
import {
  AvailClient,
  BASE_USDC,
  OPTIMISM_USDC,
  getTokenAddress,
  type SwapExactInInput,
} from "./avail";

async function main() {
  const privateKey = process.env.PRIVATE_KEY as `0x${string}` | undefined;

  if (!privateKey) {
    console.error(
      "Set a PRIVATE_KEY environment variable to run the Avail swap example."
    );
    console.error(
      "The script is still useful as a reference implementation even without execution."
    );
    return;
  }

  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http("https://mainnet.base.org"),
  });

  const client = await AvailClient.create({
    network: "mainnet",
    signerOrProvider: walletClient,
    hooks: {
      onIntent: ({ intent, allow }) => {
        console.log("Intent preview:");
        console.dir(intent, { depth: null });
        allow();
      },
      onAllowance: ({ sources, allow }) => {
        if (sources.length > 0) {
          console.log("Allowances required:");
          console.dir(sources, { depth: null });
        }
        allow(["min"]);
      },
    },
  });

  const swapInput: SwapExactInInput = {
    fromChainId: base.id,
    fromToken: getTokenAddress("USDC", "BASE"),
    amount: parseUnits("100", 6), // 100 USDC on Base
    toChainId: optimism.id,
    toToken: getTokenAddress("USDC", "OPTIMISM"),
  };

  const intent = await client.simulateSwapExactIn(swapInput);
  console.log("Simulated intent:");
  console.dir(intent, { depth: null });

  const unsubscribe = client.on("swap_step", (step) =>
    console.log("swap step:", step)
  );

  const result = await client.swapExactIn(swapInput);

  unsubscribe();

  if (result.success) {
    console.log("Swap completed:", result.result);
  } else {
    console.error("Swap failed:", result.error);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("Avail swap example failed:", error);
    process.exitCode = 1;
  });
}
