// Moving a freshly written file over the one it replaces.
//
// Every file this application replaces is written beside itself and then moved
// over the old one, so a reader never sees half a file. On Windows that move
// fails with EPERM, EACCES or EBUSY while another process holds either file
// open without delete sharing - a file watcher, an antivirus scan, the search
// indexer, an editor showing the folder. Such a hold lasts milliseconds, so the
// move is tried again for a short, bounded time. Any other failure, or a hold
// that outlasts the bound, is thrown as before and the caller handles it as it
// always did.

import { rename } from "node:fs/promises";

const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);
const RETRY_FOR_MS = 2_000;
const FIRST_WAIT_MS = 10;
const LONGEST_WAIT_MS = 200;

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * rename(temporary, target), retried while the failure is a transient hold.
 * `renameImpl`, `now` and `sleep` are for tests.
 */
export async function moveOver(temporary, target, {
  retryForMs = RETRY_FOR_MS, renameImpl = rename, now = Date.now, sleep = pause,
} = {}) {
  const deadline = now() + retryForMs;
  for (let wait = FIRST_WAIT_MS; ; wait = Math.min(wait * 2, LONGEST_WAIT_MS)) {
    try {
      await renameImpl(temporary, target);
      return;
    } catch (error) {
      if (!TRANSIENT.has(error?.code) || now() + wait > deadline) throw error;
      await sleep(wait);
    }
  }
}
