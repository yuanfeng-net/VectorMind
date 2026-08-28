[简体中文](README.md) | **English** | [日本語](README.ja.md) | [한국어](README.ko.md) | [繁體中文](README.zh-TW.md)

# VectorMind MCP

VectorMind is a local project-memory MCP for AI coding assistants. It stores requirements, decisions, reasons for changes, project conventions, and file state inside the project directory, reducing lost context, cross-project contamination, and regressions to obsolete logic during long-running development.

Current version: `1.1.6`

## Core capabilities

- **Restore project context**: retrieve project summaries, requirements, decisions, conventions, and relevant memories for the current goal.
- **Guide requirement clarity**: MCP server instructions remind the AI to act only with complete authorization and to ask the user when authorization is incomplete.
- **Constrain change scope**: check requirement items, planned files, and huge-file governance before editing.
- **Record change intent**: associate changed files, implementation reasons, verification results, and remaining gaps with the corresponding requirement.
- **Manage requirement lifecycles**: support serial tasks, explicitly parallel tasks, resuming completed tasks, and updating verification results.
- **Update authoritative decisions**: new decisions can supersede old requirements or memories so later sessions do not implement outdated rules.
- **Isolate multiple projects**: memories, pending buffers, indexes, and databases are isolated by `project_root`.
- **Read project files safely**: canonical realpath validation prevents symbolic links or junctions from escaping project boundaries.
- **Scan untrusted content and operations**: file, memory, `grep`, and symbol-query results include `security_scan`; only high-confidence sensitive-data exfiltration blocks a concrete operation preflight, while normal documents, articles, test fixtures, and explicit ordinary uploads remain advisory.
- **Prepare secure SSH deployment**: `prepare_secure_ssh` reads server configuration inside the host and returns only target metadata and an SSH config path, never passwords or private keys. It reuses a host SSH key when possible, otherwise creates a temporary Ed25519 key, disables password authentication, and requires the public key to be installed first.
- **Save long-running session checkpoints**: create bounded, versioned checkpoints and restore or compare their context read-only.
- **Diagnose memory quality**: inspect conflicts, duplicates, oversized checkpoints, stale indexes, and orphaned memories.
- **Control context size**: use a compact default tool set and compact output while retaining key IDs and completion states in large results.

See the [full capability matrix (Simplified Chinese)](docs/capability-matrix.md).

## Quick installation

The recommended approach is to send the project URL directly to your AI coding assistant and let it install and configure VectorMind:

```text
Install and configure VectorMind MCP:
https://github.com/yuanfeng-net/VectorMind

Detect the AI coding client I am currently using, complete installation and MCP configuration, and verify that it works.
Do not ask me to run commands manually unless required permissions are unavailable.
```

Usually the GitHub URL plus “install this for me” is enough. The AI can identify the current client, update its MCP configuration, and verify availability without requiring the user to remember commands or edit configuration files manually.

## Manual installation and configuration (optional)

Manual configuration requires Node.js `20.19.0` or later.

Run the MCP directly:

```bash
npx -y @coreyuan/vector-mind
```

Or install it globally:

```bash
npm install -g @coreyuan/vector-mind
```

A global installation provides three commands:

```text
vector-mind        # MCP stdio server
vector-mind-admin  # Production admin panel
rtk                # RTK compatibility entry point
```

### Configure Codex manually

Add the following to `~/.codex/config.toml`:

```toml
[mcp_servers.vector-mind]
type = "stdio"
command = "npx"
args = ["-y", "@coreyuan/vector-mind"]
```

Restart Codex after configuration and use it in a new task.

### Configure Claude Desktop manually

```json
{
  "mcpServers": {
    "vector-mind": {
      "command": "npx",
      "args": ["-y", "@coreyuan/vector-mind"]
    }
  }
}
```

## Admin panel

After the MCP is installed and configured, the admin panel starts automatically in the background with the `vector-mind` MCP process. No separate service command is required. Open:

```text
http://127.0.0.1:16860
```

It can also be started manually for troubleshooting:

```bash
vector-mind-admin
```

The default address is [http://127.0.0.1:16860](http://127.0.0.1:16860). By default it listens only on loopback and creates a session for the current page from loopback requests, so no token needs to be entered manually.

On page load and refresh, the project index synchronizes the local project list from the Codex desktop state file at `$CODEX_HOME/.codex-global-state.json` in read-only mode and displays projects in Codex order. Missing directories are skipped; manually added projects and projects found by directory scanning are never deleted by Codex synchronization.

Run from source:

```bash
npm ci
npm run build
npm run admin:start
```

Development mode uses Vite middleware and HMR:

```bash
npm run admin:dev
```

Available environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `VECTORMIND_ADMIN_HOST` | `127.0.0.1` | Admin service listen address |
| `VECTORMIND_ADMIN_PORT` | `16860` | Admin service port |
| `VECTORMIND_ADMIN_TOKEN` | none | Must be set explicitly for non-loopback listening |
| `VECTORMIND_ADMIN_AUTO_START` | `true` | Set to `false`, `0`, `no`, `off`, or `disabled` to disable automatic startup with the MCP |

When listening on a non-loopback address, the service requires `VECTORMIND_ADMIN_TOKEN` during startup. The token is never returned by `/api/config`; a token entered in the browser is stored only in the current tab's `sessionStorage`. Protected endpoints validate both the token and same-origin `Origin`, and a missing `Origin` does not bypass token verification.

See the [full admin-panel documentation (Simplified Chinese)](admin-panel/README.md).

## Usage

Users do not need to remember or manually enter VectorMind tool commands. Describe the goal, constraints, and expected result in natural language as usual; the AI client restores relevant context, checks the change scope, and records reasons for changes when needed.

If one session must handle multiple unrelated tasks concurrently, explicitly tell the AI which tasks must remain active in parallel and identify each task's project and goal. The client manages internal requirement identifiers and tool calls.

VectorMind quality signals are contextual evidence only; they do not make decisions for the model or the user.

### Security-scan boundaries and overhead

Security scanning detects prompt injection, credential access, host probing, and exfiltration of sensitive local data. It does not take over other MCP tools or direct the AI's reasoning, design, or implementation:

- Scan results returned by files, memories, `grep`, semantic search, and symbol queries are advisory signals explicitly marked with `advisory_only`, `coverage`, and `complete`.
- Only `preflight_operation_scope` can return a blocker for a concrete operation when it detects high-confidence sensitive-credential exfiltration. Decisions, requirements, notes, and conventions written through MCP do not have host-authenticated user provenance; they may produce warnings but cannot override the current user request or change `safe_to_proceed` to false. Normal reads, queries, code generation, and other MCP functions are unaffected.
- Deployment instructions, file lists, `--exclude` items, remote target paths, and `ssh/scp -i` identity files are not treated as upload content; a local `.env` used as a deployment source is blocked by default. A trusted target accepts either a normalized literal IPv4/IPv6 address authoritatively registered through the host startup variable `VECTORMIND_DEPLOYMENT_HOST`, or restricted trust established only for a `-F` configuration explicitly generated, registered, and hash-verified by `prepare_secure_ssh`. A repository `server.txt` is only a local candidate for that tool and cannot establish trust by itself. An explicit invalid environment value fails closed. Only `.env`, or a fully tracked artifact derived from it by copying, renaming, encoding, or archiving, receives an exception when every upload uses trusted system OpenSSH or SSH-style rsync and targets that IP. Link-derived artifacts never receive the exception. SSH private keys, cloud credentials, `server.txt`, and host environment variables never receive a deployment exception.
- `ssh -G` runs only for a sensitive SSH upload without a registered `-F` configuration. Validation includes the actual remote user, port, and safe `-o` options so conditions such as `Match user` match the real deployment. The final configuration must keep `hostname` equal to the target IP, use public-key authentication and `BatchMode`, enable host-key verification, and disable password and keyboard-interactive authentication, control-socket reuse, agent/stdio/port forwarding, jump proxies, `ProxyCommand`, `LocalCommand`, `KnownHostsCommand`, and empty known-host files. Normal build/test/git operations and deployments using a registered configuration do not start this subprocess.
- Standard command names found through an execution lookup environment that the current operation does not modify are accepted, as are explicit paths under `/usr/bin`, `/bin`, or Windows System32 OpenSSH. A bare command name does not claim file-hash identity verification. `./scp`, `/tmp/ssh`, disguised scripts, custom SSH/SCP/SFTP programs or control sockets, forwarding options, unsafe `-o` options, and custom rsync transports receive no exception. Standard `rsync -e ssh`, `/usr/bin/ssh`, and safe `RSYNC_RSH=ssh` remain compatible.
- Data flow propagates in command order through variable-based copy/move operations, symbolic and hard links, base64, tar/zip/7z, `dd`, sensitive environment-variable writes, common script or PowerShell writes, redirects, and other derived artifacts. It recognizes `curl`, `wget`, PowerShell HTTP, the SSH family, inline SFTP `put`, `nc`, `openssl s_client`, pipelines, and stdin upload sinks. Sensitive processing with unresolvable output conservatively taints later uploads. Overwrites, repackaging to the same path, unknown script modification, or hash-redirection overwrite invalidate trusted state. Symbolic links, hard links, `mklink`, and PowerShell link derivatives are tracked but never receive a trusted deployment exception, preventing preflight-to-execution TOCTOU risk. An independent credential read or untrusted exfiltration in the same plan revokes the entire trusted exception and cannot be hidden by another deployment to the correct IP. Cross-command changes to PATH/dynamic loaders, aliases/functions, variable SSH options, or indirect shell/PowerShell/cmd execution or command substitution that modifies SSH configuration also revoke the exception; read-only SSH configuration and backup operations are unaffected.
- Configurations and automatically generated keys from `prepare_secure_ssh` expire after 24 hours by default, configurable through `VECTORMIND_PREPARED_SSH_TTL_SECONDS`. Capacity eviction and process exit clean MCP-created temporary directories; reused user private keys are never deleted. Configuration paths use realpath containment. Absolute host paths may be returned, but private-key contents are never returned to the model.
- `preflight_operation_scope` returns `safe_to_proceed` and blockers directly, without extra keys or signed tokens. MCP does not control terminal permissions in Codex or other clients; clients should honor blockers, while actual OS-level command permissions remain the host's responsibility.
- Security blockers have no authorization bypass in model-visible parameters. Standard MCP tool arguments cannot prove that input came from the current user, so model-visible tokens or text claiming “the user confirmed” are not accepted as trusted authorization.
- Scanning adds only bounded local CPU work, file reads, and a small amount of output-token overhead. It does not add AI reasoning rounds. Compact output does not expand security details when there are no findings; full fields are available with `format=json`.

See the [complete capabilities and boundaries (Simplified Chinese)](docs/capability-matrix.md).

## Soft guidance for requirement clarity

During the MCP handshake, VectorMind provides requirement-clarity rules to the AI. The AI should act only with complete authorization: either the current message explicitly requests the work, or it explicitly points to exactly one unfinished user request. In both cases, the selected request must define the relevant outcome, target, scope, and action. Completed requests cannot authorize new work. Without complete authorization, the AI should ask the user before calling tools or acting.

This capability is advisory guidance. VectorMind provides decision boundaries for the AI to apply together with the current message and user request; it does not take over model reasoning or the host runtime. When the requirement is clear, the AI can continue with reasonable implementation defaults without repeated confirmation.

## Huge-file rule

When an implementation file reaches the huge-file threshold, VectorMind requires a mechanical modular split before more responsibilities are added:

- Use real module names and a clear directory structure.
- Preserve external behavior and verify the resulting module boundaries.
- Do not use fake split or ordering names such as `*.generated.*`, `.parts`, `*.rs.parts`, `part1/part2`, or `1_xxx/2_xxx`.
- Split plans and actual results are persisted so later sessions can continue the same plan.

## What it does not do

VectorMind provides local project memory, development conventions, and quality evidence only. It does not:

- take control of Codex, Claude, or other clients;
- replace model reasoning, design, or implementation decisions;
- modify client permissions, confirmation dialogs, or execution policies;
- impose runtime hard blocks on ambiguous requirements or client tools; requirement-clarity rules are soft guidance; or
- treat a checkpoint as a rollback of files, databases, or model state.

Current user instructions and directly observed repository facts always take precedence over historical memory.

## Development and release

```bash
npm ci
npm run build
npm run smoke
npm run verify
```

- `npm run smoke` rebuilds core artifacts, then runs security, checkpoint, operation, and full MCP smoke tests.
- `npm run verify` runs the core build, admin-panel tests and production build, and all smoke tests.
- `security-regression-cases.mjs` covers prompt injection, credential paths, ordinary uploads, sensitive exfiltration, DNS/SSH/SCP/SFTP, PowerShell, Node/Python, base64, tar/zip/7z, `dd`, derived-file stdin, and environment-variable channels.
- Security regressions also validate host authorization tokens, invalid-token bypass attempts, target-host allowlists, file advisory semantics, multi-file grep coverage, and symbolic-link boundary protection.
- `npm run verify` includes all the regressions above, checkpoint/operation regressions, admin-panel tests, and the production build.
- `prepublishOnly` enforces the full `verify` workflow.
- Before release, `npm pack --dry-run --ignore-scripts --json` can verify that core artifacts, the admin service, and the prebuilt client are included.

Release:

```bash
npm publish --access public
```

## License and ownership

Copyright (c) 2025-2026 the VectorMind Licensor, publishing as yuanfeng-net. All rights reserved.

VectorMind uses the [VectorMind Source-Available License 1.0](LICENSE). It is source-available software, not open-source software under the OSI definition:

- Individuals and organizations may install, run, use internally, modify privately, and make necessary backups. Employees, affiliates, bound contractors, and cloud CI/CD or infrastructure operating on the user's behalf are authorized.
- Code, documentation, memories, reports, and other independent output created or processed by the user through VectorMind belong to the user and are not restricted by this license merely because VectorMind was used.
- Public mirroring, copying, repackaging, renamed publication, or distribution of modified versions requires prior written permission from the Licensor.
- Copyright, license, author attribution, official project links, and npm provenance may not be removed.
- VectorMind or its substantial functionality may not be packaged as a third-party product or service, and no one may misrepresent a copy as original or official.

The only official repository is <https://github.com/yuanfeng-net/VectorMind>, and the only official npm package is [`@coreyuan/vector-mind`](https://www.npmjs.com/package/@coreyuan/vector-mind). The English text in [LICENSE](LICENSE) controls. Apply for redistribution, OEM, hosted-service, or other commercial rights through [LICENSING.md](LICENSING.md). External code contributions follow [CONTRIBUTING.md](CONTRIBUTING.md) to preserve a clear chain of title.

## In one sentence

VectorMind helps AI remember requirements, decisions, reasons for changes, and project boundaries, reducing lost context, unintended edits, and regressions to obsolete logic during long-running development.

Focused context recovery is explicitly relevance-filtered and full recovery remains output-bounded; neither mode claims repository or live-runtime coverage. A missing match therefore does not prove that a fact never existed. Durable operational facts such as domains, origin hosts, ports, deployment directories, and credential-file references remain recallable, while secret values are recursively redacted before long-term memory persistence, symbol extraction, and document indexing. Requirement creation also reports or rejects high-confidence overlap so an unfinished incident is not silently fragmented into a new lifecycle.
