import { HttpAgent } from "@ag-ui/client";

/** Builds the AG-UI client the CopilotKit runtime uses to reach the agent server. */
export function createDefaultAgent(): HttpAgent {
  return new HttpAgent({
    // Strip any trailing slash so a user-set AGENT_URL like "http://host:8000/"
    // does not produce a double slash.
    url: `${(process.env.AGENT_URL || "http://localhost:8000").replace(/\/+$/, "")}/`,
  });
}
