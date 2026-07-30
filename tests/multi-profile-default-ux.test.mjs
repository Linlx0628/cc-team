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

function assertEditorialLightHtml(html) {
  assert.match(html, /data-theme="editorial-light"/);
  assert.match(html, /--canvas:\s*#f7f7f3/i);
  assert.doesNotMatch(html, /Press Start 2P|Pixelify Sans|VT323|scanbar|glitch|pulse-glow|fx-spot/i);
  assert.doesNotMatch(html, /\p{Extended_Pictographic}/u);
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
    assert.deepEqual(res.json.availableProfiles.map((profile) => profile.suffix).sort(), ["coding", "glm"]);
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

describe("management and usage pages", () => {
  it("renders every public UI with the shared editorial light theme", async () => {
    const pages = await Promise.all([
      request("GET", "/dashboard", { key: null }),
      request("GET", "/settings", { key: null }),
      request("GET", "/my-usage", { key: null }),
      request("GET", "/usage/jx-shared-user", { key: null }),
    ]);

    for (const page of pages) {
      assert.equal(page.status, 200);
      assertEditorialLightHtml(page.text);
      assertInlineScriptsCompile(page.text);
    }
  });

  it("keeps application and documentation sources free of cyberpunk styling and emoji", () => {
    const source = fs.readFileSync(sourceServer, "utf8");
    const docs = ["index.html", "style.css", "script.js"]
      .map((name) => fs.readFileSync(path.join(repoRoot, "docs", name), "utf8"))
      .join("\n");
    const bannedStyle = /Press Start 2P|Pixelify Sans|VT323|scanlines|grid-bg|glitch|pulse-glow|fx-spot/i;

    assert.doesNotMatch(source, bannedStyle);
    assert.doesNotMatch(docs, bannedStyle);
    assert.doesNotMatch(source, /\p{Extended_Pictographic}/u);
    assert.doesNotMatch(docs, /\p{Extended_Pictographic}/u);
    assert.match(docs, /--canvas:\s*#f7f7f3/i);
  });

  it("renders settings page controls for default alias and per-profile users", async () => {
    const res = await request("GET", "/settings", { key: null });

    assert.equal(res.status, 200);
    assert.match(res.text, /新增方案/);
    assert.match(res.text, /设为默认/);
    assert.match(res.text, /模型别名/);
    assert.doesNotMatch(res.text, /OpenAI-compatible|Responses 兼容模式|defaultModels_sonnet/);
    assert.match(res.text, /userProfileSel/);
    for (const controlId of ["dataImportFile", "dataImportPreview", "dataImportMode", "dataImportPassword", "dataClearButton", "dataClearModal", "dataClearPassword"]) {
      assert.match(res.text, new RegExp(`id=["']${controlId}["']`));
    }
    for (const viewId of ["dataManagementNav", "dataManagementView"]) {
      assert.match(res.text, new RegExp(`id=["']${viewId}["']`));
    }
    const settingsFormStart = res.text.indexOf('id="settingsForm"');
    const settingsFormEnd = res.text.indexOf("</form>", settingsFormStart);
    const dataManagementView = res.text.indexOf('id="dataManagementView"');
    assert.ok(settingsFormStart >= 0 && settingsFormEnd > settingsFormStart);
    assert.ok(dataManagementView > settingsFormEnd, "global data management must render outside the profile form");
    assert.match(res.text, /\.actions\{position:fixed;left:260px;right:0;bottom:0;/);
    assert.match(res.text, /@media\(max-width:680px\)[\s\S]*?\.actions\{left:0;/);
    assertInlineScriptsCompile(res.text);
  });

  it("returns only generic model aliases in settings API", async () => {
    const res = await request("GET", "/api/settings", { key: null });

    assert.equal(res.status, 200);
    assert.deepEqual(res.json.profiles.map((profile) => profile.suffix).sort(), ["coding", "glm"]);
    const coding = res.json.profiles.find((profile) => profile.suffix === "coding");
    assert.deepEqual(coding.modelAliases, {
      "jx-sonnet": "coding-model",
      "jx-opus": "coding-model",
      "jx-haiku": "coding-model",
    });
    assert.equal(coding.apiProtocol, undefined);
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

  it("migrates fixed Claude aliases into generic aliases and removes legacy protocol fields", async () => {
    const persisted = JSON.parse(fs.readFileSync(path.join(tmpDir, "config.json"), "utf8"));
    const coding = persisted.profiles["Coding Plan"];

    assert.equal(coding.defaultModels, undefined);
    assert.equal(coding.apiProtocol, undefined);
    assert.equal(coding.openaiStreamUsage, undefined);
    assert.equal(coding.responsesAdapter, undefined);
    assert.deepEqual(coding.modelAliases, {
      "jx-sonnet": "coding-model",
      "jx-opus": "coding-model",
      "jx-haiku": "coding-model",
    });
    assert.deepEqual(Object.keys(persisted.profiles).sort(), ["Coding Plan", "GLM"]);
    const backups = fs.readdirSync(path.join(tmpDir, "backups"));
    assert.ok(backups.some((name) => name.endsWith("remove-openai-config.json")));
  });

  it("rejects OpenAI endpoints without forwarding them upstream", async () => {
    upstreamHits.length = 0;

    const responses = await request("POST", "/v1/responses", {
      body: { model: "coding-model", input: "hello" },
    });
    const chat = await request("POST", "/v1/chat/completions", {
      body: { model: "coding-model", messages: [{ role: "user", content: "hello" }] },
    });
    const models = await request("GET", "/v1/models");

    assert.equal(responses.status, 404);
    assert.equal(chat.status, 404);
    assert.equal(models.status, 404);
    assert.equal(upstreamHits.length, 0);
  });
});
