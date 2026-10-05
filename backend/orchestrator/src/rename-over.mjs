import { rename } from "node:fs/promises";

// Replaces a file by renaming a finished temporary file over it. On Windows the
// target can be held for a moment by another reader - an antivirus scan, the
// search indexer, a process reading it - and the rename then fails with EPERM,
// EACCES or EBUSY although nothing is wrong. That hold is waited out for a
// bounded time (about a second and a half); any other failure, or a hold that
// outlasts the bound, is thrown unchanged, as a plain rename would.

const HELD = new Set(["EPERM", "EACCES", "EBUSY"]);

export async function renameOver(from, to, { attempts = 12, firstDelayMs = 10, maximumDelayMs = 250,
  renameImpl = rename } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await renameImpl(from, to);
      return;
    } catch (error) {
      if (!HELD.has(error?.code) || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(firstDelayMs * 2 ** (attempt - 1), maximumDelayMs)));
    }
  }
}
