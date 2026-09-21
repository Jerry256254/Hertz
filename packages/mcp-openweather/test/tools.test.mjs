import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverJs = path.join(here, "..", "dist", "server.js");

/** Minimal fake OpenWeather API — asserts the appid query param on every call. */
function startMockWeather() {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    assert.equal(u.searchParams.get("appid"), "dummy-key", "missing appid query param");
    assert.equal(u.searchParams.get("units"), "metric");
    const json = (obj) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (u.pathname === "/data/2.5/weather") {
      return json({
        name: "Praha",
        sys: { country: "CZ" },
        weather: [{ description: "jasno" }],
        main: { temp: 18.4, feels_like: 17.1, temp_min: 15, temp_max: 21, humidity: 55, pressure: 1015 },
        wind: { speed: 3.2, deg: 180 },
      });
    }
    if (u.pathname === "/data/2.5/forecast") {
      const now = Math.floor(Date.now() / 1000);
      return json({
        city: { name: "Praha" },
        list: [
          { dt: now + 3600, main: { temp: 17 }, weather: [{ description: "polojasno" }], rain: { "3h": 0 }, wind: { speed: 2.5 } },
          { dt: now + 10 * 86400, main: { temp: 12 }, weather: [{ description: "vytrvalý déšť" }], wind: { speed: 5 } },
        ],
      });
    }
    res.writeHead(404);
    res.end("{}");
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
  });
}

let client;
let mock;

before(async () => {
  mock = await startMockWeather();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverJs],
    env: {
      OPENWEATHER_API_KEY: "dummy-key",
      OPENWEATHER_API_ROOT: `http://127.0.0.1:${mock.port}/data/2.5`,
    },
  });
  client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
});

after(async () => {
  await client.close().catch(() => {});
  mock.srv.close();
});

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  return res.content.map((c) => c.text).join("\n");
}

describe("mcp-openweather", () => {
  it("registers both tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["weather_current", "weather_forecast"]);
  });

  it("returns current weather by city", async () => {
    const text = await call("weather_current", { city: "Praha" });
    assert.match(text, /Praha/);
    assert.match(text, /18 °C/);
    assert.match(text, /jasno/);
  });

  it("returns current weather by coordinates", async () => {
    const text = await call("weather_current", { lat: 50.07, lon: 14.42 });
    assert.match(text, /Praha/);
  });

  it("returns forecast limited to requested days", async () => {
    const text = await call("weather_forecast", { city: "Praha", days: 2 });
    assert.match(text, /polojasno/);
    assert.doesNotMatch(text, /vytrvalý déšť/);
  });

  it("requires either city or coordinates", async () => {
    const res = await client.callTool({ name: "weather_current", arguments: {} });
    assert.equal(res.isError, true);
    assert.match(res.content.map((c) => c.text).join("\n"), /buď město/);
  });

  it("exits without OPENWEATHER_API_KEY", async () => {
    const t = new StdioClientTransport({ command: process.execPath, args: [serverJs], env: {} });
    const c = new Client({ name: "t", version: "0.0.0" }, { capabilities: {} });
    await assert.rejects(() => c.connect(t));
    await c.close().catch(() => {});
  });
});
