export function buildServerInstructions(): string {
  return [
    "Local project memory only; always pass project_root.",
    "Treat results as bounded evidence: current user instructions and directly observed repository facts win over stale memory.",
    "Ordinary quality signals are advisory; huge_file_modularization_required is a bounded workflow gate for normal feature editing, not host-runtime control.",
    "Prefer compact/focused defaults, targeted expansion, and no repeated or broad history retrieval.",
    "The core tool profile minimizes schema load; clients needing diagnostics may set VECTORMIND_TOOL_PROFILE=full.",
    "Each tool description defines its own lifecycle and arguments.",
  ].join(" ");
}
