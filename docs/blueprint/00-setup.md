# Part 0 — Environment Setup

**Context:** This is the environment/scaffolding state that should already
exist in the `book-keeper` repo **before** Claude Code starts on Parts 1-4.
This part documents decisions made during setup so they're not lost — it is
largely a record, not a task list, since most of it is done by the time
Claude Code opens the repo.

## Decisions already made (don't relitigate)

- **Project/repo name:** `book-keeper`.
- **Package manager:** pnpm, not npm — the devcontainer is built entirely
  around it (named pnpm store volume, `PNPM_HOME`, `postCreateCommand: pnpm
  install`). All commands in this blueprint set use `pnpm`/`pnpm add`/`pnpm
  run` accordingly. If you ever see an `npm` command in these docs, it's a
  mistake to fix, not a valid alternative.
- **Base image:** `mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm`
  (Node 22, Debian bookworm). Node 22 is Maintenance LTS (supported until
  ~April 2027) — not the newest Active LTS (that's Node 24), but a
  deliberate choice for consistency with the amumble project's devcontainer.
  Not something to "fix" by bumping to 24 — revisit only if/when amumble
  itself gets upgraded, so both projects move together.
- **LLM provider:** OpenRouter, not the Anthropic API directly — see Part 2
  for why and how this affects the generation pipeline's architecture.
- **Styling:** `@abumble/design-system` (React + Tailwind + shadcn-ui),
  reused from the amumble project — see Part 3.

## devcontainer.json

```jsonc
{
  "name": "Book Keeper",
  "build": {
    "dockerfile": "Dockerfile"
  },
  "workspaceFolder": "/workspaces/book-keeper",
  "initializeCommand": "sh -c 'mkdir -p $HOME/.claude $HOME/.gemini && touch $HOME/.claude.json'",
  "onCreateCommand": "sudo chown -R vscode:vscode /home/vscode/.local/share/pnpm /workspaces/book-keeper",
  "postCreateCommand": "sh -c '[ -f package.json ] && pnpm install || echo \"no package.json yet — run pnpm create astro@latest . first\"'",
  "features": {
    "ghcr.io/anthropics/devcontainer-features/claude-code:1": {}
  },
  "customizations": {
    "vscode": {
      "extensions": [
        "astro-build.astro-vscode",
        "esbenp.prettier-vscode",
        "dbaeumer.vscode-eslint",
        "bradlc.vscode-tailwindcss",
        "redhat.vscode-yaml",
        "google.gemini-vscode"
      ],
      "settings": {
        "editor.defaultFormatter": "esbenp.prettier-vscode",
        "editor.formatOnSave": true,
        "tailwindCSS.includeLanguages": { "astro": "html" }
      }
    }
  },
  "forwardPorts": [4321],
  "mounts": [
    "source=${localEnv:HOME}/.claude,target=/home/vscode/.claude,type=bind,consistency=cached",
    "source=${localEnv:HOME}/.claude.json,target=/home/vscode/.claude.json,type=bind,consistency=cached",
    "source=${localEnv:HOME}/.gemini,target=/home/vscode/.gemini,type=bind,consistency=cached",
    "source=book-keeper-pnpm-store,target=/home/vscode/.local/share/pnpm,type=volume"
  ],
  "remoteUser": "vscode",
  "updateRemoteUserUID": true
}
```

## Dockerfile

```dockerfile
FROM mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm

RUN groupmod --new-name vscode node \
    && usermod --login vscode --home /home/vscode --move-home node \
    && echo "vscode ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/vscode \
    && chmod 0440 /etc/sudoers.d/vscode

RUN npm install -g pnpm @google/gemini-cli

ENV PNPM_HOME="/home/vscode/.local/share/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
```

(The one `npm install -g` line here is correct as-is — it's bootstrapping
pnpm itself into the image before pnpm exists to do it, not a project
dependency install.)

## Scaffold sequence (pnpm)

Run inside the devcontainer, from an otherwise-empty repo (devcontainer
files + git already in place):

```bash
pnpm create astro@latest .
# prompts: empty/minimal template, TypeScript strict, install deps yes,
# git init: NO (repo is already git-initialized)

pnpm astro add react
pnpm add tailwindcss @tailwindcss/vite
# Tailwind v4: wire the Vite plugin directly in astro.config.mjs rather than
# `astro add tailwind` — that integration targets Tailwind v3. See how the
# repo's astro.config.mjs already does this; mirror it, don't relitigate.

pnpm add @abumble/design-system
pnpm add zod
pnpm add @langchain/langgraph @langchain/core @langchain/openai
pnpm add p-limit
pnpm add -D tsx
```

**Note:** `@langchain/openai`'s `ChatOpenAI` (not the raw `openai` SDK, and
not the Anthropic SDK) is what's used to call OpenRouter, since OpenRouter
exposes an OpenAI-compatible endpoint and `ChatOpenAI` accepts a custom
`baseURL` — see Part 2 for the client setup. Using LangChain's own model
wrapper (rather than a second, unrelated SDK) means every pipeline node gets
`.withStructuredOutput()` for free, bound directly to the Zod schemas from
Part 1/2. Do **not** run `pnpm add @anthropic-ai/sdk` or `pnpm add openai`
for this project's generation pipeline — neither is needed. Before relying
on `withStructuredOutput`, confirm the installed `@langchain/core` version's
Zod peer range actually accepts `zod@4.x` (this project's `zod` version) —
LangChain JS's structured-output tooling has a history of expecting Zod v3,
so this is worth a quick check rather than an assumption. `p-limit` is what
caps concurrency on the parallel per-chapter fan-out in Part 2 — see
"Orchestration: LangGraph" there.

```bash
mkdir -p src/content/books scripts docs/blueprint
touch src/content/config.ts   # filled in per Part 1
```

`package.json` scripts to add:
```json
"scripts": {
  "dev": "astro dev",
  "build": "astro build",
  "generate": "tsx scripts/generate-book.ts"
}
```

`.env.example` (committed) / `.env` (gitignored, real secrets):
```
# Model — via OpenRouter (supports Anthropic, OpenAI, Google, Mistral, etc.)
OPENROUTER_API_KEY=
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_MODEL=google/gemma-4-31b-it:free

# Search — Tavily
TAVILY_API_KEY=
```
`LLM_BASE_URL`/`LLM_MODEL` being env-configurable (rather than hardcoded in
the script) means the model can be swapped — or upgraded from a free tier
to a paid one for better quality — without touching code, same rationale as
the `SearchProvider` interface in Part 2. See Part 2 for how these get read
and for a note on OpenRouter's free-tier (`:free`-suffixed) models.

Confirm `.gitignore` includes `.env`, `.env.*`, `node_modules`, `dist`,
`.astro` — Astro's scaffold sets most of this up by default, just verify.

## First commit & deploy

```bash
git add -A
git commit -m "Initial Astro scaffold: react, tailwind, design-system, blueprint docs"
gh repo create book-keeper --private --source=. --remote=origin --push
```

Then in Cloudflare Pages: connect the repo, build command `astro build`,
output directory `dist`. First deploy will just be Astro's default starter
page — that's the "pipeline works" checkpoint, not a real milestone.

## Acceptance check for this part

- `pnpm dev` boots cleanly inside the devcontainer with no errors.
- `pnpm build` succeeds (even with no real book content yet).
- The Cloudflare Pages first deploy is live at a `*.pages.dev` URL.
- This is the state Part 1 assumes as its starting point.
