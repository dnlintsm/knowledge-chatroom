/**
 * Stand-in for the real rules API until it exists: fixed rules for any run,
 * in the shape src/components/workspace/rules.ts expects. Served at
 * /api/mock/rules, and used directly by /api/rules when RULES_API_URL is unset.
 */
export function mockRules(run: string) {
  return {
    run,
    generatedAt: "2026-10-08T00:00:00.000Z",
    rules: [
      {
        id: "R1",
        title: "Tune the strongest factor first",
        condition: "A factor's main effect is significant (p < 0.05)",
        action: "Set it before the others; it moves the response the most",
        confidence: 0.93,
      },
      {
        id: "R2",
        title: "Trade-offs need a target",
        condition: "One setting improves a response and worsens another",
        action: "Pick the setting by the response the layer is judged on",
        confidence: 0.81,
      },
      {
        id: "R3",
        title: "Additive inside the window",
        condition: "Interactions are not significant",
        action: "Treat factor effects as additive within the tested ranges only",
        confidence: 0.64,
      },
    ],
  };
}
