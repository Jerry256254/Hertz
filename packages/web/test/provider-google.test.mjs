import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "components", "ProviderCreateForm.tsx");
const src = readFileSync(FILE, "utf8");

describe("ProviderCreateForm — Google API key flow", () => {
  it("select offers Google", () => {
    assert.ok(src.includes('<option value="google">Google</option>'), "google option missing in the select");
  });

  it("shows a Google AI Studio hint box when Google is selected", () => {
    assert.ok(
      src.includes('provider === "google"'),
      "no conditional google branch in the form",
    );
    assert.ok(src.includes("Vlož API klíč z Google AI Studia"), "google hint heading missing");
    assert.ok(src.includes("Get API key"), "step mentioning Get API key missing");
    assert.ok(src.includes("Create API key"), "step mentioning Create API key missing");
  });

  it("AI Studio URL is a link plus a copy button", () => {
    assert.ok(src.includes("https://aistudio.google.com"), "aistudio.google.com URL missing");
    assert.ok(src.includes("CopyButton"), "CopyButton not used for the AI Studio URL");
    assert.ok(
      src.includes('ariaLabel="Zkopírovat adresu Google AI Studia"'),
      "copy button has no Czech accessible label",
    );
  });

  it("prefills label and a sane default model for Google", () => {
    assert.ok(src.includes('"Gemini"'), "label prefill 'Gemini' missing");
    assert.ok(src.includes("gemini-2.5-flash"), "gemini-2.5-flash default model missing");
    assert.ok(
      src.includes("placeholder") && src.includes("Výchozí model (např. gemini-2.5-flash)"),
      "model input has no gemini placeholder for Google",
    );
  });

  it("requires the API key for Google (like DeepSeek's sk-… key)", () => {
    assert.ok(
      src.includes('provider === "anthropic" || apiKey.trim().length > 0'),
      "apiKey is no longer required for non-anthropic providers",
    );
  });

  it("validates the default model for Google in Czech", () => {
    assert.ok(
      src.includes('provider !== "google" || defaultModel.trim().length > 0'),
      "google submit does not require a default model",
    );
    assert.ok(
      src.includes("Zadej výchozí model"),
      "Czech validation hint for the google model is missing",
    );
  });

  it("hint texts are Czech and contain no emoji", () => {
    for (const [m] of src.matchAll(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/gu)) {
      assert.fail(`emoji found in ProviderCreateForm: ${m}`);
    }
  });
});

describe("ProvidersSection — switching and masking", () => {
  const FILE2 = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "settings", "SettingsModal.tsx");
  const modal = readFileSync(FILE2, "utf8");

  it("list shows the masked key hint (AQ.A••••JxKA style)", () => {
    assert.ok(modal.includes("keyHint"), "providers list does not render keyHint");
  });

  it("switching a provider sends providerConfigId and the new default model", () => {
    assert.ok(modal.includes("providerConfigId"), "switch mutation does not patch providerConfigId");
    assert.ok(
      modal.includes("model: p.defaultModel"),
      "switch mutation does not set the agent model to the provider's defaultModel",
    );
  });

  it("a provider without defaultModel clears the agent model and warns in Czech", () => {
    assert.ok(
      modal.includes("Vyber mu model v sekci Model — bez modelu chat neběží"),
      "Czech warning for model-less switch missing",
    );
  });
});
