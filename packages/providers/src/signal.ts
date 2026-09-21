/**
 * Combine an optional caller-provided AbortSignal (user stop / pause / cancel)
 * with a hard timeout so a hanging endpoint can never stall a run forever.
 *
 * The timer is unref'd, so it never holds the process open after the request
 * settles; aborting an already-settled signal is a harmless no-op.
 */
export function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    ctrl.abort(new Error(`request timed out after ${ms} ms`));
  }, ms);
  timer.unref?.();
  if (!signal) return ctrl.signal;
  if (signal.aborted) {
    clearTimeout(timer);
    ctrl.abort(signal.reason);
    return ctrl.signal;
  }
  signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      ctrl.abort(signal.reason);
    },
    { once: true },
  );
  return ctrl.signal;
}
