# knowledge-chatroom

Demo frontend for agents built with the Claude Agent SDK, talking over the
[AG-UI protocol](https://docs.ag-ui.com) with [CopilotKit](https://copilotkit.ai) as the UI layer.

This repo starts from CopilotKit's official
[`claude-sdk-typescript` starter](https://github.com/CopilotKit/CopilotKit/tree/main/examples/integrations/claude-sdk-typescript)
(MIT, see `LICENSE`), with the Slack/Teams channel host and showcase Docker files removed.

---

## About the starter

A starter template for building AI agents with the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview)
and [CopilotKit](https://copilotkit.ai). It pairs a modern Next.js frontend with a TypeScript
agent that speaks the [AG-UI protocol](https://docs.ag-ui.com), and shows CopilotKit driving
**interactive UI beyond chat**:

- a shared-state **todos canvas** the agent and the user both edit,
- **charts** rendered from queried data,
- **flight cards** and **dynamic dashboards** via A2UI generative UI,
- a **human-in-the-loop** meeting picker,
- a light/dark **theme toggle**, and
- the SDK **threads drawer** (activated with a CopilotKit Intelligence license).

The agent is powered by Claude (`claude-sonnet-5` by default) and exposes three backend tools —
`query_data`, `search_flights`, and `generate_a2ui` — while the todo board is shared state the
agent updates through the adapter's built-in `ag_ui_update_state` tool.

## Prerequisites

- **Node.js 20.9+**
- An **Anthropic API key** — create one at <https://console.anthropic.com/>

## Getting Started

1. **Copy the environment file:**

   ```bash
   cp .env.example .env
   ```

2. **Add your Anthropic API key** to `.env`:

   ```bash
   ANTHROPIC_API_KEY=sk-ant-...
   ```

   The other values are optional and already set to sensible defaults:
   `CLAUDE_MODEL=claude-sonnet-5` and `AGENT_URL=http://localhost:8000`.

3. **Install dependencies:**

   ```bash
   npm install
   ```

   > This installs the Next.js frontend and, via the `postinstall` script, the
   > agent's dependencies (`cd agent && npm install`).

4. **Start the app:**

   ```bash
   npm run dev
   ```

   This runs the Next.js UI on **http://localhost:3000** and the Claude agent on
   **http://localhost:8000** concurrently.

5. **Open [http://localhost:3000](http://localhost:3000)** and try the suggested prompts
   (add todos, draw a chart, search flights, build a dashboard, schedule a meeting).

6. **(Optional) Enable the Threads drawer.** Set `CPK_INTELLIGENCE_API_KEY` in
   `.env` to activate live thread history; without it the drawer shows a locked
   state. The license token and `INTELLIGENCE_*` URLs are only for self-hosted
   or offline Intelligence deployments.

## Available scripts

- `npm run dev` — start the UI and agent together (dev mode)
- `npm run dev:ui` — start only the Next.js UI (port 3000)
- `npm run dev:agent` — start only the Claude agent (port 8000)
- `npm run build` — build the Next.js app for production
- `npm start` — start the production server
- `npm run install:agent` — (re)install the agent's dependencies
- `npm run typecheck` — type-check the frontend and the agent
- `npm run test:preview` — capture UI preview screenshots and videos with Playwright (see below)

## File storage

Workspace files can live in Postgres + an S3-compatible object store instead of
the browser (plan and next steps: issue #4). It is optional; without
`DATABASE_URL` the app runs as before.

```bash
docker compose up -d   # Postgres + SeaweedFS (self-hosted S3)
# copy the "Workspace file storage" values from .env.example into .env
npm run dev
```

- **Postgres** holds the file tree, every version of every file, and who wrote it
  (`agent/src/storage/migrations`). Migrations run when the agent starts.
- **Object store** holds the bytes, keyed by their sha256, so identical content is
  stored once and old versions stay readable. Any S3-compatible store works:
  SeaweedFS or Garage self-hosted, or AWS S3, Cloudflare R2, Backblaze B2.
- **API**: the agent server serves `/files` and Next.js forwards `/api/files/*` to it.
  `GET /api/files` lists files, `GET|PUT|DELETE /api/files/<path>` reads, writes
  (request body = bytes) and deletes one, and `?versions` returns its history.
  There is no login yet, so keep the agent port private.
- **Tests**: `cd agent && npm test` with `TEST_DATABASE_URL` and the `S3_*` vars set
  (see `agent/src/storage/storage.test.ts`); CI runs them on every PR that touches `agent/`.

## UI previews on pull requests

Every PR runs `.github/workflows/ui-preview.yml`: it builds the app, walks the key screens with
Playwright (`e2e/preview.spec.ts`), and posts a sticky PR comment with a walkthrough GIF and
screenshots, so reviewers can see the UI without running it locally. Full-size `.webm` videos
and the Playwright HTML report are attached to the workflow run as an artifact. Comment images
live on the `ui-previews` branch and are removed when the PR closes.

The preview doesn't need an Anthropic key: without the `ANTHROPIC_API_KEY` repository secret, a
canned AG-UI server (`e2e/mock-agent.mjs`) stands in for the agent. Add the secret to preview
against real Claude instead.

To run it locally (first time: `npx playwright install chromium`):

```bash
npm run test:preview          # reuses `npm run dev` if it's already running, else starts the UI + mock agent
open preview/screenshots      # screenshots; videos are under test-results/
```

To capture a new screen, add a step to `e2e/preview.spec.ts` that calls `shot(page, "NN-name")`.

## Project structure

```
├── src/
│   ├── app/
│   │   ├── page.tsx                       # Main page (chat + todos canvas + threads drawer)
│   │   ├── layout.tsx                     # CopilotKit v2 provider + A2UI catalog
│   │   └── api/copilotkit/[[...slug]]/     # CopilotKit runtime route (HttpAgent → :8000)
│   ├── components/                        # Canvas, generative UI, chat, UI primitives
│   └── hooks/                             # Example suggestions + generative-UI examples
├── e2e/                                   # Playwright UI preview + mock agent for CI
└── agent/                                 # TypeScript Claude agent (AG-UI on port 8000)
    ├── package.json                       # Agent dependencies
    ├── src/
    │   ├── server.ts                       # AG-UI SSE server (entry point)
    │   ├── agent.ts                        # The agent: backend tools → ClaudeAgentAdapter
    │   ├── model.ts                        # Model resolution (CLAUDE_MODEL)
    │   ├── query.ts                        # query_data tool
    │   ├── a2ui_fixed_schema.ts            # search_flights tool (fixed A2UI schema)
    │   ├── a2ui_dynamic_schema.ts          # generate_a2ui tool (LLM-designed dashboard)
    │   ├── a2ui.ts                         # A2UI operation helpers
    │   ├── db.csv                          # Sample data for query_data
    │   └── a2ui/schemas/flight_schema.json
    └── tsconfig.json
```

## How it works

- The **frontend** uses CopilotKit's v2 React hooks. Shared state (like the todo list) lives in
  the agent and syncs bidirectionally with the UI.
- The **runtime route** (`src/app/api/copilotkit/[[...slug]]/route.ts`) connects to the agent
  over HTTP with `HttpAgent` from `@ag-ui/client`.
- The **agent** is a thin layer on the official
  [`@ag-ui/claude-agent-sdk`](https://www.npmjs.com/package/@ag-ui/claude-agent-sdk) adapter.
  `src/agent.ts` defines the three backend tools and hands them to `ClaudeAgentAdapter`; the
  adapter drives Claude through the Claude Agent SDK, bridges CopilotKit frontend tools +
  human-in-the-loop, and manages the shared `todos` state via its built-in `ag_ui_update_state`
  tool. (Unlike the Python package, the TS adapter ships no FastAPI-style server helper, so
  `src/server.ts` is a minimal `node:http` equivalent that serves the adapter.)

To customize: add or edit tools in `agent/src/` and the system prompt in `agent/src/agent.ts`,
and the UI in `src/app/page.tsx` and `src/components/`.

## Troubleshooting

**"I'm having trouble connecting to my tools" / agent unreachable**

- Make sure the agent is running on port 8000 (`npm run dev:agent`) and that
  `ANTHROPIC_API_KEY` is set in `.env`.
- Confirm the agent's health check: `curl http://localhost:8000/health` → `{"status":"ok"}`.

**Agent dependency errors**

- Reinstall the agent's dependencies: `cd agent && npm install`.

## Learn more

- [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview)
- [CopilotKit documentation](https://docs.copilotkit.ai)
- [AG-UI protocol](https://docs.ag-ui.com)
- [Next.js documentation](https://nextjs.org/docs)

## License

MIT — see [LICENSE](./LICENSE).
