import assert from "node:assert/strict";

import { buildCurrentConstraints, evaluateOperationScope } from "../../dist/operation-scope.js";
import { listToolDefinitions } from "../../dist/tool-catalog.js";
import { boundToolResult, shouldRunAutoMaintenanceForTool } from "../../dist/tool-handlers.js";

const timestamp = "2026-01-01T00:00:00.000Z";

function decisionRow(id) {
  return {
    id,
    kind: "decision",
    title: `Decision ${id}`,
    content: `Current decision ${id}`,
    file_path: null,
    start_line: null,
    end_line: null,
    req_id: null,
    metadata_json: JSON.stringify({ status: "current", key: `decision-${id}` }),
    content_hash: `decision-${id}`,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function operationConstraint() {
  return {
    id: 500,
    kind: "decision",
    title: "Production deployment constraint",
    source: "current_decision",
    priority: 100,
    preview: "Do not deploy the production environment.",
    file_path: null,
    req_id: null,
    updated_at: timestamp,
  };
}

function assertOperationConflict(plan, expectedSource) {
  const result = evaluateOperationScope(plan, [operationConstraint()]);
  assert.equal(result.ok, false);
  assert.equal(result.safe_to_proceed, false);
  const conflict = result.warnings.find((warning) => warning.code === "operation_constraint_conflict");
  assert.ok(conflict, "expected an operation_constraint_conflict warning");
  assert.ok(conflict.details?.conflict_sources?.includes(expectedSource));
}

function testIndependentOperationSignals() {
  assertOperationConflict({
    operation: "deploy production environment",
    intent: "publish the release to the production environment",
    commands: ["npm run verify"],
    targets: ["staging-artifact"],
  }, "natural_plan");

  assertOperationConflict({
    operation: "validate release candidate",
    intent: "run validation only",
    commands: ["deploy --environment production"],
    targets: ["production environment"],
  }, "concrete_details");

  assertOperationConflict({
    operation: "deploy production environment",
    intent: "Do not clear the cache; deploy the production environment now.",
    commands: ["npm run verify"],
  }, "natural_plan");

  const aligned = evaluateOperationScope({
    operation: "build staging artifact",
    intent: "Do not deploy the production environment; build staging only.",
    commands: ["npm run build -- --target staging"],
    targets: ["staging"],
  }, [operationConstraint()]);
  assert.equal(aligned.ok, true);
  assert.equal(aligned.safe_to_proceed, true);
  assert.equal(aligned.warnings.some((warning) => warning.code === "operation_constraint_conflict"), false);
}

function testActiveRequirementReservation() {
  const constraints = buildCurrentConstraints({
    currentDecisions: Array.from({ length: 12 }, (_, index) => decisionRow(index + 1)),
    conventions: [],
    activeRequirements: [{
      requirement: {
        id: 42,
        title: "Active generic requirement",
        context_data: "Keep the active requirement visible during bounded constraint selection.",
        created_at: timestamp,
      },
    }],
    recentNotes: [],
    limit: 3,
    previewChars: 180,
  });
  assert.equal(constraints.length, 3);
  assert.ok(constraints.some((constraint) => constraint.source === "active_requirement" && constraint.req_id === 42));
}

async function testToolAnnotationsAndMaintenancePolicy() {
  const previousProfile = process.env.VECTORMIND_TOOL_PROFILE;
  process.env.VECTORMIND_TOOL_PROFILE = "full";
  const definitions = await listToolDefinitions();
  if (previousProfile === undefined) delete process.env.VECTORMIND_TOOL_PROFILE;
  else process.env.VECTORMIND_TOOL_PROFILE = previousProfile;

  const byName = new Map(definitions.tools.map((tool) => [tool.name, tool]));
  assert.deepEqual(
    {
      readOnlyHint: byName.get("preflight_operation_scope")?.annotations?.readOnlyHint,
      destructiveHint: byName.get("preflight_operation_scope")?.annotations?.destructiveHint,
    },
    { readOnlyHint: true, destructiveHint: false },
  );
  assert.deepEqual(
    {
      readOnlyHint: byName.get("upsert_decision")?.annotations?.readOnlyHint,
      destructiveHint: byName.get("upsert_decision")?.annotations?.destructiveHint,
    },
    { readOnlyHint: false, destructiveHint: true },
  );
  assert.deepEqual(
    {
      readOnlyHint: byName.get("add_note")?.annotations?.readOnlyHint,
      destructiveHint: byName.get("add_note")?.annotations?.destructiveHint,
    },
    { readOnlyHint: false, destructiveHint: false },
  );
  assert.equal(byName.get("sync_change_intent")?.annotations?.idempotentHint, false);
  assert.ok(byName.get("sync_change_intent")?._meta?.["vectormind/behavior"]?.tags?.includes("explicit_idempotency_key"));
  assert.equal(shouldRunAutoMaintenanceForTool("preflight_operation_scope"), false);
  assert.equal(shouldRunAutoMaintenanceForTool("semantic_search"), false);
  assert.equal(shouldRunAutoMaintenanceForTool("unknown_tool"), false);
  assert.equal(shouldRunAutoMaintenanceForTool("upsert_decision"), true);
  assert.equal(shouldRunAutoMaintenanceForTool("maintain_memory"), false);
}

function testBoundedStructuredResultSemantics() {
  const previousLimit = process.env.VECTORMIND_MAX_TOOL_OUTPUT_CHARS;
  process.env.VECTORMIND_MAX_TOOL_OUTPUT_CHARS = "4000";
  try {
    const success = boundToolResult("large_success", {
      content: [{
        type: "text",
        text: JSON.stringify({ ok: true, change_log_id: 77, payload: "x".repeat(5000) }),
      }],
    });
    const successSummary = JSON.parse(success.content[0].text);
    assert.notEqual(success.isError, true);
    assert.equal(successSummary.ok, true);
    assert.equal(successSummary.output_truncated, true);
    assert.equal(successSummary.change_log_id, 77);

    const nestedSuccess = boundToolResult("large_checkpoint", {
      content: [{
        type: "text",
        text: JSON.stringify({ ok: true, checkpoint: { id: 42, title: "Checkpoint" }, snapshot: { payload: "x".repeat(5000) } }),
      }],
    });
    const nestedSummary = JSON.parse(nestedSuccess.content[0].text);
    assert.deepEqual(nestedSummary.checkpoint, { id: 42, title: "Checkpoint" });

    const failure = boundToolResult("large_failure", {
      isError: true,
      content: [{
        type: "text",
        text: JSON.stringify({ ok: false, error: `failure ${"x".repeat(5000)}` }),
      }],
    });
    const failureSummary = JSON.parse(failure.content[0].text);
    assert.equal(failure.isError, true);
    assert.equal(failureSummary.ok, false);
    assert.equal(failureSummary.output_truncated, true);
    assert.match(failureSummary.error, /^failure /);
  } finally {
    if (previousLimit === undefined) delete process.env.VECTORMIND_MAX_TOOL_OUTPUT_CHARS;
    else process.env.VECTORMIND_MAX_TOOL_OUTPUT_CHARS = previousLimit;
  }
}

testIndependentOperationSignals();
testActiveRequirementReservation();
await testToolAnnotationsAndMaintenancePolicy();
testBoundedStructuredResultSemantics();

console.log("operation regression cases: ok");
