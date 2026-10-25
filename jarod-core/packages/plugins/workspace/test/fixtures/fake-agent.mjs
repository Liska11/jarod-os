// Faux agent pour les tests : lit le prompt sur l'entrée standard et rend le flux JSON attendu selon le mode (argv[2]).
const mode = process.argv[2];
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (prompt += chunk));
process.stdin.on("end", () => {
  const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
  const reply = `reçu: ${prompt.trim()}`;
  if (mode === "claude-ok") {
    out({ type: "system", subtype: "init" });
    out({ type: "assistant", message: { content: [{ type: "text", text: "je regarde" }, { type: "tool_use", name: "Edit" }] } });
    out({ type: "result", subtype: "success", is_error: false, result: reply, total_cost_usd: 0.0123 });
  } else if (mode === "codex-ok") {
    out({ type: "item.completed", item: { id: "1", type: "reasoning", text: "réflexion" } });
    out({ type: "item.completed", item: { id: "2", type: "agent_message", text: reply } });
    out({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } });
  } else if (mode === "codex-fail") {
    out({ type: "turn.failed", error: { message: "quota atteint" } });
    process.exitCode = 1;
  } else if (mode === "exit2") {
    process.stderr.write("boom\n");
    process.exitCode = 2;
  } else if (mode === "hang") {
    setTimeout(() => {}, 60_000);
  }
});

// Mode « env » : dit ce que l'agent a reçu comme environnement (présence seulement, jamais les valeurs).
if (process.argv[2] === "env") {
  process.stdin.resume();
  process.stdin.on("end", () => {
    const seen = {
      gatewayToken: process.env.JAROD_GATEWAY_TOKEN !== undefined,
      controlToken: process.env.JAROD_OS_CONTROL_TOKEN !== undefined,
      providerKey: process.env.ANTHROPIC_API_KEY !== undefined,
      path: (process.env.PATH ?? process.env.Path ?? "") !== "",
    };
    process.stdout.write(`${JSON.stringify({ type: "result", is_error: false, result: JSON.stringify(seen) })}\n`);
  });
}
