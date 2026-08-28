import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ToolHandlerContext } from "./context.js";
import { PrepareSecureSshArgsSchema } from "../tool-schemas.js";
import { prepareSecureSsh } from "../secure-ssh.js";
import { toolCompactOrJson } from "../token-savings.js";
import { toolJson } from "../tool-output.js";

export function handlePrepareSecureSsh(
  rawArgs: Record<string, unknown>,
  context: ToolHandlerContext,
): CallToolResult {
  const args = PrepareSecureSshArgsSchema.parse(rawArgs);
  try {
    const result = prepareSecureSsh({
      projectRoot: context.getProjectRoot(),
      configPath: args.config_path,
      host: args.host,
      user: args.user,
      port: args.port,
      identityFile: args.identity_file,
      generateKey: args.generate_key,
    });
    const compact = [
      `prepare_secure_ssh status=${result.status} host=${result.target.host} user=${result.target.user} port=${result.target.port}`,
      `ssh_config=${result.ssh_config_path}`,
      `identity_file=${result.identity_file} generated_key=${result.generated_key} password_authentication_disabled=true`,
      result.fingerprint ? `fingerprint=${result.fingerprint}` : "",
      result.sensitive_fields_detected.length ? `sensitive_fields_detected=${result.sensitive_fields_detected.join(",")}` : "sensitive_fields_detected=none",
      result.note,
      result.public_key ? `public_key=${result.public_key}` : "",
    ].filter(Boolean).join("\n");
    return { content: [{ type: "text", text: toolCompactOrJson("prepare_secure_ssh", result, compact, args.format) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: toolJson({ ok: false, error: String(error) }) }] };
  }
}
