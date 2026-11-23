/**
 * Long builds (the map) written as generators that `yield` between chunks of work: run them in one go
 * (runSteps) or spread over tasks so the page can paint and handle input in between (runStepsAsync).
 */

/** Run every step now. */
export function runSteps<T>(g: Generator<void, T>): T {
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

/** A fresh macrotask without setTimeout's 4 ms clamp. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
    ch.port2.postMessage(0);
  });
}

/**
 * Run the steps in tasks of about `budgetMs`: after a step that ends past the budget, yield to the event loop.
 * A single step longer than the budget still runs whole.
 */
export async function runStepsAsync<T>(g: Generator<void, T>, budgetMs = 30, onStep?: () => void): Promise<T> {
  let t = performance.now();
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
    onStep?.();
    if (performance.now() - t >= budgetMs) {
      await nextTask();
      t = performance.now();
    }
  }
}
