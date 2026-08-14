import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema.js";

export type Database = ReturnType<typeof drizzle<typeof schema>>;

export interface OpenedDatabase {
  client: Client;
  db: Database;
}

export function openDatabase(dbFilePath: string): OpenedDatabase {
  const client = createClient({ url: `file:${dbFilePath}` });
  const db = drizzle(client, { schema });
  return { client, db };
}

export function newId(): string {
  return crypto.randomUUID();
}
