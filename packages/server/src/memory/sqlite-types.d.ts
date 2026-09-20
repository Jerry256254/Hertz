/**
 * Minimal ambient types for the Node.js built-in `node:sqlite` module.
 * The pinned @types/node predates its sqlite declarations, so the exact
 * surface we use is declared here instead of bumping the world.
 */
declare module "node:sqlite" {
  export type SQLInputValue = null | number | bigint | string | Uint8Array;

  export class StatementSync {
    get(...params: SQLInputValue[]): Record<string, SQLInputValue> | undefined;
    all(...params: SQLInputValue[]): Array<Record<string, SQLInputValue>>;
    run(...params: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  }

  export class DatabaseSync {
    constructor(path: string | null, options?: object);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
    enableLoadExtension(enabled: boolean): void;
  }
}
