/** A remote command can block on human UI; acknowledge dispatch, not its completion. */
export function dispatchRemoteCommand(run: () => Promise<unknown>, acknowledge: () => void, onError: (error: unknown) => void): void {
  const result = run();
  acknowledge();
  void Promise.resolve(result).catch(error => {
    try { onError(error); } catch { /* background error reporting must not become unhandled */ }
  });
}
