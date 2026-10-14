/** Run at most one asynchronous pass at a time; later timer ticks are skipped, not queued. */
export function singleFlight(task: () => Promise<void>, onError: (error: unknown) => void): () => boolean {
  let running = false;
  return () => {
    if (running) return false;
    running = true;
    void Promise.resolve().then(task).catch(onError).finally(() => { running = false; });
    return true;
  };
}
