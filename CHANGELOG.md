# Changelog

Agents Factorio is under active development; each public update gets an entry
here, newest first.

## 2026-10-06 - first public release

The first public version of the system its author has been using daily:

- **Atlas v0.30.0** - the Electron desktop app: strategy map (World → Project →
  Quarter → Agent), live agent chats with thinking blocks and tool calls,
  steering and queueing, questions with single and multiple choice, permission
  modes per agent, plan usage menu, memory documents with approval, agent
  history (per-turn commits), project and quarter leads.
- **Application Gateway v0.146.0** - hosts Claude Code agents through the Claude
  Agent SDK: project, quarter and agent memory; write zones enforced by a
  pre-tool hook; permission modes (manual, accept edits, auto, bypass); one git
  commit per agent turn; plan usage meter; operation journal with receipts.
- **Controller template v0.42.0** - a clean instance to copy: Gateway tools,
  control cycle, desk-agent task kit and contracts.
- **Frontend Kit v0.21.0** - the backend's accepted delivery, pinned by SHA-256.
