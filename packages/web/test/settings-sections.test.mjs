import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "settings", "SettingsModal.tsx");
const src = readFileSync(FILE, "utf8");

describe("SettingsModal sections", () => {
  it("has no wallet section", () => {
    assert.ok(!src.includes('"wallet"'), "wallet section id still present");
    assert.ok(!src.includes("WalletSection"), "WalletSection still present");
    assert.ok(!src.includes("Peněženka"), "Peněženka label still present");
  });

  it("has no permissions section", () => {
    assert.ok(!src.includes('"permissions"'), "permissions section id still present");
    assert.ok(!src.includes("PermissionsSection"), "PermissionsSection still present");
    assert.ok(!src.includes("Oprávnění"), "Oprávnění label still present");
  });

  it("keeps a placeholder for the future vault (trezor) section", () => {
    assert.ok(src.includes("vault"), "no vault placeholder comment for the vault agent");
  });

  it("NAV ids match the rendered sections", () => {
    const navIds = [...src.matchAll(/\{ id: "([a-z]+)"/g)].map((m) => m[1]);
    assert.ok(navIds.length >= 6, `expected several nav sections, got ${navIds.length}`);
    for (const id of navIds) {
      assert.ok(
        src.includes(`section === "${id}"`),
        `NAV section "${id}" has no render branch in the section switch`,
      );
    }
  });

  it("dialog is compact (not fullscreen)", () => {
    assert.ok(src.includes("max-w-[600px]"), "settings dialog should be a compact max-w-[600px] dialog");
    assert.ok(!src.includes("max-w-[880px]"), "old fullscreen-wide dialog still present");
  });
});
