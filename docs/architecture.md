# Architecture and contribution guide

VeriForge separates agent behavior from local recordkeeping and external tool execution. The distributable unit is `skills/qa-workflow/`. The repository contains its tests, packaging and contributor documentation; users' testing workspaces and credentials live elsewhere.

## Layers

| Layer | Responsibility | Entry |
| --- | --- | --- |
| Agent guidance | Natural conversation, stage selection, clarification, evidence and authorization boundaries | SKILL.md → references/ |
| Domain records | Projects, requirements, shared revisions, tasks, facts, artifacts, results and follow-ups | runtime.mjs |
| Project context | Relevant historical business/API retrieval plans, sourced facts, conflicts | context.mjs |
| Actions | Persist intent, resource ownership, source pins, dispatch, receipts and pending confirmations | actions.mjs |
| External calls | Bounded same-origin configured HTTP; host-native MCP for browser, Mind and knowledge | http.mjs + host |
| Reuse and evidence | Scoped UI contracts, deterministic screenshot annotation, local BUG drafts | modules.mjs, annotate.mjs, bugs.mjs |
| Storage | Atomic JSON replacement, version hashes, archive verification and restore review | store.mjs, archive.mjs |
| Private values | Repository-external, scoped AES-GCM records; no public secret-read CLI | vault.mjs |

The public CLI accepts a single JSON request on stdin or through a request file. stdout is one JSON result. Human-readable explanations belong to the Agent. Errors avoid dumping request bodies or credentials.

## Identity and concurrency

A workspace has an immutable logical ID. Projects contain systems; requirements reference the relevant systems. The same requirement identifier may exist in different projects. Shared definitions pin a specific revision and scope; configuration overrides are explicit.

Writes use a workspace lock and expected revisions. Tasks pin their input artifacts and shared versions. Resource records coordinate callers using this protocol, not arbitrary processes; no OS-level ownership of a browser is claimed. Unknown external outcomes remain pending until reconciled. A restored workspace remains execution-disabled until review, and no historical mutation is replayed automatically.

## Storage and retention

New records use schema 3. Existing schemas 1 and 2 are verified with their original numeric lexemes and Unicode ordering before conversion. Unsupported numeric precision fails explicitly. Reading old data never migrates it. The upgrade changes the workspace root marker, retains history and does not rewrite unrelated old artifacts.

Snapshots are content-addressed and immutable. Backups include managed records and registered snapshots with a manifest, integrity hashes and explicit exclusions. The archive is bounded and rejects path traversal, duplicate entries and symbolic links. This is local preservation, not an offsite backup service or a zero-loss guarantee.

## Extending integrations

1. Keep instance URLs, project IDs, accounts and field mappings in a user workspace, not source code.
2. Model read and write effects accurately. Persist intent before a write and use actual readback to establish its outcome.
3. Retain provider confirmation IDs and version checks; do not translate a network error into “not applied”.
4. Test with a local synthetic server or immutable fixtures. Never let the default suite contact real business services.
5. Keep case-specific business assertions out of general UI action modules. Reuse requires scope and current-page verification.
6. Add source links and evidence for supported host capabilities; do not claim compatibility based solely on a standard directory layout.

## Development

Use Node.js 20.19+ and the committed lockfile. Run `npm ci`, `npm test`, `npm run validate`, then `npm run build`. `tools/verify-bundle.mjs` installs the extracted Skill in a temporary directory and runs CLI walkthroughs without the development checkout's dependencies.

Keep synthetic data marked. Keep contributor notes free of personal account information and organization-specific incidents. Public archives are built from a strict allowlist and do not include `.git`, local material, cached dependencies or user workspaces. Scope limitations and user-facing setup belong in README and the reference guides.
