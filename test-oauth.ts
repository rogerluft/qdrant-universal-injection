/**
 * test-oauth.ts — Teste: Anthropic Messages API com OAuth token
 *
 * Usa Authorization: Bearer + anthropic-beta headers
 * conforme ensinado pelo Roginho.
 *
 * npx tsx test-oauth.ts
 */

async function main() {
  const token = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
  if (!token) {
    console.error("CLAUDE_CODE_OAUTH_TOKEN não encontrado no env");
    process.exit(1);
  }

  console.log(`Token: ${token.slice(0, 20)}...`);
  console.log("Chamando api.anthropic.com com Bearer OAuth...\n");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
      "user-agent": "claude-cli/2.1.2 (external, cli)",
      "x-app": "cli",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 100,
      system: [{ type: "text", text: "Responda em uma frase curta em português." }],
      messages: [{ role: "user", content: "Quem é você?" }],
    }),
  });

  const data = await response.json() as {
    model?: string;
    stop_reason?: string;
    usage?: { input_tokens: number; output_tokens: number };
    content?: Array<{ type: string; text: string }>;
    error?: { type: string; message: string };
  };

  if (!response.ok) {
    console.error(`HTTP ${response.status}`);
    console.error("Erro:", data.error?.message ?? JSON.stringify(data));
    process.exit(1);
  }

  console.log("Status: OK");
  console.log(`Model: ${data.model}`);
  console.log(`Stop reason: ${data.stop_reason}`);
  console.log(`Tokens: ${data.usage?.input_tokens} in / ${data.usage?.output_tokens} out`);

  const text = data.content?.[0];
  if (text?.type === "text") {
    console.log(`\nResposta: ${text.text}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
