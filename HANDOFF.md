# VeriForge continuation

Current target: 0.4.0-rc.2, a test-ready candidate. Read README.md for user-facing scope, docs/architecture.md for implementation boundaries, and docs/testing.md for real-agent acceptance. Runtime commands are JavaScript on Node.js 20.19+.

Workspaces, artifacts and private credentials are separate from the Skill. Historical business context is proactively retrieved when relevant, with source, project and version boundaries. Host-native MCP performs browser, Mind and knowledge operations; local action plans and state changes are not external execution evidence.

Continue with the recorded candidate validation results, then perform only the specifically authorized real-agent/tool tests. Do not infer business success, global installation or public release from local tests. Follow AGENTS.md for contributor rules and main-only collaboration.

Round 1 completed with four independent chats. See docs/acceptance-round-01.md and docs/validation-0.4.0-rc.2.json. Three delivery defects were fixed and checked using actual saved results; page-step and generated-helper corrections followed explicit user-style feedback. Do not describe this as a fresh, fully unaided end-to-end pass of the patched Skill. Next acceptance should cover another host and explicitly scoped external writes. Private transcripts and business materials are not part of the repository.
