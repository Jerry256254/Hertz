import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { ArtifactStore } from "@kuclab-hertz/tools";
import { sessionBlobsDir, type HertzPaths } from "../paths.js";

/** Large tool output (full shell stdout, full fetched pages) lives here, referenced by id, not resent to the model. */
export function createFileArtifactStore(paths: HertzPaths): ArtifactStore {
  return {
    async store(sessionId, content) {
      const dir = sessionBlobsDir(paths, sessionId);
      await fs.mkdir(dir, { recursive: true });
      const id = crypto.randomUUID();
      await fs.writeFile(path.join(dir, `${id}.txt`), content, "utf8");
      return id;
    },
    async get(sessionId, artifactId) {
      const dir = sessionBlobsDir(paths, sessionId);
      try {
        return await fs.readFile(path.join(dir, `${artifactId}.txt`), "utf8");
      } catch {
        return undefined;
      }
    },
  };
}
