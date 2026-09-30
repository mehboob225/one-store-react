# one-store-react

A Bun + React 19 boilerplate built around one rule:

> **Server data lives in exactly one place — `AppDataFactory`, a mutable normalized
> cache. Everything else is either a way to get data *into* it (factories, loaders,
> push) or a way to find out it *changed* (Jotai timestamp atoms).**

The step-by-step build plan lives in `PLAN.md` at the repo root (local, gitignored).
Each step is one PR; every PR must keep `bun run check`, `bun test` and
`bun run build` green.

## Scripts

- `bun dev` — hot-reloading dev server (`src/index.ts` serves `src/index.html` and the
  in-memory mock backend from `src/server/`; contract in `docs/API.md`)
- `bun run check` — `tsc --noEmit`
- `bun run generate-models` — regenerates `src/store/DataCache.ts` and `src/models/appdata/*AppData.ts`
  from `ModelDefinitions` (`--check` fails on stale output; CI runs it). Generated files are committed
  and never edited by hand.
- `bun test` — unit + component tests (happy-dom is preloaded via `test/setup.ts`)
- `bun run build` — static production build to `dist/`

## Configuration

Backend endpoints come from `src/config/DomainConfiguration.ts` (`api`, `sock`).
Resolution order per endpoint: `BUN_PUBLIC_API_URL` / `BUN_PUBLIC_SOCK_URL` env →
`window.__APP_CONFIG__` → `HOSTNAME_MAP` → same-origin (`/api/`, `ws(s)://host/push`).
Never hardcode a URL elsewhere. Every variable is documented in `.env.example`;
copy it to `.env` (gitignored, auto-loaded by Bun).

## Authentication

`src/auth/AuthenticationService.ts` owns credentials (`uuid:token`), persisted in
localStorage and cached in memory. It uses plain `fetch` and never writes to the store.
Every change goes through one generation-guarded `commit()`. A logout or user switch wipes
`_state_*` keys (persisted UI atoms): this tab's sessionStorage always, shared localStorage
only by the tab that performs the transition. Persisted UI state must use that prefix.

## Conventions

- Components never fetch and never hold server state; they declare loaders and read the store.
- Atoms never fetch; they subscribe to store events and re-read inside `useMemo`.
- Every factory method ends in a store write (`saveAppData` / `deleteAppData`).
- Model classes extend their generated `*AppData` base and declare fields with `declare` (the base
  constructor assigns the JSON; a plain field would reset it to `undefined`).
- A model lives at `src/models/<Model>.ts` (the generated code imports its type from there) and is
  registered in `ModelConstructors` (`src/store/AppDataModelFactory.ts`; the map's type rejects a
  missing or mismatched entry). A model method must not share a name with a server field:
  `initializeFromJson` throws on a field that would shadow a member.
- Raw JSON reaches the store only through `AppDataModelFactory.addData`, which lifts embedded
  objects into their buckets and writes nothing if any record is bad.
- A model's accessors resolve through the store that holds it (`storeOf(model)`, set when a bucket
  stores it); nothing under `src/models` imports `AppDataFactory`.

---


Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
