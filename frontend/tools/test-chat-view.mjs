// PROTOTYPE. The conversation as a chat: parsing markdown and splitting a turn into “message —
// work — answer”. Both parts are pure (markdown-core.js, feed-core.js), so they
// are checked without a window. Parsing the run log (transcript.mjs) is checked
// here too: it decides what the feed calls an action, thinking and
// an internal call.

import { createRequire } from "node:module";
import { describeServiceCall, parseRunLog } from "../src/paperclip/transcript.mjs";

const require = createRequire(import.meta.url);
const { parseMarkdown, parseInline, firstPlainLine } = require("../src/renderer/markdown-core.js");
const {
  liveItemKind, liveItemBody, liveTurnSegments, workSummary, durationWords, questionEntries,
} = require("../src/renderer/feed-core.js");

const cases = [];
const check = (caseId, condition, detail) => {
  cases.push({ caseId, status: condition ? "passed" : "failed", ...(condition ? {} : { detail }) });
};
const kinds = (nodes) => nodes.map((node) => node.kind).join(",");
const plain = (tokens) => tokens.map((token) => (token.kind === "text" || token.kind === "code" ? token.text : plain(token.children))).join("");

// --- markdown ---------------------------------------------------------------------------

{
  const inline = parseInline("File `a_b.txt` is **ready**, see [report](https://example.test/r) and *details*.");
  check("inline-code-bold-link-italic", kinds(inline) === "text,code,text,strong,text,link,text,em,text"
    && inline[1].text === "a_b.txt" && inline[5].href === "https://example.test/r" && plain(inline[5].children) === "report", inline);
  check("underscores-in-names-are-not-italic", kinds(parseInline("path my_file_name.py and __init__")) !== ""
    && plain(parseInline("path my_file_name.py")) === "path my_file_name.py", parseInline("path my_file_name.py"));
  check("multiplication-asterisks-are-not-italic", kinds(parseInline("2 * 3 * 4")) === "text", parseInline("2 * 3 * 4"));
  check("markup-inside-code-is-not-parsed", parseInline("`**not bold**`")[0].text === "**not bold**");
}

{
  const blocks = parseMarkdown([
    "# Result", "", "First paragraph", "in two lines.", "",
    "- item one", "- item two", "  - nested", "1. first", "2) second", "",
    "| Check | Result |", "| --- | :---: |", "| Memory | `PASS` |", "| Agent \\| two | FAIL |", "",
    "```js", "const a = 1;", "| not | a table |", "```", "", "> quote", "> second line", "", "---", "The end.",
  ].join("\n"));
  check("blocks-recognized", kinds(blocks) === "heading,paragraph,list,table,code,quote,rule,paragraph", kinds(blocks));
  check("paragraph-keeps-line-break", plain(blocks[1].inline) === "First paragraph\nin two lines.", blocks[1]);
  const list = blocks[2];
  check("list-with-nesting-and-numbers", list.items.length === 5 && list.items[2].depth === 1 && list.items[0].marker === "•"
    && list.items[3].marker === "1." && list.items[4].marker === "2.", list.items);
  const table = blocks[3];
  check("table-with-code-and-pipe-in-cell", table.head.length === 2 && table.rows.length === 2
    && table.rows[0][1][0].kind === "code" && plain(table.rows[1][0]) === "Agent | two", table);
  check("code-is-not-parsed-as-markup", blocks[4].language === "js" && blocks[4].text === "const a = 1;\n| not | a table |", blocks[4]);
  check("quote-parsed-inside", blocks[5].blocks[0].kind === "paragraph" && plain(blocks[5].blocks[0].inline) === "quote\nsecond line", blocks[5]);
  check("unclosed-code-block-runs-to-the-end", parseMarkdown("```\nstill\ngoing").at(-1).text === "still\ngoing");
  check("plain-text-stays-text", kinds(parseMarkdown("Just words.\n\nMore words.")) === "paragraph,paragraph");
  check("first-line-without-markup", firstPlainLine("## Made **these changes**\n\nnext") === "Made these changes"
    && firstPlainLine("- `a.txt` created") === "a.txt created", firstPlainLine("## Made **these changes**"));
  check("empty-text-empty-tree", parseMarkdown("").length === 0 && parseMarkdown(null).length === 0);
}

// --- turn as a chat -----------------------------------------------------------------------

const item = (contentClass, text, extra = {}) => ({ contentClass, text, visibility: "user-visible", omissionReason: null, ...extra });
const hidden = { contentClass: "omitted", text: null, visibility: "omitted", omissionReason: "hidden_reasoning" };
{
  const turn = [
    item("user-message", "Make a file"),
    hidden,
    item("assistant-message", "Looking at the folder."),
    item("tool-summary", "$ ls\n\na.txt"),
    item("tool-summary", "Thinking\n\nNeed to create **b.txt**."),
    item("change-summary", "Write b.txt"),
    item("assistant-message", "Done: created `b.txt`."),
    item("tool-summary", "Internal · Paperclip: task status → done"),
  ];
  check("entry-kinds", turn.map(liveItemKind).join(",") === "user,hidden-reasoning,agent,action,reasoning,change,agent,service", turn.map(liveItemKind));
  check("body-of-thinking-and-internal-line", liveItemBody(turn[4]) === "Need to create **b.txt**."
    && liveItemBody(turn[7]) === "Paperclip: task status → done");
  const done = liveTurnSegments(turn, "completed");
  check("finished-turn-message-work-answer", done.map((segment) => segment.kind).join(",") === "user,work,answer,work"
    && done[1].items.length === 5 && done[2].item.text.startsWith("Done") && done[3].items.length === 1, done.map((segment) => segment.kind));
  check("work-line", workSummary(done[1].items) === "1 action · 1 change · thinking", workSummary(done[1].items));
  check("internal-calls-are-not-counted-as-actions", workSummary(done[3].items) === "internal calls", workSummary(done[3].items));
  const going = liveTurnSegments(turn.slice(0, 4), "active");
  check("running-turn-has-no-answer", going.map((segment) => segment.kind).join(",") === "user,work" && going[1].items.length === 3, going);
  const cut = liveTurnSegments([turn[0], turn[2], turn[3]], "interrupted");
  check("turn-interrupted-on-an-action-has-no-answer", cut.map((segment) => segment.kind).join(",") === "user,work", cut);
  const asked = liveTurnSegments([turn[0], item("assistant-message", "I will clarify."), item("interaction-summary", "Question: color?")], "completed");
  check("question-visible-outside-folded-work", asked.map((segment) => segment.kind).join(",") === "user,work,question", asked);
  const answered = questionEntries("You answered the agent's questions:\n· Which language?\n  → Python\n· A → B?\n  → yes, A → B");
  check("question-and-answer-parsed", answered !== null && answered.state === "answered"
    && answered.head === "You answered the agent's questions" && answered.entries.length === 2
    && answered.entries[0].question === "Which language?" && answered.entries[0].answer === "Python"
    && answered.entries[1].question === "A → B?" && answered.entries[1].answer === "yes, A → B", answered);
  const open = questionEntries("The agent asks:\n· Which color?");
  check("open-question-without-answer", open?.state === "asking" && open.entries[0].answer === null, open);
  check("other-summary-is-not-question-with-answer", questionEntries("Asking for permission to run npm test.") === null
    && questionEntries("The agent's question was left unanswered:") === null);
  const withQuestion = liveTurnSegments([turn[0], item("interaction-summary", "You answered the agent's questions:\n· Which language?\n  → Python"),
    item("assistant-message", "Python is a good choice.")], "completed");
  check("answer-to-question-apart-from-agent-answer", withQuestion.map((segment) => segment.kind).join(",") === "user,question,answer",
    withQuestion.map((segment) => segment.kind));
  check("action-plurals", workSummary([turn[3], turn[3], turn[3], turn[3], turn[3]]) === "5 actions"
    && workSummary([turn[3], turn[3]]) === "2 actions");
  check("turn-duration", durationWords("2026-09-30T10:00:00Z", "2026-09-30T10:01:11Z") === "1 min 11 s"
    && durationWords("2026-09-30T10:00:00Z", "2026-09-30T10:00:12Z") === "12 s" && durationWords("2026-09-30T10:00:00Z", null) === null);
}

// --- run log ------------------------------------------------------------------------------

const stdout = (records) => `${JSON.stringify({ ts: "2026-09-30T10:00:05.000Z", stream: "stdout", chunk: `${records.map((record) => JSON.stringify(record)).join("\n")}\n` })}\n`;
{
  const comment = "PAPERCLIP_API_BASE=\"${PAPERCLIP_API_URL%/}\"\ncurl -s -X POST -H \"Authorization: ***REDACTED***\" -d '{\"body\":\"noted\"}' \"$PAPERCLIP_API_BASE/api/issues/$PAPERCLIP_TASK_ID/comments\"";
  const status = "curl -s -X PATCH -d '{\"status\":\"done\"}' \"$PAPERCLIP_API_BASE/api/issues/$PAPERCLIP_TASK_ID\"";
  check("internal-call-named-in-words", describeServiceCall(comment) === "Paperclip: comment in the task"
    && describeServiceCall(`${comment}\n${status}`) === "Paperclip: comment in the task, task status → done"
    && describeServiceCall("ls -la") === null && describeServiceCall("curl https://example.test") === null,
  [describeServiceCall(comment), describeServiceCall(`${comment}\n${status}`)]);

  // One terminal call in ACP is named three times: "Terminal", the command itself, "Terminal" again.
  const call = (name, extra = {}) => ({ type: "acpx.tool_call", name, toolCallId: "c1", ...extra });
  const work = parseRunLog(stdout([
    { type: "acpx.text_delta", text: "Need to look at ", channel: "thought" }, { type: "acpx.text_delta", text: "the folder.", channel: "thought" },
    call("Terminal", { status: "pending" }), call("ls -la"), call("Terminal"),
    call("Terminal", { status: "completed", text: "tool call (completed): ```console\na.txt\nb.txt\n```" }),
    { type: "acpx.tool_call", name: "Terminal", toolCallId: "c2", status: "pending" },
    { type: "acpx.tool_call", name: status, toolCallId: "c2" },
    { type: "acpx.tool_call", name: "Terminal", toolCallId: "c2", status: "completed", text: "tool call (completed): ```console\n{\"id\":\"x\"}\n```" },
    { type: "acpx.text_delta", text: "The folder has two files.", channel: "output" },
  ]));
  check("acp-thinking-command-internal-call-answer", work.map((entry) => entry.kind).join(",") === "thinking,tool,service,assistant"
    && work[0].text === "Need to look at the folder." && work[1].text === "$ ls -la\n\na.txt\nb.txt"
    && work[2].text === "Paperclip: task status → done" && work[3].text === "The folder has two files.", work);

  const cli = parseRunLog(stdout([
    { type: "assistant", message: { content: [{ type: "thinking", thinking: "", signature: "s" }, { type: "thinking", thinking: "I will check first." },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: status } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "{\"id\":\"x\"}" }] } },
  ]));
  check("cli-empty-thinking-is-a-marker-non-empty-is-text", cli.map((entry) => entry.kind).join(",") === "thinking,thinking,service"
    && cli[0].text === null && cli[1].text === "I will check first." && cli[2].text === "Paperclip: task status → done", cli);
}

const failed = cases.filter((entry) => entry.status === "failed");
process.stdout.write(`${JSON.stringify({
  suite: "chat-view",
  status: failed.length === 0 ? "passed" : "failed",
  passedCount: cases.length - failed.length,
  failedCount: failed.length,
  cases,
}, null, 2)}\n`);
process.exitCode = failed.length === 0 ? 0 : 1;
