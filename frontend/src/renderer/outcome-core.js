"use strict";

// What to tell the person after a confirmed change: where it stopped and
// with which identifiers. No DOM and no backend - so it is checked
// by tests without a window.
//
// A memory edit can stop in the window (an entry that cannot be sent),
// be declined by the person, run into a newer revision, fail inside the
// Gateway CLI or end with an unknown outcome. Each case is named in
// its own words; the identifiers of the attempt are always visible; what was not reported
// is called not reported, not printed as false or 0.

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module !== null && module.exports) module.exports = api;
  else Object.assign(root, api);
}(typeof globalThis === "undefined" ? this : globalThis, function () {
  const ENTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
  const LIMITS = Object.freeze({ entries: 64, title: 512, text: 65536 });

  const PROBLEM_WORDS = Object.freeze({
    title_empty: "empty title",
    title_too_long: `title longer than ${LIMITS.title} characters`,
    text_too_long: `text longer than ${LIMITS.text} characters`,
    id_invalid: "invalid entry ID",
    id_duplicated: "duplicate entry ID",
    too_many: `more than ${LIMITS.entries} entries`,
  });

  /** Entries that cannot be sent, with their number (from 1) and the reason. */
  function entryProblems(entries) {
    const problems = [];
    if (entries.length > LIMITS.entries) problems.push({ index: null, problem: "too_many" });
    const seen = new Set();
    entries.forEach((entry, position) => {
      const index = position + 1;
      const title = typeof entry.title === "string" ? entry.title : "";
      if (title.trim() === "") problems.push({ index, problem: "title_empty" });
      else if (title.length > LIMITS.title) problems.push({ index, problem: "title_too_long" });
      if (typeof entry.text === "string" && entry.text.length > LIMITS.text) {
        problems.push({ index, problem: "text_too_long" });
      }
      if (typeof entry.id !== "string" || !ENTRY_ID.test(entry.id)) problems.push({ index, problem: "id_invalid" });
      else if (seen.has(entry.id)) problems.push({ index, problem: "id_duplicated" });
      else seen.add(entry.id);
    });
    return problems;
  }

  const describeProblem = ({ index, problem }) =>
    `${index === null ? "Whole list" : `Entry ${index}`}: ${PROBLEM_WORDS[problem] ?? problem}.`;

  const identityLines = (identity) => (identity === null || identity === undefined ? [] : [
    `Operation: ${identity.operationId ?? "not reported"}.`,
    `Command: ${identity.commandId ?? "not reported"}.`,
  ]);

  /**
   * A refused memory save: tone - error, conflict, uncertain or note;
   * mayRetry - whether simply trying again is allowed (not after an unknown outcome).
   */
  function describeSaveFailure(error, identity = null) {
    const code = error?.code ?? "unknown";
    const reasonCode = error?.reasonCode ?? null;
    if (code === "user_declined") {
      return { tone: "note", mayRetry: true, title: "Not saved: confirmation declined.",
        details: ["Nothing was written."] };
    }
    if (reasonCode === "stale_revision" || code === "stale_revision") {
      return { tone: "conflict", mayRetry: false,
        title: "The memory changed after it was read: nothing was overwritten.",
        details: ["Reread the memory and reconcile the versions yourself.", ...identityLines(identity)] };
    }
    if (code === "invalid_input") {
      return { tone: "error", mayRetry: true, title: "Not sent: the check before writing refused the edit.",
        details: [`Reason: ${reasonCode ?? "not reported"}.`, "Nothing was written."] };
    }
    if (code === "cli_unavailable" && error?.uncertain === true) {
      return { tone: "uncertain", mayRetry: false,
        title: "Outcome unknown: the Gateway CLI did not answer; the write may have happened.",
        details: [
          `Reason: ${reasonCode ?? "not reported"}.`,
          "Reread the memory before saving again. Do not repeat the same edit under a new ID.",
          ...identityLines(identity),
        ] };
    }
    if (code === "cli_unavailable") {
      return { tone: "error", mayRetry: true, title: "The Gateway CLI did not start: nothing was written.",
        details: [`Reason: ${reasonCode ?? "not reported"}.`, ...identityLines(identity)] };
    }
    if (code === "cli_failed") {
      const persisted = error.diagnosticPersisted === true ? "saved on the backend side"
        : error.diagnosticPersisted === false ? "not saved on the backend side" : "whether it was saved is not reported";
      const reason = error.reason !== null && error.reason !== undefined ? error.reason
        : error.reasonOmitted === true ? "omitted: it came as free text" : "not reported";
      return { tone: "error", mayRetry: true,
        title: `Not saved: the Gateway CLI ended with an error (${reasonCode ?? "reason not reported"}).`,
        details: [
          `CLI: exit code ${error.exitCode ?? "not reported"}, phase ${error.phase ?? "not reported"}.`,
          `Diagnostics: ${error.diagnosticId ?? "not reported"} (${persisted}).`,
          `Explanation: ${reason}.`,
          ...identityLines(identity),
        ] };
    }
    return { tone: "error", mayRetry: true, title: `Not saved: ${code}.`,
      details: [`Reason: ${reasonCode ?? "not reported"}.`, ...identityLines(identity)] };
  }

  function describeSaveSuccess(data) {
    const receipt = data?.response ?? {};
    return {
      tone: "note",
      title: `Saved, revision ${receipt.revision ?? "not reported"}. The new memory applies from the next send.`,
      details: [
        ...identityLines(data?.identity),
        `Receipt: ${receipt.receiptId ?? "not reported"}${receipt.replay === true ? " (a replay of the same edit)" : ""}.`,
      ],
    };
  }

  const PASTE_MODES = Object.freeze(["structure-only", "structure-and-memory"]);

  /**
   * Steps of pasting a blueprint. The mode is named explicitly: “structure-only” or
   * “structure-and-memory”; with no mode chosen there are no steps (null). Agents,
   * folder bindings and provider sessions are never copied (Kit v0.15.0) -
   * their steps are dropped. In the mode with memory, each new project or quarter
   * whose source has memory is followed by a step that moves
   * that memory.
   */
  function pasteSteps(steps, { mode }) {
    if (!PASTE_MODES.includes(mode)) return null;
    const out = [];
    for (const step of steps) {
      if (step.kind !== "project" && step.kind !== "quarter") continue;
      out.push(step);
      if (mode === "structure-and-memory" && step.part?.memoryScopeId) {
        out.push({
          kind: "memory", forStepId: step.id, sourceScopeId: step.part.memoryScopeId,
          label: `memory of ${step.kind === "project" ? "project" : "quarter"} ${step.id}`,
        });
      }
    }
    return out;
  }

  /**
   * Pin the sources before the first write: every memory to be moved must
   * have its revision and content read. If even one source is not read,
   * the paste does not start - nothing is created or written yet.
   * `reads`: Map scopeId → { ok, revision, entries } or { ok: false, code }.
   */
  function pinSources(steps, reads) {
    const pinned = new Map();
    const problems = [];
    for (const step of steps) {
      if (step.kind !== "memory") continue;
      const read = reads.get(step.sourceScopeId);
      if (read === undefined || read.ok !== true || !Number.isSafeInteger(read.revision)) {
        problems.push({ scopeId: step.sourceScopeId, code: read?.code ?? "source_unread" });
        continue;
      }
      pinned.set(step.sourceScopeId, { revision: read.revision, entries: read.entries ?? [] });
    }
    return { ok: problems.length === 0, pinned, problems };
  }

  /**
   * The result of one paste step: what to write in its row and whether to go on.
   * There is no rollback - what was created stays created; so any step that
   * failed, was refused or ended with an unknown outcome stops
   * the paste, while an empty memory is an ordinary outcome.
   */
  function pasteStepVerdict(step, response) {
    if (step.kind === "memory") {
      if (response?.ok && response.empty === true) return { proceed: true, state: "empty — nothing to move" };
      if (response?.ok) {
        return { proceed: true, state: `moved, revision ${response.data?.response?.revision ?? "not reported"}` };
      }
      const error = response?.error ?? {};
      if (error.code === "user_declined") return { proceed: false, state: "not moved: confirmation declined" };
      if (error.uncertain === true) return { proceed: false, state: "outcome unknown" };
      return { proceed: false, state: `not moved: ${error.code ?? "error"}` };
    }
    if (response?.ok) return { proceed: true, state: "created" };
    const error = response?.error ?? {};
    if (error.code === "uncertain_outcome") return { proceed: false, state: "outcome unknown" };
    if (error.code === "user_declined") return { proceed: false, state: "not created: confirmation declined" };
    return { proceed: false, state: "not created" };
  }

  const CREATE_WORDS = Object.freeze({ project: "Project", quarter: "Quarter", agent: "Agent" });

  /**
   * The receipt of creating a project, quarter or agent: the exact target, the host operation
   * and the outcome. `reread` - whether to reread the world: after a success and after an unknown
   * outcome (to learn what happened), but not after a refusal before the write.
   */
  function describeCreateOutcome(kind, targetId, response) {
    const word = CREATE_WORDS[kind] ?? kind;
    const identity = response?.ok ? response.data?.identity : response?.identity;
    const operation = `Operation: ${identity?.operationId ?? "not reported"}.`;
    if (response?.ok) {
      return { tone: "note", reread: true, title: `${word} ${targetId} created.`,
        details: [`Outcome: ${response.data?.outcome ?? "not reported"}.`, operation] };
    }
    const error = response?.error ?? {};
    if (error.code === "user_declined") {
      return { tone: "note", reread: false, title: "Confirmation declined: nothing created.", details: [] };
    }
    if (error.code === "uncertain_outcome" || error.uncertain === true) {
      return { tone: "uncertain", reread: true,
        title: `Outcome unknown: ${word.toLowerCase()} ${targetId} may have been created.`,
        details: ["The world is being reread; do not repeat the creation blindly.", operation] };
    }
    if (error.code === "invalid_input") {
      return { tone: "error", reread: false, title: "Not sent: the check before writing refused the target.",
        details: [`Reason: ${error.reasonCode ?? "not reported"}.`] };
    }
    // For an agent, a conflict almost always means a taken name: it stays with the agent in the archive too,
    // including in an archived quarter that the map does not show.
    const taken = kind === "agent" && error.code === "conflict"
      ? ["Most often this is a taken name: agent names are not reused, even after archiving. Choose another one."]
      : [];
    return { tone: "error", reread: false, title: `${word} ${targetId} not created: ${error.code ?? "error"}.`,
      details: [`Reason: ${error.reasonCode ?? "not reported"}.`, ...taken, operation] };
  }

  /**
   * The overall result of a step-by-step copy: complete, partial, unknown or
   * “nothing created”. What was created in a partial outcome stays and is not
   * deleted by itself; an unknown outcome is not repeated.
   */
  function pasteSummary(steps, { done, stoppedAt, uncertain }) {
    const total = steps.length;
    if (stoppedAt === null || stoppedAt === undefined) {
      return { outcome: "complete", title: `Result: complete — ${done} of ${total} done.`, details: [] };
    }
    const at = steps[stoppedAt]?.label ?? `step ${stoppedAt + 1}`;
    if (uncertain) {
      return { outcome: "uncertain", title: `Result: unknown — the outcome at step “${at}” was not observed.`,
        details: [`Done before it: ${done} of ${total}.`, "The step is not repeated: first reread what happened."] };
    }
    if (done === 0) {
      return { outcome: "none", title: `Result: nothing created — stopped at step “${at}”.`, details: [] };
    }
    return { outcome: "partial", title: `Result: partial — ${done} of ${total} done, stopped at step “${at}”.`,
      details: ["What was created stays and is not deleted by itself."] };
  }

  const CONFIGURATION_WORDS = Object.freeze({
    local_config_missing: "Controller not configured: no config/local.json.",
    local_config_unparsable: "config/local.json cannot be read as JSON.",
    config_not_an_object: "config/local.json must be a JSON object.",
    controller_root_missing: "config/local.json does not set controllerRoot.",
    controller_root_not_absolute: "controllerRoot in config/local.json must be an absolute path.",
    expected_workspace_missing: "config/local.json has no expectedWorkspace.",
    expected_project_id_missing: "config/local.json does not set expectedWorkspace.projectId.",
    expected_workspace_hash_invalid: "expectedWorkspace.workspaceRootSha256 must be a SHA-256 (64 characters).",
  });

  /**
   * The state of the one configured controller in the words of the window. No paths:
   * only the reason and what to do, or a safe identity. null - the mode
   * without a controller (the fixture).
   */
  function describeConfiguration(configuration) {
    if (configuration === null || configuration === undefined) return null;
    if (configuration.status === "loaded") {
      const expected = configuration.expectedWorkspace ?? {};
      return { tone: "note", title: `Controller configured: project ${expected.projectId ?? "not reported"}.`,
        details: [`Root fingerprint: ${String(expected.workspaceRootSha256 ?? "").slice(0, 16)}…`,
          "One controller is set before launch; there is no switching in the window."] };
    }
    const code = configuration.reasonCode ?? "unknown";
    return { tone: "error", title: CONFIGURATION_WORDS[code] ?? `Controller configuration refused: ${code}.`,
      details: [`Code: ${code}.`,
        "Fill in config/local.json after the example in config/local.example.json and restart the window."] };
  }

  // Kit v0.16.1: the only public reasons a project folder cannot be read.
  const WORKSPACE_REASONS = Object.freeze({
    workspace_not_bound: "the project folder is not bound — bind it in the project inspector",
    workspace_binding_conflict: "project folder binding conflict — the binding is ambiguous",
    workspace_path_missing: "the bound folder is no longer on disk",
  });

  /**
   * A refusal to read a project folder or file, in words. The reason is only one of the three
   * published ones; without it, or with any other one, the reason is unknown. Neither the path nor
   * the exception text is shown.
   */
  function describeWorkspaceRefusal(error) {
    const code = error?.code ?? "unknown";
    const reason = Object.hasOwn(WORKSPACE_REASONS, error?.reasonCode ?? "") ? WORKSPACE_REASONS[error.reasonCode] : null;
    return {
      tone: "error",
      title: reason === null ? `Unavailable (${code}): the reason is not reported — unknown.` : `Unavailable: ${reason}.`,
      details: reason === null ? ["The backend did not name the reason; the desk does not guess it."] : [`Code: ${code} / ${error.reasonCode}.`],
    };
  }

  /**
   * The outcome of saving a file. keepDirty - the edit stays in the editor (after any
   * refusal and after an unknown outcome); reconcile - a check by reading the file is needed.
   */
  function describeSaveFileOutcome(response) {
    const identity = response?.ok ? response.data?.identity : response?.identity;
    const operation = `Operation: ${identity?.operationId ?? response?.data?.receipt?.operationId ?? "not reported"}.`;
    if (response?.ok) {
      const receipt = response.data.receipt;
      return { tone: "note", keepDirty: false, reconcile: false,
        title: `Saved: ${receipt.bytesWritten} bytes.`,
        details: [`Operation: ${receipt.operationId}.`, `New fingerprint: ${String(receipt.contentSha256).slice(0, 16)}…`] };
    }
    const error = response?.error ?? {};
    if (error.code === "user_declined") {
      return { tone: "note", keepDirty: true, reconcile: false, title: "Confirmation declined: nothing was written.", details: [] };
    }
    if (error.code === "uncertain_outcome" || error.uncertain === true) {
      return { tone: "uncertain", keepDirty: true, reconcile: true,
        title: "Outcome unknown: the write may have happened.",
        details: [`Reason: ${error.reasonCode ?? "not reported"}.`, "The edit stays in the editor. Check by reading the file; do not repeat it blindly.", operation] };
    }
    if (error.code === "stale_revision" || error.code === "conflict") {
      return { tone: "conflict", keepDirty: true, reconcile: false,
        title: "The file changed after it was read: nothing was written.",
        details: ["The edit stays in the editor. Reread the file and decide whether to save over the new version.", operation] };
    }
    if (error.code === "invalid_input") {
      return { tone: "error", keepDirty: true, reconcile: false, title: "Not sent: refused by the check before writing.",
        details: [`Reason: ${error.reasonCode ?? "not reported"}.`] };
    }
    return { tone: "error", keepDirty: true, reconcile: false,
      title: `Not saved: ${error.code ?? "error"}${error.reasonCode ? ` (${error.reasonCode})` : ""}.`,
      details: [error.code === "access_denied"
        ? "The file is outside the project folder, is not UTF-8 text or is larger than 1 MB — the backend does not write it."
        : "The edit stays in the editor.", operation] };
  }

  /**
   * Whether a file can be edited: only one read in full (the base hash is the hash of the whole
   * file) and only when the save operation is declared.
   */
  function canEditFile(pages, saveStatus) {
    const last = Array.isArray(pages) ? pages[pages.length - 1] : undefined;
    if (last === undefined) return { allowed: false, reason: "The file has not been read." };
    if (last.nextCursor !== null || last.range.offsetBytes + last.range.returnedBytes < last.range.totalBytes) {
      return { allowed: false, reason: "Read the whole file first: only the whole file can be edited." };
    }
    if (saveStatus === null || saveStatus === undefined) return { allowed: false, reason: "Whether saving is available has not been checked." };
    if (saveStatus.status !== "available") {
      return { allowed: false, reason: `Saving is unavailable: ${saveStatus.reasonCode ?? saveStatus.status}.` };
    }
    return { allowed: true, reason: null };
  }

  /**
   * The outcome of an atomic copy of a project with memory: a full copy with a receipt for each
   * memory, or “nothing created” (an atomic refusal - not a partial success),
   * or an unknown outcome, which is checked with the same request.
   */
  function describeCopyOutcome(response) {
    const identity = response?.ok ? response.data?.identity : response?.identity;
    if (response?.ok) {
      const receipt = response.data.receipt;
      return { outcome: "complete", reconcile: false,
        title: `Result: complete — project ${receipt.targetProjectId} and its memories copied in one operation.`,
        details: [`Operation: ${receipt.operationId}.`, ...receipt.scopes.map((scope) => (
          `${scope.kind === "project" ? "project" : `quarter ${scope.quarterId}`}: ${scope.sourceScopeId} revision ${scope.sourceRevision} → ${scope.targetScopeId} revision ${scope.targetRevision}`))] };
    }
    const error = response?.error ?? {};
    if (error.code === "uncertain_outcome" || error.uncertain === true) {
      return { outcome: "uncertain", reconcile: true, title: "Result: unknown — the copy may have happened.",
        details: [`Operation: ${identity?.operationId ?? "not reported"}.`, "Check with the same request; a new copy is not sent."] };
    }
    if (error.code === "user_declined") return { outcome: "none", reconcile: false, title: "Confirmation declined: nothing created.", details: [] };
    return { outcome: "none", reconcile: false,
      title: `Result: nothing created — the whole copy was refused (${error.code ?? "error"}${error.reasonCode ? `, ${error.reasonCode}` : ""}).`,
      details: ["The copy is atomic: on a refusal, neither the project nor the quarters appear."] };
  }

  // --- ID of a new copy (U07): a suggestion the person can replace -------------------

  const COPY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

  /** A free suggested ID: “-copy” (and a number) is added to the original. */
  function freeIdentifier(base, taken) {
    let candidate = `${base}-copy`;
    let index = 2;
    while (taken.has(candidate)) {
      candidate = `${base}-copy-${index}`;
      index += 1;
    }
    taken.add(candidate);
    return candidate;
  }

  /**
   * The paste plan: what will be created and where. The root of the new copy gets
   * `rootId` if the person chose it, otherwise the suggestion `…-copy`.
   * The nested quarters of the project get suggested IDs; agents
   * are listed only to be skipped. `taken` - the sets of taken
   * projects/quarters/agents; the function works on a copy of them.
   */
  function buildPastePlan(blueprint, target, taken, { rootId = null } = {}) {
    const used = {
      projects: new Set(taken.projects), quarters: new Set(taken.quarters), agents: new Set(taken.agents),
    };
    const steps = [];
    const agentSteps = (parts, projectId, quarterId) => {
      for (const part of parts) {
        const id = freeIdentifier(part.sourceId, used.agents);
        steps.push({ kind: "agent", id, projectId, quarterId, part, label: `agent ${id}`,
          node: { kind: "agent", projectId, quarterId, agentId: id } });
      }
    };
    if (blueprint.kind === "project") {
      const suggestedRootId = freeIdentifier(blueprint.root.sourceId, new Set(used.projects));
      const projectId = rootId ?? suggestedRootId;
      used.projects.add(projectId);
      steps.push({ kind: "project", id: projectId, part: blueprint.root, label: `project ${projectId}`,
        node: { kind: "project", projectId, quarterId: null, agentId: null } });
      for (const quarter of blueprint.root.children) {
        const quarterId = freeIdentifier(quarter.sourceId, used.quarters);
        steps.push({ kind: "quarter", id: quarterId, projectId, part: quarter, label: `quarter ${quarterId}`,
          node: { kind: "quarter", projectId, quarterId, agentId: null } });
        agentSteps(quarter.children, projectId, quarterId);
      }
      return { steps, into: "into the world", rootKind: "project", suggestedRootId, rootId: projectId, projectId };
    }
    if (blueprint.kind === "quarter") {
      const projectId = target.projectId ?? blueprint.sourceProjectId;
      if (projectId === null || projectId === undefined) return { steps: [], into: null };
      const suggestedRootId = freeIdentifier(blueprint.root.sourceId, new Set(used.quarters));
      const quarterId = rootId ?? suggestedRootId;
      used.quarters.add(quarterId);
      steps.push({ kind: "quarter", id: quarterId, projectId, part: blueprint.root, label: `quarter ${quarterId}`,
        node: { kind: "quarter", projectId, quarterId, agentId: null } });
      agentSteps(blueprint.root.children, projectId, quarterId);
      return { steps, into: `into project ${projectId}`, rootKind: "quarter", suggestedRootId, rootId: quarterId, projectId };
    }
    const projectId = target.projectId ?? blueprint.sourceProjectId;
    const quarterId = target.quarterId ?? blueprint.sourceQuarterId;
    if (projectId === null || projectId === undefined || quarterId === null || quarterId === undefined) {
      return { steps: [], into: null };
    }
    agentSteps([blueprint.root], projectId, quarterId);
    return { steps, into: `into quarter ${quarterId} of project ${projectId}`, rootKind: "agent" };
  }

  /**
   * Whether the new copy can have this name. Empty, invalid by the identifier
   * contract, too long for the identifier of its memory, equal to the
   * source or already taken - a refusal before any write and before the confirmation.
   * The last guard against a race stays with the backend.
   */
  function validateCopyTarget({ value, kind, sourceId, projectId = null, taken }) {
    const id = typeof value === "string" ? value.trim() : "";
    const refuse = (reason, text) => ({ ok: false, reason, text, id });
    if (id === "") return refuse("empty", "Enter an ID for the new copy.");
    if (!COPY_ID.test(id)) {
      return refuse("invalid", "Invalid ID: a letter or digit first, then letters, digits, “.”, “_”, “:”, “-”, up to 160 characters.");
    }
    const scopeId = kind === "project" ? `${id}-memory` : `${projectId}-${id}-memory`;
    if (!COPY_ID.test(scopeId)) {
      return refuse("too_long", `Too long: the memory ID of the new copy (${scopeId.length} characters) is over 160.`);
    }
    if (id === sourceId) return refuse("same_as_source", "Same as the source: the copy needs a new ID.");
    const pool = kind === "project" ? taken.projects : taken.quarters;
    if (pool.has(id)) return refuse("occupied", `ID ${id} is already taken.`);
    return { ok: true, reason: null, text: null, id };
  }

  return {
    freeIdentifier, buildPastePlan, validateCopyTarget,
    describeWorkspaceRefusal, describeSaveFileOutcome, canEditFile, describeCopyOutcome,
    entryProblems, describeProblem, describeSaveFailure, describeSaveSuccess, pasteSteps, pasteStepVerdict,
    pinSources, PASTE_MODES, LIMITS, describeCreateOutcome, pasteSummary, describeConfiguration,
  };
}));
