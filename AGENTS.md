# VeriForge contributor rules

- Build a general-purpose testing Skill. Keep organization names, business tickets, credentials, internal hosts and personal machine paths out of public source, examples, screenshots and release bundles.
- Use JavaScript (Node.js 20.19+). Preserve supported workspace formats and history; validate migration with synthetic fixtures. Do not require a Python runtime.
- Work only on main. Do not create branches or worktrees unless explicitly requested. Preserve unrelated changes; commit and push reviewed milestones without force-pushing.
- The user authorized continuous implementation through a test-ready candidate. Finish local implementation, fixtures, tests, packaging and public documentation. Real business mutations, global installation and public release require their own scope.
- Do not start sub-agents or new chats without explicit authorization. Do not send messages to others without explicit instructions.
- Keep user data separate from installed Skill code. Credentials belong in an encrypted private store outside the repository/workspace; ordinary state holds references only. Do not echo secrets or include the vault in normal backups.
- Query relevant historical business knowledge proactively during project onboarding, analysis, case design and investigation. Use interface knowledge for fields, samples and dependencies. Preserve scope, provenance, version, confidence and unresolved conflicts; never infer that an old sample is a current business result.
- Clarify until the requirements support meaningful test scenarios, without endless questioning. Group cases by independent business scenarios; number steps within each scenario. Respect user formats and preserve executable steps.
- Prefer host-native MCP. Browser work defaults to a dedicated headless Chrome; do not switch to visible mode without explicit instruction. Do not bypass the tested UI with business writes.
- Persist intent before external mutations. Unknown results require reconciliation, not blind retries. Keep execution, business verdict, synchronization and restoration separate.
- BUGs are concise and reproducible; UI defects include annotated real screenshots. Default severity/priority are 3 unless overridden. Submit/close within scope through the configured API, then read back fields and attachments.
- Keep stages, artifacts, follow-ups and sources durable. Final business knowledge is normally published after release and confirmed short-term stability. Stage closeout does not erase unfinished work.
- Run meaningful Node tests and bundle validation. Report simulated checks, real tool observations and actual business acceptance separately. Do not claim untested host compatibility.
