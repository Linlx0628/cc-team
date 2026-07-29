import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceServer = path.join(repoRoot, "server.mjs");

let tmpDir;
let app;
let appPort;
let upstream;
let authCookie = "";
let csrfToken = "";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
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

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function request(method, pathname, { body, authenticated = true, key } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (payload) {
      headers["content-type"] = "application/json";
      headers["content-length"] = payload.length;
    }
    if (authenticated && authCookie) {
      headers.cookie = authCookie;
      headers["x-csrf-token"] = csrfToken;
    }
    if (key) headers.authorization = "Bearer " + key;
    const req = http.request({
      hostname: "127.0.0.1",
      port: appPort,
      path: pathname,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForReady(proc) {
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (stdout.includes("http://0.0.0.0:" + appPort)) return;
    if (proc.exitCode !== null) throw new Error("server exited early\n" + stdout + "\n" + stderr);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("server did not start\n" + stdout + "\n" + stderr);
}

function legacyData(userKey = "jx-imported") {
  return {
    _profiles: {
      legacy: {
        users: {
          [userKey]: {
            name: "Imported User",
            totalInputTokens: 20,
            totalOutputTokens: 10,
            totalRequests: 2,
            lastActive: "2026-06-01T01:00:00.000Z",
          },
        },
        daily: {
          "2026-06-01": {
            [userKey]: { inputTokens: 20, outputTokens: 10, requests: 2 },
          },
        },
        dailyModels: {
          "2026-06-01": {
            [userKey]: {
              "legacy-model": { inputTokens: 20, outputTokens: 10, requests: 2 },
            },
          },
        },
        dailyHourly: {
          "2026-06-01": {
            [userKey]: {
              "09": { inputTokens: 20, outputTokens: 10, requests: 2 },
            },
          },
        },
        models: { "legacy-model": { tokens: 30, requests: 2 } },
        hourly: {
          "2026-06-01": {
            "09": { inputTokens: 20, outputTokens: 10, requests: 2 },
          },
        },
        errors: [],
      },
    },
    quotaAdjustHistory: [],
  };
}

function openDb() {
  return new Database(path.join(tmpDir, "data.db"), { readonly: true });
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "token-monitor-admin-data-"));
  upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: "test-model", usage: { input_tokens: 10, output_tokens: 5 } }));
    });
  });
  const upstreamPort = await listen(upstream);
  appPort = await freePort();
  fs.copyFileSync(sourceServer, path.join(tmpDir, "server.mjs"));
  fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(tmpDir, "node_modules"), "dir");
  fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify({
    port: appPort,
    dashboardPassword: "secret-pass",
    profiles: {
      Main: {
        suffix: "main",
        isDefault: true,
        upstream: "http://127.0.0.1:" + upstreamPort + "/anthropic",
        allowedModels: ["test-model"],
        modelAliases: { "jx-sonnet": "test-model" },
        dailyTokenLimit: null,
        users: {
          "jx-delete": { key: "real-delete", disabled: false, dailyTokenLimit: null },
          "jx-quota": { key: "real-quota", disabled: false, dailyTokenLimit: 1 },
        },
      },
    },
    users: {
      "jx-delete": { username: "Same Name", disabled: false },
      "jx-quota": { username: "Quota User", disabled: false },
    },
    proxy: {
      timeout: 10000,
      streamTimeout: 10000,
      maxRetries: 0,
      retryDelay: 10,
      retryableStatusCodes: [429, 502, 503, 504],
      maxConcurrentPerUser: 2,
      rateLimitPerMinute: 60,
      circuitBreakerFailures: 5,
      circuitBreakerCooldown: 1000,
    },
  }, null, 2));

  app = spawn(process.execPath, ["server.mjs"], { cwd: tmpDir, stdio: ["ignore", "pipe", "pipe"] });
  await waitForReady(app);
  const login = await request("POST", "/api/login", {
    authenticated: false,
    body: { password: "secret-pass" },
  });
  assert.equal(login.status, 200);
  const setCookies = login.headers["set-cookie"] || [];
  authCookie = setCookies.map((value) => value.split(";")[0]).join("; ");
  csrfToken = /tm_csrf=([^;]+)/.exec(authCookie)?.[1] || "";
  assert.ok(csrfToken);
});

after(async () => {
  if (app && app.exitCode === null) {
    app.kill("SIGTERM");
    await new Promise((resolve) => app.once("exit", resolve));
  }
  if (upstream) await closeServer(upstream);
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("legacy data import", () => {
  let preview;

  it("previews legacy data and requires explicit profile mapping", async () => {
    const res = await request("POST", "/api/data-import/preview", { body: { data: legacyData() } });

    assert.equal(res.status, 200);
    assert.equal(res.json.summary.users, 1);
    assert.equal(res.json.summary.requests, 2);
    assert.equal(res.json.summary.minDate, "2026-06-01");
    assert.equal(res.json.summary.maxDate, "2026-06-01");
    assert.deepEqual(res.json.sourceProfiles, [{ suffix: "legacy", matchedTarget: null }]);
    assert.match(res.json.sourceHash, /^[a-f0-9]{64}$/);
    preview = res.json;
  });

  it("merges mapped data once and rejects the same file twice", async () => {
    const body = {
      data: legacyData(),
      sourceHash: preview.sourceHash,
      mode: "merge",
      profileMap: { legacy: "main" },
    };
    const first = await request("POST", "/api/data-import/apply", { body });
    const second = await request("POST", "/api/data-import/apply", { body });

    assert.equal(first.status, 200);
    assert.equal(second.status, 409);
    const db = openDb();
    assert.equal(db.prepare("SELECT total_input+total_output AS tokens FROM users WHERE profile='main' AND user_key='jx-imported'").get().tokens, 30);
    db.close();
  });

  it("requires the dashboard password before replacing request data", async () => {
    const nextData = legacyData("jx-replaced");
    const nextPreview = await request("POST", "/api/data-import/preview", { body: { data: nextData } });
    const wrong = await request("POST", "/api/data-import/apply", {
      body: {
        data: nextData,
        sourceHash: nextPreview.json.sourceHash,
        mode: "replace",
        profileMap: { legacy: "main" },
        password: "wrong",
      },
    });
    const correct = await request("POST", "/api/data-import/apply", {
      body: {
        data: nextData,
        sourceHash: nextPreview.json.sourceHash,
        mode: "replace",
        profileMap: { legacy: "main" },
        password: "secret-pass",
      },
    });

    assert.equal(wrong.status, 401);
    assert.equal(correct.status, 200);
    const db = openDb();
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM users WHERE user_key='jx-imported'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM users WHERE user_key='jx-replaced'").get().count, 1);
    db.close();
  });
});

describe("quota and user lifecycle", () => {
  it("does not leak concurrency slots when quota rejects repeated requests", async () => {
    const first = await request("POST", "/v1/messages", {
      authenticated: false,
      key: "jx-quota",
      body: { model: "jx-sonnet", messages: [{ role: "user", content: "hello" }] },
    });
    assert.equal(first.status, 200);
    for (let i = 0; i < 4; i++) {
      const limited = await request("POST", "/v1/messages", {
        authenticated: false,
        key: "jx-quota",
        body: { model: "jx-sonnet", messages: [{ role: "user", content: "hello" }] },
      });
      assert.equal(limited.status, 429);
      assert.equal(limited.json.type, "quota_exceeded");
    }

    const db = new Database(path.join(tmpDir, "data.db"));
    db.prepare("DELETE FROM usage_daily WHERE user_key='jx-quota'").run();
    db.close();
    const afterReset = await request("POST", "/v1/messages", {
      authenticated: false,
      key: "jx-quota",
      body: { model: "jx-sonnet", messages: [{ role: "user", content: "hello" }] },
    });
    assert.equal(afterReset.status, 200);
  });

  it("deletes a user and all user-identifiable historical records", async () => {
    const usage = await request("POST", "/v1/messages", {
      authenticated: false,
      key: "jx-delete",
      body: { model: "jx-sonnet", messages: [{ role: "user", content: "hello" }] },
    });
    assert.equal(usage.status, 200);

    const deleted = await request("POST", "/api/global-user/delete", { body: { key: "jx-delete" } });
    assert.equal(deleted.status, 200);
    const db = openDb();
    for (const table of ["users", "usage_daily", "usage_daily_model", "usage_daily_hourly", "errors", "quota_adjust_history"]) {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM " + table + " WHERE user_key=?").get("jx-delete").count, 0);
    }
    db.close();
    const config = JSON.parse(fs.readFileSync(path.join(tmpDir, "config.json"), "utf8"));
    assert.equal(config.users["jx-delete"], undefined);
    assert.equal(config.profiles.Main.users["jx-delete"], undefined);
  });
});

describe("complete data clear", () => {
  it("requires the password, preserves system settings, and leaves a safe unconfigured profile", async () => {
    const wrong = await request("POST", "/api/data-clear", { body: { password: "wrong" } });
    assert.equal(wrong.status, 401);

    const cleared = await request("POST", "/api/data-clear", { body: { password: "secret-pass" } });
    assert.equal(cleared.status, 200);
    const config = JSON.parse(fs.readFileSync(path.join(tmpDir, "config.json"), "utf8"));
    assert.equal(config.port, appPort);
    assert.equal(config.dashboardPassword, "secret-pass");
    assert.equal(config.proxy.maxConcurrentPerUser, 2);
    assert.deepEqual(Object.keys(config.users), []);
    assert.deepEqual(Object.keys(config.profiles), ["默认方案"]);
    assert.equal(config.profiles["默认方案"].upstream, "");

    const db = openDb();
    for (const table of ["users", "usage_daily", "usage_daily_model", "usage_daily_hourly", "usage_model", "usage_hourly", "errors", "quota_adjust_history", "kv_meta"]) {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM " + table).get().count, 0);
    }
    db.close();

    const proxy = await request("POST", "/v1/messages", {
      authenticated: false,
      key: "jx-quota",
      body: { model: "jx-sonnet", messages: [] },
    });
    assert.equal(proxy.status, 503);
    assert.ok(fs.readdirSync(path.join(tmpDir, "backups")).some((name) => name.includes("data-clear")));

    app.kill("SIGTERM");
    await new Promise((resolve) => app.once("exit", resolve));
    app = spawn(process.execPath, ["server.mjs"], { cwd: tmpDir, stdio: ["ignore", "pipe", "pipe"] });
    await waitForReady(app);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(app.exitCode, null, "server must remain alive when restarted with an unconfigured profile");

    const relogin = await request("POST", "/api/login", { authenticated: false, body: { password: "secret-pass" } });
    assert.equal(relogin.status, 200);
    const setCookies = relogin.headers["set-cookie"] || [];
    authCookie = setCookies.map((value) => value.split(";")[0]).join("; ");
    csrfToken = /tm_csrf=([^;]+)/.exec(authCookie)?.[1] || "";
    const settings = await request("GET", "/settings");
    assert.equal(settings.status, 200);
  });
});
