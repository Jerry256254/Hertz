import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { z } from "zod";
import type { ToolContext, ToolDef, ToolResult } from "../types.js";

const transcribeSchema = z.object({
  path: z.string().describe("Audio file path relative to the project root (mp3, wav, m4a, ogg, flac, webm)"),
  language: z.string().optional().describe("ISO language hint, e.g. 'cs' or 'en' — improves accuracy"),
});
type TranscribeInput = z.infer<typeof transcribeSchema>;

const speakSchema = z.object({
  text: z.string().min(1).max(4000),
  outPath: z.string().optional().describe("Where to save the audio, relative to the project root (default: tts-<timestamp>.mp3 in your personal folder)"),
  voice: z.string().optional().describe("Voice name (OpenAI TTS voices: alloy, echo, fable, onyx, nova, shimmer)"),
});
type SpeakInput = z.infer<typeof speakSchema>;

const MAX_AUDIO_BYTES = 25_000_000;

function runCommand(cmd: string, args: string[], timeoutMs = 120_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 10_000_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${stderr || err.message}`.trim()));
      else resolve({ stdout, stderr });
    });
  });
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await runCommand(cmd, cmd === "whisper" ? ["--help"] : ["--version"], 10_000);
    return true;
  } catch {
    return false;
  }
}

async function transcribeWithOpenAI(absPath: string, language: string | undefined, apiKey: string): Promise<string> {
  const data = await fs.readFile(absPath);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(data)], { type: "audio/mpeg" }), absPath.split("/").pop() ?? "audio.mp3");
  form.append("model", "whisper-1");
  if (language) form.append("language", language);
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Whisper API returned HTTP ${res.status}`);
  const json = (await res.json()) as { text?: string };
  return (json.text ?? "").trim();
}

/** Local whisper CLI (pip install openai-whisper) — free after the one-time model download. */
async function transcribeWithLocalWhisper(absPath: string, language: string | undefined): Promise<string> {
  const args = [absPath, "--model", "base", "--output_format", "txt", "--output_dir", "/tmp"];
  if (language) args.push("--language", language);
  await runCommand("whisper", args, 300_000);
  const base = (absPath.split("/").pop() ?? "audio").replace(/\.[^.]+$/, "");
  const txt = await fs.readFile(`/tmp/${base}.txt`, "utf8").catch(() => "");
  await fs.rm(`/tmp/${base}.txt`, { force: true });
  if (!txt.trim()) throw new Error("local whisper produced no output");
  return txt.trim();
}

export const transcribeAudioTool: ToolDef<TranscribeInput> = {
  name: "transcribe_audio",
  description:
    "Transcribe an audio/video file to text (speech-to-text). Uses the OpenAI Whisper API when OPENAI_API_KEY is set on the server, otherwise a local `whisper` CLI install (free).",
  inputSchema: transcribeSchema,
  async execute(input, ctx: ToolContext): Promise<ToolResult> {
    const abs = ctx.pathGuard.resolve(ctx.actor, ctx.rootId, input.path);
    let size = 0;
    try {
      size = (await fs.stat(abs)).size;
    } catch {
      return { summary: `Audio file not found: ${input.path}`, isError: true };
    }
    if (size > MAX_AUDIO_BYTES) return { summary: `Audio file too large (${size} bytes, max 25 MB)`, isError: true };

    const errors: string[] = [];
    if (process.env.OPENAI_API_KEY) {
      try {
        const text = await transcribeWithOpenAI(abs, input.language, process.env.OPENAI_API_KEY);
        return { summary: `Transcript of ${input.path} (Whisper API):\n${text}` };
      } catch (err) {
        errors.push(`Whisper API: ${(err as Error).message}`);
      }
    }
    if (await commandExists("whisper")) {
      try {
        const text = await transcribeWithLocalWhisper(abs, input.language);
        return { summary: `Transcript of ${input.path} (local whisper):\n${text}` };
      } catch (err) {
        errors.push(`local whisper: ${(err as Error).message}`);
      }
    } else {
      errors.push("no local `whisper` CLI installed (pip install openai-whisper)");
    }
    return { summary: `Transcription failed: ${errors.join(" · ")}`, isError: true };
  },
};

interface TtsResult {
  bytes: Buffer;
  ext: string;
  engine: string;
}

async function speakWithOpenAI(text: string, voice: string | undefined, apiKey: string): Promise<TtsResult> {
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: "tts-1", input: text, voice: voice ?? "alloy", response_format: "mp3" }),
  });
  if (!res.ok) throw new Error(`OpenAI TTS returned HTTP ${res.status}`);
  return { bytes: Buffer.from(await res.arrayBuffer()), ext: "mp3", engine: "OpenAI TTS" };
}

/** Offline CLI engines, best first. Output formats differ, so each reports its own extension. */
async function speakWithLocalCli(text: string, tmpBase: string): Promise<TtsResult> {
  if (await commandExists("espeak-ng")) {
    const out = `${tmpBase}.wav`;
    await runCommand("espeak-ng", ["-v", "cs", "-s", "165", "-w", out, text]);
    return { bytes: await fs.readFile(out), ext: "wav", engine: "espeak-ng" };
  }
  if (await commandExists("pico2wave")) {
    const out = `${tmpBase}.wav`;
    await runCommand("pico2wave", ["--lang", "en-GB", "--wave", out, text]);
    return { bytes: await fs.readFile(out), ext: "wav", engine: "pico2wave" };
  }
  if (await commandExists("say")) {
    const out = `${tmpBase}.aiff`;
    await runCommand("say", ["-o", out, text]);
    return { bytes: await fs.readFile(out), ext: "aiff", engine: "say" };
  }
  throw new Error("no local TTS engine found (install espeak-ng: `sudo apt install espeak-ng`)");
}

export const speakTextTool: ToolDef<SpeakInput> = {
  name: "speak_text",
  description:
    "Convert text to speech and save it as an audio file. Uses OpenAI TTS when OPENAI_API_KEY is set on the server, otherwise a free offline engine (espeak-ng / pico2wave / say) if installed.",
  inputSchema: speakSchema,
  async execute(input, ctx: ToolContext): Promise<ToolResult> {
    const errors: string[] = [];
    let audio: TtsResult | undefined;
    if (process.env.OPENAI_API_KEY) {
      try {
        audio = await speakWithOpenAI(input.text, input.voice, process.env.OPENAI_API_KEY);
      } catch (err) {
        errors.push(`OpenAI TTS: ${(err as Error).message}`);
      }
    }
    if (!audio) {
      const tmpBase = `/tmp/hertz-tts-${Date.now()}`;
      try {
        audio = await speakWithLocalCli(input.text, tmpBase);
      } catch (err) {
        errors.push((err as Error).message);
      } finally {
        await fs.rm(`${tmpBase}.wav`, { force: true });
        await fs.rm(`${tmpBase}.aiff`, { force: true });
      }
    }
    if (!audio) return { summary: `Speech synthesis failed: ${errors.join(" · ")}`, isError: true };

    const relPath = input.outPath ?? `tts-${Date.now()}.${audio.ext}`;
    const root = input.outPath ? ctx.rootId : "self";
    const abs = ctx.pathGuard.resolve(ctx.actor, root, relPath);
    try {
      await fs.writeFile(abs, audio.bytes);
    } catch (err) {
      return { summary: `Synthesis worked (${audio.engine}) but saving failed: ${(err as Error).message}`, isError: true };
    }
    return { summary: `Spoken (${audio.engine}, ${audio.bytes.byteLength} bytes) → ${root === "self" ? "personal folder" : "project"}: ${relPath}` };
  },
};
