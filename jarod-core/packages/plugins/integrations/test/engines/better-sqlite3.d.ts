// Local typing for the engine tests: the package does not expose its typings through "exports".
declare module "better-sqlite3-multiple-ciphers" {
  interface Statement {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }
  interface DatabaseInstance {
    prepare(sql: string): Statement;
    exec(sql: string): DatabaseInstance;
    pragma(source: string): unknown;
    loadExtension(path: string): DatabaseInstance;
    close(): DatabaseInstance;
  }
  const Database: new (filename: string) => DatabaseInstance;
  export = Database;
}
