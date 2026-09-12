/** A live LISTEN registration. */
export interface PgSubscription {
  unlisten(): Promise<void>;
}

/** Transaction-scoped handle handed to `sql.begin`. */
export interface PgTransactionScope {
  unsafe(query: string, params?: unknown[]): Promise<unknown>;
}

export interface Sql {
  /** Parameterized query. Params are bound, never interpolated. */
  unsafe(query: string, params?: unknown[]): Promise<unknown>;
  /** Runs the callback inside BEGIN/COMMIT, rolling back if it throws. */
  begin(fn: (tx: PgTransactionScope) => Promise<unknown>): Promise<unknown>;
  /**
   * Registers a LISTEN on a session-stable connection. `onlisten` fires on the
   * initial registration AND after every reconnect, which is the hook a missed
   * -notification recovery pass hangs off.
   */
  listen(
    channel: string,
    onNotify: (payload: string) => void,
    onListen?: () => void,
  ): Promise<PgSubscription>;
  end(options?: { timeout?: number }): Promise<void>;
}
