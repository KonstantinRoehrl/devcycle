// Blocks the thread: the polling callers are synchronous scripts and hooks that cannot await.
export const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
