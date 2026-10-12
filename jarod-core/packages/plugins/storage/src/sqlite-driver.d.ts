// The package ships typings but does not expose them through its "exports" map: declare the
// subset Jarod uses.
declare module "better-sqlite3-multiple-ciphers" {
  interface Statement {
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }
  interface DatabaseInstance {
    prepare(sql: string): Statement;
    exec(sql: string): DatabaseInstance;
    pragma(source: string, options?: { simple?: boolean }): unknown;
    close(): DatabaseInstance;
  }
  interface Options {
    readonly?: boolean;
    fileMustExist?: boolean;
    timeout?: number;
    /** Path to the compiled addon, when it is not next to the package (packaged apps). */
    nativeBinding?: string;
  }
  namespace Database {
    type Database = DatabaseInstance;
  }
  const Database: new (filename: string, options?: Options) => DatabaseInstance;
  export = Database;
}
