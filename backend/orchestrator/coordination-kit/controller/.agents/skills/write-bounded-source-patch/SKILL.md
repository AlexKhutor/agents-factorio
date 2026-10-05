---
name: write-bounded-source-patch
description: Use before every manual source or documentation edit in the Windows controller workspace to keep built-in apply_patch calls below command-line limits, split long files safely, and diagnose a timed-out write without blind replay.
---

# Write Bounded Source Patch

Use the built-in `apply_patch` tool for controller-owned source and durable
documentation. Windows currently passes each patch through a batch wrapper, so
one large patch can exceed the command-line limit before the patch engine reads
it.

## Hard Limits

1. Put exactly one destination file in each `apply_patch` call.
2. Keep the complete patch envelope at or below 6,000 characters. Prefer 5,000
   or fewer when paths or content contain non-ASCII text.
3. Measure the patch string before invoking the tool. In a composed tool call,
   fail locally when `patch.length > 6000`; do not send it to `apply_patch`.
4. Never combine two documents merely because they belong to one task.
5. Do not replace `apply_patch` with `Set-Content`, `Out-File`, shell
   redirection, a here-string writer, or another unreviewed file-writing
   shortcut.

## Long Files

For a new file that does not fit in one bounded patch:

1. Add a short valid skeleton containing the title and first section.
2. Append one coherent section at a time with `*** Update File` and an exact
   anchor from the current file.
3. Read the tail or the relevant anchor before every continuation patch.
4. Verify the final file structure and required content after the last patch.

For an existing file, update one coherent region at a time. Do not split in the
middle of a line, code fence, JSON value, or Markdown link.

## Timeout Recovery

A normal bounded local patch should finish quickly. If a call has not returned
within 30 seconds:

1. Stop only that exact tool invocation when the client allows it.
2. Inspect the target path and `git diff -- <path>` without writing.
3. If there is no partial change, retry the same confirmed edit once using
   patches of at most 3,000 characters.
4. If there is a partial change, reconcile it with a new bounded patch; never
   replay the original patch blindly.
5. If the bounded retry also stalls, create a coordination incident and stop.

The retry does not need a new product decision because it implements the same
already-confirmed edit. It may not broaden scope or touch a second file.

## Evidence

Report only bounded metadata: destination path, patch character count, elapsed
time, completion state, and whether a partial diff was found. Do not copy the
patch body, prompts, provider history, or document contents into normal logs.

Operational incident records remain runtime artifacts and must be created with
`tools\write_coordination_incident.ps1`, not with `apply_patch`.
