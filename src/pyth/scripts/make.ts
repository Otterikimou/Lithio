import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

const runScript = (scriptPath: string) =>
  new Promise<void>((resolve, reject) => {
    const proc = spawn("bun", ["run", scriptPath], {
      stdio: ["inherit", "pipe", "pipe"],
      cwd: scriptsDir,
      env: process.env,
    });

    proc.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
    });

    proc.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(`Script ${scriptPath} exited with code ${code ?? "null"}`)
        );
      }
    });

    proc.on("error", (error) => {
      reject(error);
    });
  });

const main = async () => {
  const files = await readdir(scriptsDir);

  const scriptFiles = files
    .filter(
      (file) =>
        /^\d{2}-.+\.ts$/.test(file) && path.join(scriptsDir, file) !== __filename
    )
    .sort((a, b) => a.localeCompare(b));

  if (scriptFiles.length === 0) {
    console.log(
      `No scripts found in ${scriptsDir}. Expected files named like "00-example.ts".`
    );
    return;
  }

  console.log(`Discovered ${scriptFiles.length} script(s):`);
  scriptFiles.forEach((file) => console.log(`  • ${file}`));
  console.log("");

  for (const file of scriptFiles) {
    const scriptPath = path.join(scriptsDir, file);
    const displayName = path.basename(file);
    console.log(`→ Running ${displayName}`);
    const start = Date.now();

    try {
      const relativePath = `./${path.relative(scriptsDir, scriptPath)}`;
      await runScript(relativePath);
      const elapsed = ((Date.now() - start) / 1000).toFixed(2);
      console.log(`✅ Completed ${displayName} in ${elapsed}s\n`);
    } catch (error) {
      console.error(`✗ Failed ${displayName}`);
      console.error(error instanceof Error ? error.message : error);
      throw error;
    }
  }

  console.log("All scripts completed successfully.");
};

await main();
