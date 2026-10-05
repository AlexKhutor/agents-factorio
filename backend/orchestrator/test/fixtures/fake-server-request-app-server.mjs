import readline from "node:readline";

const responses = [];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function emitServerRequest(params) {
  const request = {
    id: params.requestId,
    method: params.requestMethod,
    params: params.requestParams ?? {},
  };
  send(request);
  if (params.duplicate === true) send(request);
  if (Number.isSafeInteger(params.resolveAfterMs)) {
    setTimeout(() => {
      const notification = {
        method: "serverRequest/resolved",
        params: { threadId: params.threadId ?? "thread_fixture", requestId: params.requestId },
      };
      send(notification);
      if (params.duplicateResolved === true) send(notification);
    }, params.resolveAfterMs);
  }
  if (Number.isSafeInteger(params.exitAfterMs)) {
    setTimeout(() => process.exit(17), params.exitAfterMs);
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (!message.method) {
    responses.push(structuredClone(message));
    return;
  }

  const { id, method, params = {} } = message;
  if (method === "initialized") return;
  if (method === "initialize") {
    send({ id, result: {
      userAgent: "fake-server-request-app-server/0.1.0",
      serverInfo: { name: "fake-server-request-app-server", version: "0.1.0" },
    } });
    return;
  }
  if (method === "test/emit") {
    send({ id, result: {} });
    setTimeout(() => emitServerRequest(params), params.emitAfterMs ?? 0);
    return;
  }
  if (method === "test/responses") {
    send({ id, result: { responses: structuredClone(responses) } });
    return;
  }
  if (method === "test/clear") {
    responses.length = 0;
    send({ id, result: {} });
    return;
  }
  send({ id, error: { code: -32601, message: `Unsupported fixture method: ${method}` } });
});
