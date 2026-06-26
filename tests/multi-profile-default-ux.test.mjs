import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceServer = path.join(repoRoot, "server.mjs");

let tmpDir;
let app;
let appPort;
let defaultUpstream;
let glmUpstream;
let openaiUpstream;
const upstreamHits = [];
const slowStreamCloseWaiters = [];

function waitForSlowStreamClose(timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("slow upstream stream was not closed")), timeoutMs);
    slowStreamCloseWaiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function notifySlowStreamClose() {
  const waiter = slowStreamCloseWaiters.shift();
  if (waiter) waiter();
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function makeUpstream(name, responseModel) {
  return http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      upstreamHits.push({
        upstream: name,
        path: req.url,
        authorization: req.headers.authorization,
        body: body ? JSON.parse(body) : null,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        model: responseModel,
        usage: { input_tokens: 10, output_tokens: 5 },
      }));
    });
  });
}

function makeOpenAIUpstream() {
  return http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : null;
      upstreamHits.push({
        upstream: "openai",
        path: req.url,
        authorization: req.headers.authorization,
        body: parsed,
      });

      if (parsed?.stream) {
        const firstContent = parsed.messages?.[0]?.content;
        const firstText = typeof firstContent === "string" ? firstContent : "";
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        if (firstText === "slow-stream") {
          const keepAlive = setInterval(() => {
            res.write(": keep-alive\n\n");
          }, 50);
          res.on("close", () => {
            clearInterval(keepAlive);
            notifySlowStreamClose();
          });
          res.write(`data: ${JSON.stringify({
            id: "chatcmpl-slow",
            object: "chat.completion.chunk",
            model: parsed.model,
            choices: [{ index: 0, delta: { content: "partial" } }],
            usage: null,
          })}\n\n`);
          return;
        }
        if (firstText === "tool-stream") {
          res.write(`data: ${JSON.stringify({
            id: "chatcmpl-tool",
            object: "chat.completion.chunk",
            model: parsed.model,
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: 0,
                  id: "call_tool_1",
                  type: "function",
                  function: { name: "run_shell", arguments: "{\"cmd\"" },
                }],
              },
            }],
            usage: null,
          })}\n\n`);
          res.write(`data: ${JSON.stringify({
            id: "chatcmpl-tool",
            object: "chat.completion.chunk",
            model: parsed.model,
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: 0,
                  function: { arguments: ":\"pwd\"}" },
                }],
              },
            }],
            usage: null,
          })}\n\n`);
          res.write(`data: ${JSON.stringify({
            id: "chatcmpl-tool",
            object: "chat.completion.chunk",
            model: parsed.model,
            choices: [],
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
          })}\n\n`);
          res.end("data: [DONE]\n\n");
          return;
        }
        res.write(`data: ${JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          model: parsed.model,
          choices: [{ index: 0, delta: { content: "hello" } }],
          usage: null,
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          model: parsed.model,
          choices: [],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        })}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }

      const isResponses = req.url.includes("/responses");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: isResponses ? "resp-test" : "chatcmpl-test",
        object: isResponses ? "response" : "chat.completion",
        model: parsed?.model,
        choices: isResponses ? undefined : [{ index: 0, message: { role: "assistant", content: "chat answer" }, finish_reason: "stop" }],
        usage: isResponses
          ? { input_tokens: 9, output_tokens: 3, total_tokens: 12 }
          : { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 },
      }));
    });
  });
}

async function request(method, pathname, { key = "jx-shared-user", body } = {}) {
  const headers = {};
  if (key) headers.authorization = `Bearer ${key}`;
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(payload);
  }
  const res = await fetch(`http://127.0.0.1:${appPort}${pathname}`, {
    method,
    headers,
    body: payload,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, text, json };
}

async function openAndAbortStreamingResponse(pathname, body, { key = "jx-shared-user" } = {}) {
  await new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: "127.0.0.1",
      port: appPort,
      path: pathname,
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      },
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error("stream did not start"));
    }, 2000);
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    req.on("response", (res) => {
      res.once("data", () => {
        res.destroy();
        req.destroy();
        finish();
      });
      res.on("error", finish);
    });
    req.on("error", (err) => {
      if (settled) return;
      if (err.code === "ECONNRESET") finish();
      else {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    req.write(payload);
    req.end();
  });
}

function assertInlineScriptsCompile(html) {
  const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)];
  for (const [, attrs, code] of scripts) {
    if (/\ssrc=/i.test(attrs)) continue;
    assert.doesNotThrow(() => new Function(code));
  }
}

async function waitForReady(proc) {
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  proc.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (stdout.includes(`http://0.0.0.0:${appPort}`)) return;
    if (proc.exitCode !== null) throw new Error(`server exited early\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not start\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}

function messageBody(model = "jx-sonnet") {
  return {
    model,
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 8,
  };
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "token-monitor-default-ux-"));
  defaultUpstream = makeUpstream("coding", "coding-model");
  glmUpstream = makeUpstream("glm", "glm-model");
  openaiUpstream = makeOpenAIUpstream();
  const defaultPort = await listen(defaultUpstream);
  const glmPort = await listen(glmUpstream);
  const openaiPort = await listen(openaiUpstream);
  appPort = await freePort();

  fs.copyFileSync(sourceServer, path.join(tmpDir, "server.mjs"));
  // Expose the project's node_modules (better-sqlite3 native addon) to the spawned
  // server running in tmpDir. ESM bare-specifier resolution walks parent dirs.
  fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(tmpDir, "node_modules"), "dir");
  fs.writeFileSync(path.join(tmpDir, "data.json"), JSON.stringify({
    users: {},
    daily: {},
    dailyModels: {},
    dailyHourly: {},
    models: {},
    hourly: {},
    errors: [],
    quotaAdjustHistory: [],
    _lastQuotaEval: null,
  }));
  fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify({
    port: appPort,
    dashboardPassword: "",
    profiles: {
      "Coding Plan": {
        suffix: "coding",
        isDefault: true,
        upstream: `http://127.0.0.1:${defaultPort}/anthropic`,
        allowedModels: ["coding-model"],
        defaultModels: { sonnet: "coding-model", opus: "coding-model", haiku: "coding-model" },
        dailyTokenLimit: null,
        users: {
          "jx-shared-user": { key: "real-coding-key", disabled: false, dailyTokenLimit: null },
          "jx-coding-only": { key: "real-coding-key", disabled: false, dailyTokenLimit: null },
        },
      },
      GLM: {
        suffix: "glm",
        isDefault: false,
        upstream: `http://127.0.0.1:${glmPort}/anthropic`,
        allowedModels: ["glm-model"],
        defaultModels: { sonnet: "glm-model", opus: "glm-model", haiku: "glm-model" },
        dailyTokenLimit: null,
        users: {
          "jx-shared-user": { key: "real-glm-key", disabled: false, dailyTokenLimit: null },
          "jx-disabled-user": { key: "real-disabled-key", disabled: true, dailyTokenLimit: null },
        },
      },
      OpenAI: {
        suffix: "openai",
        isDefault: false,
        apiProtocol: "openai",
        upstream: `http://127.0.0.1:${openaiPort}/compatible-mode/v1`,
        allowedModels: ["gpt-5", "gpt-5-mini"],
        modelAliases: { "codex-main": "gpt-5", "codex-fast": "gpt-5-mini" },
        openaiStreamUsage: true,
        dailyTokenLimit: null,
        users: {
          "jx-shared-user": { key: "real-openai-key", disabled: false, dailyTokenLimit: null },
        },
      },
      "Aliyun Coding OpenAI": {
        suffix: "aliyun-openai",
        isDefault: false,
        apiProtocol: "openai",
        upstream: `http://127.0.0.1:${openaiPort}/compatible-mode/v1`,
        allowedModels: ["glm-5", "qwen3.7-plus", "qwen3.6-plus"],
        modelAliases: { "codex-min": "qwen3.6-plus", "codex-max": "qwen3.7-plus", "codex-pro": "glm-5" },
        openaiStreamUsage: true,
        responsesAdapter: "chat_completions",
        dailyTokenLimit: null,
        users: {
          "jx-shared-user": { key: "real-aliyun-key", disabled: false, dailyTokenLimit: null },
        },
      },
    },
    users: {
      "jx-shared-user": { username: "Shared User", expiresAt: null, disabled: false },
      "jx-unassigned": { username: "Unassigned User", expiresAt: null, disabled: false },
      "jx-disabled-user": { username: "Disabled User", expiresAt: null, disabled: false },
      "jx-coding-only": { username: "Coding Only", expiresAt: null, disabled: false },
    },
    proxy: {
      timeout: 10000,
      streamTimeout: 10000,
      maxRetries: 0,
      retryDelay: 10,
      retryableStatusCodes: [429, 502, 503, 504],
      maxConcurrentPerUser: 5,
      rateLimitPerMinute: 60,
      circuitBreakerFailures: 5,
      circuitBreakerCooldown: 1000,
    },
  }, null, 2));

  app = spawn(process.execPath, ["server.mjs"], { cwd: tmpDir, stdio: ["ignore", "pipe", "pipe"] });
  await waitForReady(app);
});

after(async () => {
  if (app && app.exitCode === null) {
    app.kill("SIGTERM");
    await new Promise((resolve) => app.once("exit", resolve));
  }
  if (defaultUpstream) await closeServer(defaultUpstream);
  if (glmUpstream) await closeServer(glmUpstream);
  if (openaiUpstream) await closeServer(openaiUpstream);
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("multi-profile default entry routing", () => {
  it("routes both /v1 and the default profile suffix to the same default profile", async () => {
    upstreamHits.length = 0;

    const direct = await request("POST", "/v1/messages", { body: messageBody() });
    const suffixed = await request("POST", "/coding/v1/messages", { body: messageBody() });

    assert.equal(direct.status, 200);
    assert.equal(suffixed.status, 200);
    assert.deepEqual(upstreamHits.map((hit) => hit.upstream), ["coding", "coding"]);
    assert.deepEqual(upstreamHits.map((hit) => hit.path), ["/anthropic/v1/messages", "/anthropic/v1/messages"]);
    assert.deepEqual(upstreamHits.map((hit) => hit.authorization), ["Bearer real-coding-key", "Bearer real-coding-key"]);
  });

  it("routes non-default suffixes to their own profile", async () => {
    upstreamHits.length = 0;

    const res = await request("POST", "/glm/v1/messages", { body: messageBody() });

    assert.equal(res.status, 200);
    assert.equal(upstreamHits.length, 1);
    assert.equal(upstreamHits[0].upstream, "glm");
    assert.equal(upstreamHits[0].authorization, "Bearer real-glm-key");
    assert.equal(upstreamHits[0].body.model, "glm-model");
  });

  it("rejects unknown profile suffixes instead of falling back to the default profile", async () => {
    upstreamHits.length = 0;

    const res = await request("POST", "/unknown/v1/messages", { body: messageBody() });

    assert.equal(res.status, 404);
    assert.match(res.json.error, /Unknown profile suffix/);
    assert.equal(upstreamHits.length, 0);
  });
});

describe("personal usage profile access", () => {
  it("aggregates only profiles the user can access", async () => {
    const res = await request("GET", "/api/my-usage?profile=all");

    assert.equal(res.status, 200);
    assert.equal(res.json.profile, "全部可用方案");
    assert.deepEqual(res.json.availableProfiles.map((profile) => profile.suffix).sort(), ["aliyun-openai", "coding", "glm", "openai"]);
    assert.equal(res.json.today.total, 45);
  });

  it("rejects personal usage for a profile the user is not assigned to", async () => {
    const res = await request("GET", "/api/my-usage?profile=glm", { key: "jx-unassigned" });

    assert.equal(res.status, 403);
    assert.match(res.json.error, /not allowed/i);
  });

  it("rejects proxy access when the user is disabled in that profile", async () => {
    const res = await request("POST", "/glm/v1/messages", {
      key: "jx-disabled-user",
      body: messageBody(),
    });

    assert.equal(res.status, 403);
    assert.match(res.json.error, /disabled/i);
  });
});

describe("/api/my-usage error handling (ERR_HTTP_HEADERS_SENT regression)", () => {
  it("returns 403 instead of crashing when a user with partial access requests an inaccessible profile", async () => {
    // jx-coding-only has access to the default "coding" profile but not to "glm".
    // Previously, writeHead(200) ran before getPersonalUsageData() threw, causing
    // a FATAL ERR_HTTP_HEADERS_SENT crash. This request must now return a clean 403.
    const res = await request("GET", "/api/my-usage?profile=glm", { key: "jx-coding-only" });

    assert.equal(res.status, 403);
    assert.match(res.json.error, /not allowed/i);
  });

  it("still serves the profile the partial user can access", async () => {
    const res = await request("GET", "/api/my-usage?profile=coding", { key: "jx-coding-only" });

    assert.equal(res.status, 200);
    assert.equal(res.json.username, "Coding Only");
  });
});

describe("OpenAI transparent proxy support", () => {
  it("proxies chat completions with model aliases and records OpenAI non-stream usage", async () => {
    upstreamHits.length = 0;

    const res = await request("POST", "/openai/v1/chat/completions", {
      body: {
        model: "codex-main",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    assert.equal(res.status, 200);
    assert.equal(upstreamHits.length, 1);
    assert.equal(upstreamHits[0].upstream, "openai");
    assert.equal(upstreamHits[0].path, "/compatible-mode/v1/chat/completions");
    assert.equal(upstreamHits[0].authorization, "Bearer real-openai-key");
    assert.equal(upstreamHits[0].body.model, "gpt-5");

    const usage = await request("GET", "/api/my-usage?profile=openai");
    assert.equal(usage.status, 200);
    assert.equal(usage.json.today.total, 11);
    assert.equal(usage.json.models["gpt-5"].total, 11);
  });

  it("proxies responses endpoint with real model names unchanged", async () => {
    upstreamHits.length = 0;

    const res = await request("POST", "/openai/v1/responses", {
      body: {
        model: "gpt-5",
        input: "hello",
      },
    });

    assert.equal(res.status, 200);
    assert.equal(upstreamHits.length, 1);
    assert.equal(upstreamHits[0].upstream, "openai");
    assert.equal(upstreamHits[0].path, "/compatible-mode/v1/responses");
    assert.equal(upstreamHits[0].body.model, "gpt-5");
  });

  it("serves OpenAI models locally without forwarding discovery probes upstream", async () => {
    upstreamHits.length = 0;

    const res = await request("GET", "/openai/v1/models");

    assert.equal(res.status, 200);
    assert.equal(res.json.object, "list");
    assert.deepEqual(res.json.data.map((model) => model.id).sort(), ["gpt-5", "gpt-5-mini"]);
    assert.equal(upstreamHits.length, 0);
  });

  it("blocks unsupported OpenAI proxy endpoints before they can reach upstream", async () => {
    upstreamHits.length = 0;

    const res = await request("GET", "/openai/v1/usage");

    assert.equal(res.status, 404);
    assert.match(res.json.error, /Unsupported OpenAI\/Codex proxy endpoint/);
    assert.equal(upstreamHits.length, 0);
  });

  it("injects OpenAI stream usage options and records final streaming usage", async () => {
    upstreamHits.length = 0;

    const res = await request("POST", "/openai/v1/chat/completions", {
      body: {
        model: "codex-fast",
        messages: [{ role: "user", content: "stream" }],
        stream: true,
      },
    });

    assert.equal(res.status, 200);
    assert.match(res.text, /data: \[DONE\]/);
    assert.equal(upstreamHits.length, 1);
    assert.deepEqual(upstreamHits[0].body.stream_options, { include_usage: true });
    assert.equal(upstreamHits[0].body.model, "gpt-5-mini");

    const usage = await request("GET", "/api/my-usage?profile=openai");
    assert.equal(usage.status, 200);
    assert.equal(usage.json.today.total, 28);
    assert.equal(usage.json.models["gpt-5-mini"].total, 5);
  });

  it("cancels upstream streaming requests when the client disconnects", async () => {
    upstreamHits.length = 0;

    const upstreamClosed = waitForSlowStreamClose();
    await openAndAbortStreamingResponse("/openai/v1/chat/completions", {
      model: "codex-fast",
      messages: [{ role: "user", content: "slow-stream" }],
      stream: true,
    });
    await upstreamClosed;

    assert.equal(upstreamHits.length, 1);
    assert.equal(upstreamHits[0].path, "/compatible-mode/v1/chat/completions");
    assert.equal(upstreamHits[0].body.model, "gpt-5-mini");
    assert.deepEqual(upstreamHits[0].body.stream_options, { include_usage: true });
  });

  it("rejects OpenAI profile access when the user has no real key for that profile", async () => {
    upstreamHits.length = 0;

    const res = await request("POST", "/openai/v1/responses", {
      key: "jx-unassigned",
      body: {
        model: "gpt-5",
        input: "hello",
      },
    });

    assert.equal(res.status, 403);
    assert.match(res.json.error, /not allowed/i);
    assert.equal(upstreamHits.length, 0);
  });

  it("uses OpenAI-specific copy when rejecting disallowed OpenAI models", async () => {
    upstreamHits.length = 0;

    const res = await request("POST", "/openai/v1/responses", {
      body: {
        model: "gpt-5.5",
        input: "hello",
      },
    });

    assert.equal(res.status, 403);
    assert.match(res.json.error, /allowed models/i);
    assert.match(res.json.error, /gpt-5/);
    assert.doesNotMatch(res.json.error, /jx-sonnet|jx-opus|jx-haiku/);
    assert.equal(upstreamHits.length, 0);
  });
});

describe("OpenAI Responses to Chat Completions adapter", () => {
  it("serves local models for adapter profiles from allowed models", async () => {
    upstreamHits.length = 0;

    const res = await request("GET", "/aliyun-openai/v1/models");

    assert.equal(res.status, 200);
    assert.equal(res.json.object, "list");
    assert.deepEqual(res.json.data.map((model) => model.id).sort(), ["glm-5", "qwen3.6-plus", "qwen3.7-plus"]);
    assert.equal(upstreamHits.length, 0);
  });

  it("converts non-stream responses requests to chat completions and records usage", async () => {
    upstreamHits.length = 0;

    const res = await request("POST", "/aliyun-openai/v1/responses", {
      body: {
        model: "codex-pro",
        instructions: "follow policy",
        input: "hello",
        max_output_tokens: 16,
        temperature: 0.2,
      },
    });

    assert.equal(res.status, 200);
    assert.equal(upstreamHits.length, 1);
    assert.equal(upstreamHits[0].path, "/compatible-mode/v1/chat/completions");
    assert.equal(upstreamHits[0].authorization, "Bearer real-aliyun-key");
    assert.equal(upstreamHits[0].body.model, "glm-5");
    assert.deepEqual(upstreamHits[0].body.messages, [
      { role: "system", content: "follow policy" },
      { role: "user", content: "hello" },
    ]);
    assert.equal(upstreamHits[0].body.max_tokens, 16);
    assert.equal(upstreamHits[0].body.temperature, 0.2);
    assert.equal(res.json.object, "response");
    assert.equal(res.json.model, "glm-5");
    assert.equal(res.json.output_text, "chat answer");
    assert.deepEqual(res.json.usage, { input_tokens: 7, output_tokens: 4, total_tokens: 11 });

    const usage = await request("GET", "/api/my-usage?profile=aliyun-openai");
    assert.equal(usage.status, 200);
    assert.equal(usage.json.today.total, 11);
    assert.equal(usage.json.models["glm-5"].total, 11);
  });

  it("converts streaming responses requests to responses SSE events and records final usage", async () => {
    upstreamHits.length = 0;

    const res = await request("POST", "/aliyun-openai/v1/responses", {
      body: {
        model: "codex-min",
        input: [{ role: "user", content: "stream" }],
        stream: true,
      },
    });

    assert.equal(res.status, 200);
    assert.match(res.text, /event: response\.created/);
    assert.match(res.text, /event: response\.output_item\.added/);
    assert.match(res.text, /event: response\.content_part\.added/);
    assert.match(res.text, /event: response\.output_text\.delta/);
    assert.match(res.text, /"delta":"hello"/);
    assert.match(res.text, /event: response\.content_part\.done/);
    assert.match(res.text, /event: response\.output_item\.done/);
    assert.match(res.text, /event: response\.completed/);
    assert.equal(upstreamHits.length, 1);
    assert.equal(upstreamHits[0].path, "/compatible-mode/v1/chat/completions");
    assert.equal(upstreamHits[0].body.model, "qwen3.6-plus");
    assert.equal(upstreamHits[0].body.stream, true);
    assert.deepEqual(upstreamHits[0].body.stream_options, { include_usage: true });

    const usage = await request("GET", "/api/my-usage?profile=aliyun-openai");
    assert.equal(usage.status, 200);
    assert.equal(usage.json.today.total, 16);
    assert.equal(usage.json.models["qwen3.6-plus"].total, 5);
  });

  it("converts streamed chat tool calls to responses function-call events", async () => {
    upstreamHits.length = 0;

    const res = await request("POST", "/aliyun-openai/v1/responses", {
      body: {
        model: "codex-pro",
        input: "tool-stream",
        stream: true,
        tools: [{
          type: "function",
          name: "run_shell",
          parameters: {
            type: "object",
            properties: { cmd: { type: "string" } },
            required: ["cmd"],
          },
        }],
      },
    });

    assert.equal(res.status, 200);
    assert.match(res.text, /event: response\.output_item\.added/);
    assert.match(res.text, /"type":"function_call"/);
    assert.match(res.text, /"call_id":"call_tool_1"/);
    assert.match(res.text, /"name":"run_shell"/);
    assert.match(res.text, /event: response\.function_call_arguments\.delta/);
    assert.match(res.text, /event: response\.function_call_arguments\.done/);
    assert.match(res.text, /\\"cmd\\":\\"pwd\\"/);
    assert.match(res.text, /event: response\.output_item\.done/);
    assert.match(res.text, /event: response\.completed/);
    assert.equal(upstreamHits.length, 1);
    assert.equal(upstreamHits[0].body.tools[0].function.name, "run_shell");

    const usage = await request("GET", "/api/my-usage?profile=aliyun-openai");
    assert.equal(usage.status, 200);
    assert.equal(usage.json.models["glm-5"].total, 17);
  });
});

describe("management and usage pages", () => {
  it("renders settings page controls for default alias and per-profile users", async () => {
    const res = await request("GET", "/settings", { key: null });

    assert.equal(res.status, 200);
    assert.match(res.text, /新增方案/);
    assert.match(res.text, /设为默认/);
    assert.match(res.text, /接口协议/);
    assert.match(res.text, /模型别名/);
    assert.match(res.text, /userProfileSel/);
    assertInlineScriptsCompile(res.text);
  });

  it("returns OpenAI protocol fields in settings API", async () => {
    const res = await request("GET", "/api/settings", { key: null });

    assert.equal(res.status, 200);
    const openai = res.json.profiles.find((profile) => profile.suffix === "openai");
    assert.equal(openai.apiProtocol, "openai");
    assert.equal(openai.modelAliases["codex-main"], "gpt-5");
    assert.equal(openai.modelAliases["codex-fast"], "gpt-5-mini");
    assert.equal(openai.modelAliases["jx-sonnet"], undefined);
    assert.equal(openai.openaiStreamUsage, true);
    assert.equal(openai.responsesAdapter, "none");
    const aliyun = res.json.profiles.find((profile) => profile.suffix === "aliyun-openai");
    assert.equal(aliyun.apiProtocol, "openai");
    assert.equal(aliyun.responsesAdapter, "chat_completions");
  });

  it("renders dashboard profile center", async () => {
    const res = await request("GET", "/dashboard", { key: null });

    assert.equal(res.status, 200);
    assert.match(res.text, /方案中心/);
    assert.match(res.text, /profileSummarySec/);
    assertInlineScriptsCompile(res.text);
  });

  it("renders personal usage profile selector", async () => {
    const res = await request("GET", "/usage/jx-shared-user", { key: null });

    assert.equal(res.status, 200);
    assert.match(res.text, /全部可用方案/);
    assert.match(res.text, /profileSel/);
    assertInlineScriptsCompile(res.text);
  });
});
