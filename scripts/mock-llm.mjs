// Fake OpenAI-compatible chat endpoint for testing Volt's AI chat end-to-end.
// Serves GET /v1/models and POST /v1/chat/completions with a streaming SSE reply.
// Usage: node scripts/mock-llm.mjs
// Then in Volt settings: provider Custom, base URL http://127.0.0.1:8787/v1, model mock-1
import { createServer } from "node:http";

const port = Number(process.argv[2]) || 8787;

const MODELS = ["mock-1", "mock-2", "mock-3"];

function streamTokens(res, tokens, done) {
  let i = 0;
  const next = () => {
    if (i >= tokens.length) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      done && done();
      return;
    }
    const t = tokens[i++];
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
    setTimeout(next, 18);
  };
  next();
}

createServer((req, res) => {
  const url = new URL(req.url, "http://x");

  // CORS for file:// / localhost previews
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: MODELS.map((id) => ({ id, object: "model" })) }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch (e) { /* ignore */ }
      const question = parsed.messages?.at(-1)?.content || "";
      const wantStream = parsed.stream !== false;

      const tokens = [
        "**Here's what I found in the document.**\n\n",
        "The text argues that the best software is a *quiet engine* — a tool that ",
        "disappears into the user's work instead of demanding attention. ",
        "It rests on three principles:\n\n",
        "1. **Respect for attention** — every dialog box and banner is a withdrawal from the user. [p.1]\n",
        "2. **Locality** — data should live where the user does; local processing means privacy and predictability. [p.1]\n",
        "3. **Composability** — expose simple stable interfaces and get out of the way. [p.1]\n\n",
        "Maintenance is where quiet engines are made or unmade: teams must prune features, delete unused code, and say no. [p.2] ",
        "You asked: " + question.slice(0, 200) + "\n",
        "_(This is a mock reply from the local test server — connect Ollama or a real API in ⚙ settings.)_",
      ];

      if (wantStream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        streamTokens(res, tokens);
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: tokens.join("") } }] }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
}).listen(port, () => {
  console.log(`Mock LLM → http://127.0.0.1:${port}/v1  (models: ${MODELS.join(", ")})`);
});
