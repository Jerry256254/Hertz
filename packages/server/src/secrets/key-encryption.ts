import crypto from "node:crypto";

export interface EncryptedPayload {
  iv: string;
  authTag: string;
  ciphertext: string;
}

const ALGORITHM = "aes-256-gcm";

export function encryptSecret(masterKey: Buffer, plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const payload: EncryptedPayload = {
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  return JSON.stringify(payload);
}

export function decryptSecret(masterKey: Buffer, serialized: string): string {
  const payload = JSON.parse(serialized) as EncryptedPayload;
  const decipher = crypto.createDecipheriv(ALGORITHM, masterKey, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

/** Never send the real key to the client — a short masked hint is enough for the UI to confirm which key is set. */
export function maskKey(plaintext: string): string {
  if (plaintext.length <= 8) return "••••";
  return `${plaintext.slice(0, 4)}••••${plaintext.slice(-4)}`;
}
