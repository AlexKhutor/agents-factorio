import assert from "node:assert/strict";
import test from "node:test";

import {
  claudeWriteZoneHook, createWriteZone, normalizeWriteZone, readOnlyShellCommand, writeZonesOverlap,
} from "../src/agent-write-zone.mjs";

test("a zone is written as paths inside the project folder", () => {
  assert.deepEqual(normalizeWriteZone([" ./tools/jointsolver/** ", "tools\\ui\\*.py", "tools/ui/*.py", ""]),
    ["tools/jointsolver/**", "tools/ui/*.py"]);
  for (const broken of [[], [""], ["../other/**"], ["C:/work/**"], ["/etc/**"], ["a\u0001b"],
    [`${"x".repeat(201)}`], Array.from({ length: 33 }, (_, index) => `p${index}`), "tools/**", [1]]) {
    assert.throws(() => normalizeWriteZone(broken), { code: "memory_invalid_input" }, JSON.stringify(broken));
  }
});

test("a zone matches its paths, case-blind on Windows, and nothing outside the folder", () => {
  const zone = createWriteZone({ root: "C:\\work\\RobotArm", platform: "win32",
    patterns: ["tools/jointsolver/**", "tools/ui/*.py", "docs/jointsolver.md", "tools/shared"] });
  assert.equal(zone.check("C:\\work\\RobotArm\\tools\\JointSolver\\core\\solve.py").allowed, true);
  assert.equal(zone.check("tools/ui/panel.py").allowed, true);
  assert.equal(zone.check("tools/ui/widgets/panel.py").allowed, false);
  assert.equal(zone.check("docs/jointsolver.md").allowed, true);
  assert.equal(zone.check("tools/shared/math.py").allowed, true);
  assert.equal(zone.check("tools/sharedness.py").allowed, false);
  assert.deepEqual(zone.check("C:\\elsewhere\\x.py"), { allowed: false, relative: null });
  assert.deepEqual(zone.check("C:\\work\\RobotArm"), { allowed: false, relative: null });
});

test("zones that cannot share a file do not overlap; anything that might, does", () => {
  assert.equal(writeZonesOverlap(["tools/jointsolver/**"], ["tools/ui/**"]), false);
  assert.equal(writeZonesOverlap(["tools/jointsolver/**"], ["docs/memory/**"]), false);
  assert.equal(writeZonesOverlap(["docs/jointsolver.md"], ["docs/memory/**"]), false);
  assert.equal(writeZonesOverlap(["tools/**"], ["tools/ui/**"]), true);
  assert.equal(writeZonesOverlap(["tools/ui/*.py"], ["tools/ui/assets/**"]), true);
  assert.equal(writeZonesOverlap(["**/*.md"], ["tools/ui/**"]), true);
  assert.equal(writeZonesOverlap(["tools/joint*/**"], ["tools/ui/**"]), true);
  assert.equal(writeZonesOverlap(["Tools/UI/**"], ["tools/ui/x.py"], "win32"), true);
  assert.equal(writeZonesOverlap(["Tools/UI/**"], ["tools/ui/x.py"], "linux"), false);
});

test("the Claude Code hook refuses edits outside the zone and sends changing commands to the person", async () => {
  const hook = claudeWriteZoneHook({ root: "C:\\work\\RobotArm", platform: "win32", patterns: ["tools/jointsolver/**"] });
  assert.deepEqual(await hook({ tool_name: "Edit", tool_input: { file_path: "C:\\work\\RobotArm\\tools\\jointsolver\\a.py" } }), {});
  const outside = await hook({ tool_name: "Write", tool_input: { file_path: "C:\\work\\RobotArm\\tools\\ui\\panel.py" } });
  assert.equal(outside.hookSpecificOutput.permissionDecision, "deny");
  assert.match(outside.hookSpecificOutput.permissionDecisionReason, /tools\/ui\/panel\.py" is outside your write zone/u);
  const away = await hook({ tool_name: "NotebookEdit", tool_input: { notebook_path: "D:\\x.ipynb" } });
  assert.match(away.hookSpecificOutput.permissionDecisionReason, /outside the project folder/u);
  assert.equal((await hook({ tool_name: "Edit", tool_input: {} })).hookSpecificOutput.permissionDecision, "deny");
  // A command that only reads is left to the permission mode; one that may write goes to the person.
  assert.deepEqual(await hook({ tool_name: "Bash", tool_input: { command: "cd \"F:/x\" && ls -la && git status" } }), {});
  assert.equal((await hook({ tool_name: "Bash", tool_input: { command: "mv a.py tools/ui/" } }))
    .hookSpecificOutput.permissionDecision, "ask");
  assert.deepEqual(await hook({ tool_name: "Read", tool_input: { file_path: "C:\\work\\RobotArm\\tools\\ui\\panel.py" } }), {});
});

test("in the auto and bypass modes commands are the mode's; edits outside the zone stay refused", async () => {
  for (const permissionMode of ["auto", "bypassPermissions"]) {
    const hook = claudeWriteZoneHook({ root: "C:\\work\\RobotArm", platform: "win32", patterns: ["docs/memory/**"],
      permissionMode });
    assert.deepEqual(await hook({ tool_name: "Bash", tool_input: { command: "mv a b" } }), {}, permissionMode);
    const edit = await hook({ tool_name: "Edit", tool_input: { file_path: "C:\\work\\RobotArm\\tools\\a.py" } });
    assert.equal(edit.hookSpecificOutput.permissionDecision, "deny", permissionMode);
  }
  for (const permissionMode of ["default", "acceptEdits"]) {
    const hook = claudeWriteZoneHook({ root: "C:\\work\\RobotArm", platform: "win32", patterns: ["docs/memory/**"],
      permissionMode });
    assert.equal((await hook({ tool_name: "Bash", tool_input: { command: "touch x" } }))
      .hookSpecificOutput.permissionDecision, "ask", permissionMode);
    assert.deepEqual(await hook({ tool_name: "Bash", tool_input: { command: "pwd" } }), {}, permissionMode);
  }
});

test("a command counts as reading only when every part of it reads and nothing is written or run", () => {
  for (const command of ["ls -la", "cd \"F:/Tools/x y\" && pwd && ls -la && git status",
    "git log --oneline -n 20 2>/dev/null", "git -C repo status", "find . -name .git -not -path \"./a*\" 2>/dev/null | sort | head -60",
    "grep -o \"a|b\" file.txt", "du -sh tools docs 2>&1", "cat README.md | wc -l", "echo \"== a > b ==\""]) {
    assert.equal(readOnlyShellCommand(command), true, command);
  }
  for (const command of ["echo hi > out.txt", "cat a >> b", "find . -name '*.pyc' -delete", "find . -exec rm {} ;",
    "sort -o out.txt in.txt", "git diff --output=patch.diff", "git commit -m x", "git push", "rm -rf build",
    "mv a b", "python build.py", "ls $(cat list)", "ls `pwd`", "for d in a b; do ls $d; done", "X=1 ls", "",
    "cat <(ls)", "tree -o out.txt", "sed -i s/a/b/ f", "npm install"]) {
    assert.equal(readOnlyShellCommand(command), false, command);
  }
  assert.equal(readOnlyShellCommand("Get-ChildItem -Recurse | Select-String foo 2>$null", { powershell: true }), true);
  assert.equal(readOnlyShellCommand("Get-Content a.txt | Out-File b.txt", { powershell: true }), false);
  assert.equal(readOnlyShellCommand("Remove-Item build -Recurse", { powershell: true }), false);
});
