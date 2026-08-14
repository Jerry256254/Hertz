import { ALL_TOOLS, runTool, toProviderToolDefinitions } from "@kuclab-hertz/tools";
import type { ToolPort } from "@kuclab-hertz/core";

export function createToolPort(): ToolPort {
  return {
    listDefinitions() {
      return toProviderToolDefinitions(ALL_TOOLS);
    },
    run(name, input, ctx) {
      return runTool(name, input, ctx);
    },
  };
}
