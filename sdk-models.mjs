import { query } from "@anthropic-ai/claude-agent-sdk";

delete process.env.CLAUDECODE;

async function testModel(label, opts) {
  console.log(`\n=== ${label} ===`);
  const q = query({
    prompt: "say ok",
    options: {
      maxTurns: 1,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      ...opts,
    }
  });

  for await (const msg of q) {
    if (msg.type === "system") {
      console.log("Active model:", msg.model);
    }
    if (msg.type === "result") {
      console.log("Status:", msg.subtype, "| Cost: $" + msg.total_cost_usd);
      if (msg.modelUsage) {
        for (const [model, usage] of Object.entries(msg.modelUsage)) {
          console.log(`  ${model}: in=${usage.inputTokens} out=${usage.outputTokens} cost=$${usage.costUSD}`);
        }
      }
      if (msg.subtype !== "success") {
        console.log("Errors:", msg.errors);
      }
      break;
    }
  }
}

try {
  await testModel("Explicit: claude-opus-4-6", { model: "claude-opus-4-6" });
  console.log("\n=== Done ===");
} catch (e) {
  console.error("\nTest failed:", e.message);
}
process.exit(0);
