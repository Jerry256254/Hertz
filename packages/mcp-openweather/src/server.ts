#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const apiKey = process.env.OPENWEATHER_API_KEY;
/** Overridable for tests/QA — production default is the OpenWeather API. */
const apiBase = (process.env.OPENWEATHER_API_ROOT ?? "https://api.openweathermap.org/data/2.5").replace(/\/$/, "");

if (!apiKey) {
  console.error("mcp-openweather: missing OPENWEATHER_API_KEY");
  process.exit(1);
}

async function weatherFetch(path: string, params: Record<string, string>): Promise<any> {
  const q = new URLSearchParams({ ...params, appid: apiKey as string, units: "metric", lang: "cz" });
  const res = await fetch(`${apiBase}${path}?${q}`, { headers: { "User-Agent": "kuclab-hertz-mcp-openweather" } });
  const body = await res.text();
  if (!res.ok) {
    let detail = body.slice(0, 500);
    try {
      detail = (JSON.parse(body) as { message?: string }).message ?? detail;
    } catch {
      /* keep raw slice */
    }
    throw new Error(`OpenWeather API error ${res.status}: ${detail}`);
  }
  return JSON.parse(body);
}

const locationSchema = {
  city: z.string().optional().describe("City name, e.g. 'Praha' or 'Praha,CZ'"),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
};

function locationParams(input: { city?: string; lat?: number; lon?: number }): Record<string, string> {
  if (input.city) return { q: input.city };
  if (input.lat !== undefined && input.lon !== undefined) return { lat: String(input.lat), lon: String(input.lon) };
  throw new Error("Zadejte buď město (city), nebo souřadnice (lat + lon).");
}

function describeCurrent(w: any): string {
  const cond = w.weather?.[0]?.description ?? "?";
  return (
    `Aktuální počasí — ${w.name ?? "?"}, ${w.sys?.country ?? ""}: ${cond}\n` +
    `Teplota: ${Math.round(w.main?.temp)} °C (pocitově ${Math.round(w.main?.feels_like)} °C), ` +
    `min ${Math.round(w.main?.temp_min)} / max ${Math.round(w.main?.temp_max)} °C\n` +
    `Vlhkost: ${w.main?.humidity} % · Tlak: ${w.main?.pressure} hPa · ` +
    `Vítr: ${w.wind?.speed} m/s${w.wind?.deg !== undefined ? ` (${w.wind.deg}°)` : ""}`
  );
}

const server = new McpServer({ name: "kuclab-hertz-openweather", version: "0.1.0" });

server.registerTool(
  "weather_current",
  {
    description: "Current weather for a city or coordinates (Czech descriptions, metric units). Read-only.",
    inputSchema: locationSchema,
  },
  async (input) => {
    const w = await weatherFetch("/weather", locationParams(input));
    return { content: [{ type: "text", text: describeCurrent(w) }] };
  },
);

server.registerTool(
  "weather_forecast",
  {
    description: "Weather forecast (3-hour steps, up to 5 days) for a city or coordinates. Read-only.",
    inputSchema: {
      ...locationSchema,
      days: z.number().int().min(1).max(5).optional().default(2).describe("How many days ahead to include"),
    },
  },
  async (input) => {
    const f: any = await weatherFetch("/forecast", locationParams(input));
    const cutoff = Date.now() + input.days * 24 * 3600 * 1000;
    const items: any[] = (f.list ?? []).filter((e: any) => e.dt * 1000 <= cutoff);
    if (items.length === 0) return { content: [{ type: "text", text: "Předpověď není k dispozici." }] };
    const lines = items.map((e) => {
      const d = new Date(e.dt * 1000).toLocaleString("cs-CZ", { weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });
      return `${d}: ${Math.round(e.main?.temp)} °C, ${e.weather?.[0]?.description ?? "?"}, déšť ${(e.rain?.["3h"] ?? 0)} mm, vítr ${e.wind?.speed} m/s`;
    });
    return { content: [{ type: "text", text: `Předpověď — ${f.city?.name ?? ""}:\n${lines.join("\n")}` }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
