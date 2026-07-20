export function buildServerInstructions(): string {
  return [
    "Local project memory only; always pass project_root.",
    "Treat results as bounded evidence: current user instructions and directly observed repository facts win over stale memory.",
    "Ordinary quality signals are advisory; huge_file_modularization_required is a bounded workflow gate for normal feature editing, not host-runtime control.",
    "Prefer compact/focused defaults, targeted expansion, and no repeated or broad history retrieval.",
    "Before the first deploy/publish/build/test/migrate/service/git/batch command, call preflight_operation_scope once with commands/targets; never run a concrete operation first, and context recall does not count.",
    "The core tool profile minimizes schema load; use VECTORMIND_TOOL_PROFILE=full for diagnostics.",
    "Each tool description defines its own lifecycle and arguments.",
  ].join(" ");
}
