import { collectVerifiedReports } from "./control-report-collector.mjs";

export const REPORT_OPERATIONS = Object.freeze([
  "accept",
  "show",
  "summarize",
  "review",
  "import-only",
]);

export function validateReportOperation(value) {
  const operation = String(value ?? "").trim().toLowerCase();
  if (!REPORT_OPERATIONS.includes(operation)) {
    const error = new Error(`Unsupported report operation '${value}'`);
    error.code = "REPORT_OPERATION_UNSUPPORTED";
    error.availableOperations = [...REPORT_OPERATIONS];
    throw error;
  }
  return operation;
}

function itemDescriptor(item) {
  return {
    sourceId: item.sourceId,
    taskId: item.taskId,
    reportId: item.reportId,
    status: item.reportStatus,
    state: item.state,
    path: item.reportPath,
    sha256: item.reportSha256,
    sourceRevision: item.sourceRevision,
  };
}

export class ReportOperationService {
  constructor({
    cycle,
    controllerRoot,
    collector,
    presentation,
    collectReports = collectVerifiedReports,
    logger = async () => {},
  } = {}) {
    if (!cycle) throw new Error("ReportOperationService requires a control cycle");
    if (!controllerRoot) throw new Error("ReportOperationService requires controllerRoot");
    this.cycle = cycle;
    this.controllerRoot = controllerRoot;
    this.collector = collector;
    this.presentation = presentation;
    this.collectReports = collectReports;
    this.logger = logger;
  }

  async listModels() {
    if (!this.presentation) throw new Error("Report presentation provider is not configured");
    return this.presentation.listModels();
  }

  async #import(sourceId, taskId) {
    const reports = await this.collectReports({
      controllerRoot: this.controllerRoot,
      collector: this.collector,
      sourceId,
      taskId,
      logger: this.logger,
    });
    if (reports.length > 0) await this.cycle.enqueueReports(reports);
    else await this.cycle.writeProjection();
    const snapshot = await this.cycle.store.snapshot({ eventLimit: 0 });
    const matches = snapshot.items.filter((item) => item.sourceId === sourceId && item.taskId === taskId);
    if (matches.length !== 1) {
      const error = new Error(`Expected one imported report for ${sourceId}/${taskId}, found ${matches.length}`);
      error.code = matches.length === 0 ? "REPORT_NOT_IMPORTED" : "REPORT_AMBIGUOUS";
      throw error;
    }
    return matches[0];
  }

  async execute(operationValue, {
    sourceId,
    taskId,
    includeContent = false,
    model,
    reasoningEffort,
    language = "English",
    refresh = false,
    acceptanceRoot,
  } = {}) {
    const operation = validateReportOperation(operationValue);
    await this.logger("report_operation_started", { operation, sourceId, taskId });
    const imported = await this.#import(sourceId, taskId);
    let result;
    if (operation === "import-only") {
      result = { operation, action: "imported", report: itemDescriptor(imported) };
    } else if (operation === "accept") {
      const accepted = await this.cycle.acceptReport({ sourceId, taskId, acceptanceRoot });
      result = {
        operation,
        action: accepted.action,
        idempotent: accepted.idempotent,
        report: itemDescriptor(accepted.item),
        acceptance: accepted.acceptance ?? null,
        checks: accepted.checks ?? [],
      };
    } else if (operation === "show") {
      if (!this.presentation) throw new Error("Report presentation service is not configured");
      const shown = await this.presentation.show({ sourceId, taskId });
      result = {
        operation,
        action: "shown",
        report: {
          sourceId,
          taskId,
          title: shown.title,
          state: shown.taskState,
          path: shown.path,
          sha256: shown.sha256,
          bytes: shown.bytes,
        },
        ...(includeContent ? { content: shown.text } : {}),
      };
    } else if (operation === "summarize") {
      if (!this.presentation) throw new Error("Report presentation service is not configured");
      const summary = await this.presentation.summarize({
        sourceId,
        taskId,
        model,
        reasoningEffort,
        language,
        refresh,
      });
      result = { operation, action: "summarized", report: itemDescriptor(imported), derivative: summary };
    } else {
      const reviewed = await this.cycle.runOnce({ sourceId, taskId });
      result = {
        operation,
        action: reviewed.action,
        report: itemDescriptor(reviewed.item ?? imported),
        decision: reviewed.decision
          ? {
            outcome: reviewed.decision.outcome,
            path: reviewed.item?.decisionReference ?? imported.decisionPath,
          }
          : null,
      };
    }
    await this.logger("report_operation_completed", {
      operation,
      sourceId,
      taskId,
      action: result.action,
    });
    return result;
  }
}
