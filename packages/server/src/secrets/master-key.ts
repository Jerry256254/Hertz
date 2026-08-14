import fs from "node:fs/promises";
import crypto from "node:crypto";
import type { HertzPaths } from "../paths.js";

/**
 * OS keychains (macOS Keychain, Windows DPAPI, Linux libsecret) aren't reliably
 * available to a headless server process — no session keyring in many
 * systemd/server contexts, no GUI. A permission-protected key file is the
 * pragmatic baseline; HERTZ_MASTER_KEY lets users who want the key elsewhere
 * (systemd EnvironmentFile, a secrets manager) opt out without changing the
 * encryption mechanism. This does not protect against a compromised host
 * reading process memory — that boundary is "don't expose this without
 * HTTPS/Tailscale," enforced by the setup wizard.
 */
export async function loadOrCreateMasterKey(paths: HertzPaths): Promise<Buffer> {
  const envKey = process.env.HERTZ_MASTER_KEY;
  if (envKey) {
    const buf = Buffer.from(envKey, "hex");
    if (buf.length !== 32) {
      throw new Error("HERTZ_MASTER_KEY must be a 64-character hex string (32 bytes)");
    }
    return buf;
  }

  try {
    const existing = await fs.readFile(paths.masterKeyPath);
    if (existing.length !== 32) {
      throw new Error(`${paths.masterKeyPath} does not contain a 32-byte key`);
    }
    return existing;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const key = crypto.randomBytes(32);
  await fs.writeFile(paths.masterKeyPath, key, { mode: 0o600 });
  await fs.chmod(paths.masterKeyPath, 0o600);
  return key;
}
