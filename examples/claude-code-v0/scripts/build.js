const { spawnSync } = require("node:child_process");

function hasBun() {
  const result = spawnSync("bun", ["--version"], { stdio: "ignore" });
  if (result.error && result.error.code === "ENOENT") return false;
  return result.status === 0;
}

function main() {
  if (!hasBun()) {
    console.warn(
      "[claude-code-v0] 未检测到 bun，已跳过 build（不影响其它 workspace 包构建）。"
    );
    console.warn(
      "[claude-code-v0] 如需构建该示例，请先安装 bun：https://bun.sh/ ，然后在 examples/claude-code-v0 下运行 `pnpm build`。"
    );
    process.exit(0);
  }

  const result = spawnSync(
    "bun",
    ["build", "./client/index.tsx", "--outdir=./dist"],
    { stdio: "inherit" }
  );

  process.exit(result.status ?? 1);
}

main();
