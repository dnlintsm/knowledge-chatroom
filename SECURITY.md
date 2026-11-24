# Security

## Reporting a vulnerability

Please report it privately, not in a public issue or pull request.

Use GitHub's private reporting: on this repository, open the **Security** tab and choose
**Report a vulnerability**. If that button is not there, open an issue that says only that
you have a security report, with no details, and a maintainer will arrange a private
channel with you.

Include what you can of:

- the version or commit, and how it was deployed (Docker demo, from source, with or without login);
- what an attacker needs to start with (no account, a Member, an editor on a node, a server on the private network);
- the steps, and what they could read or change.

There is no bounty. You will get an answer, and credit in the changelog if you want it.

## Supported versions

Fixes go to `main` and the next release. Older releases are not patched; upgrade to the
latest one (see [Upgrading](README.md#upgrading)).

## What is trusted with what

This is the model the code is written against. A behaviour that breaks one of these
statements is a vulnerability; a consequence of one is not.

### Processes and ports

- **Only the web app is public.** The Next.js UI (port 3000) checks the login session and
  is the only process a browser should reach. Put it behind HTTPS
  ([Deployment](docs/deployment.md#https)).
- **The Python services are private.** api-py (8000), agent-py (9300) and any MCP server
  must be reachable only from the UI and from each other. They do not check a browser
  session. They trust a request because the UI signed who it is for.
- **Who a request is for** travels as a signed token: the UI signs an identity token
  (`X-Knowledge-User`) with a key derived from `AUTH_SECRET`, which only the UI and api-py
  hold. agent-py and MCP servers get the public key (`KNOWLEDGE_PUBLIC_KEY`) and can verify
  tokens but not make them. Never give `AUTH_SECRET` to anything else.
- **The object store** is private by default. With `S3_PUBLIC_URL` set, browsers fetch
  pictures, PDF, audio and video through short-lived signed links; everything else is served
  or downloaded through the app.
- **PostgreSQL** is reached only by api-py. Access rules are checked in the app, and again
  by Postgres row-level security when the database user may use the restricted role
  (`/health` says `rowSecurity`; `ROW_SECURITY=required` refuses to serve without it).

### Modes

- **`AUTH_MODE=oidc`**: every request needs a signed-in user. A service that is missing its
  secret or key refuses calls; none of them falls back to "no login".
- **`AUTH_MODE=local`**: there is no login. Everyone who can reach the UI is the same
  built-in user, who owns the workspace. This is for one person on their own machine, or a
  demo. Do not expose it to a network you don't trust.

### People

- **A workspace Member** sees the names of the other members, the nodes shared with them,
  and their own chats and memory. They cannot see another member's chats or personal
  memory. Neither can an Owner.
- **A viewer on a node** reads its files and may propose changes. **An editor** also writes,
  deletes (history is kept), and accepts or rejects proposals. **An owner** of a node also
  deletes it and manages who it is shared with.
- **A workspace Owner or Admin** manages members, roles and groups, and sees members'
  emails and the audit log. They also hand over and restore deleted experiments that were
  shared or archived, never drafts, on nodes they can view.
- **A hub admin** (`HUB_ADMINS`) verifies and yanks skills published to the hub. Skills are
  instructions Claude follows, and with `SKILL_SCRIPTS=on` they include scripts that run in
  the agent's sandbox, so publishing and installing a skill is a trusted act.
- **A deployment admin** (`PLATFORM_ADMINS`) sees the workspace inventory and can recover an
  Owner. Whoever can set environment variables or reach the database can do anything.
- Name people in these lists by login subject. An email is matched only when the login
  provider marked it verified.

### Claude and outside tools

- **Claude acts with the rights of the person chatting**, never more. In a knowledge node
  its edits are proposals that an editor accepts. It cannot accept proposals, share,
  archive, delete or restore experiments, change roles, or delete files.
- **An outside MCP server** (`MCP_SERVERS`) receives the user's identity token and a
  short-lived storage token for the workspace the chat is in. With it, the server can read
  and propose what that user could. Only connect servers you would trust with that.
- **Content Claude reads is not trusted.** Files, search results, papers and tool output
  can contain instructions. Once a chat has read outside content, changes to memory go to
  the user's inbox for approval instead of being saved.
- **Files are untrusted too.** Stored HTML and SVG are served sandboxed, other non-media
  files download, and markdown does not load images from other servers.

## Known limits

These are tracked in the open and are not new reports:

- Sessions are not revoked server-side before they expire, and state-changing requests
  have no Origin check (issue #64).
- Skill scripts are confined by a deny-list for reads and have no resource limits
  (issue #290). Leave `SKILL_SCRIPTS` off unless you trust everyone who can publish or edit
  a skill.
