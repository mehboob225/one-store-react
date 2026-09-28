# Mock API contract

The mock backend lives in `src/server/` and runs inside the same Bun process as
the app (`bun dev`). It is in-memory: restarting the server restores the seed
data from `src/server/fixtures.ts`.

The client is built against this contract. A real backend must honour the same
shapes, or the factories (step 11) are the place to adapt.

## Conventions

| Rule | Detail |
|---|---|
| Base path | `/api/v1` |
| Auth header | `Authorization: <uuid>:<token>` on every request except `sign_in` |
| Unauthenticated | `401 {"error":"unauthorized"}` |
| Authorization | reads are workspace-wide; **writes to a project's tasks require membership** of that project: `403 {"error":"not a member of this project"}`, decided after `404` and before any body check |
| Not found | `404 {"error":"<thing> not found"}`; unknown `/api/*` paths are JSON 404, never the HTML fallback |
| Server error | a route that throws answers `500 {"error":"internal error"}` (JSON, never the HTML fallback) and logs the exception |
| Response shape | an object keyed by bucket name: lists `{ tasks: [...] }`, singles `{ task: {...} }` |
| Embedded objects | `tasks` carry `assignee` (a public user or `null`); the client lifts it into the `users` bucket |
| User representations | public users (`user`, `assignee`, `/users`) carry `id` and `name` only; `current_user` additionally carries `email` and `settings` and is only ever sent to that user |
| Deletions | mutations may include `deleted_<bucket>: [ids]`; the client removes those ids |
| Optimistic locking | `tasks` carry a `hash`; `PUT` must send the current one or gets `409 {"error":"conflict", task}` |
| Validation | every write body is validated (`src/server/validation.ts`): unknown and server-owned fields are dropped, badly typed values return `400 {"error"}` and nothing is written or broadcast |
| Push | every mutation broadcasts on the WebSocket (see below) |

## Fixture accounts

| Email | Password |
|---|---|
| `ada@example.com` | `password` |
| `grace@example.com` | `password` |
| `alan@example.com` | `password` (on no project; still a workspace member) |

## Endpoints

| Method | Path | Body | Response | Push |
|---|---|---|---|---|
| POST | `/sign_in` | `{email, password}` (non-empty strings) | `{uuid, token, user}` — `user` is the public `{id, name}`; the email is on `current_user` from `/users/current`. `400` on a bad body | — |
| DELETE | `/sign_out` | — | `{ok: true}`; that session's sockets get `session_invalid` and close | — |
| GET | `/users` | — | `{users: []}` — every workspace user as `id` and `name`; fills the `users` bucket so `owner_id`, `member_ids`, `assignee_id`, `author_id` always resolve. The demo is one workspace whose members see each other by name (the usual collaboration model); emails and settings never leave `current_user` | — |
| GET | `/users/current` | — | `{user, current_user}` — `user` is the public `{id, name}` (for the `users` bucket); `current_user` adds `email` and `settings` | — |
| PUT | `/users/current/settings` | `{settings}` (plain object) | `{current_user}` (settings merged), `400` otherwise | `update current_user` **to that user only** |
| GET | `/projects` | — | `{projects: []}` (each with `owner_id`, `member_ids`) | — |
| GET | `/projects/:id` | — | `{project}` (with `owner_id`, `member_ids`) | — |
| GET | `/projects/:id/tasks` | — | `{tasks: []}` with embedded `assignee` | — |
| POST | `/projects/:id/tasks` | `{task: {title, status?, assignee_id?, due_on?}}` | `201 {task}`; `404`, `403` non-member, `400` on bad values (same rules as `PUT`); `assignee_id`, when given, must be a project member | `new task` |
| POST | `/projects/:id/tasks/import` | — | `{imported: n}` **only a count**; `404`, `403` non-member. All or nothing: authorized once and every row validated before any is written | `reload project` (only if `n > 0`) |
| GET | `/tasks/:id` | — | `{task}` with embedded `assignee` | — |
| PUT | `/tasks/:id` | `{task: {hash, title?, status?, assignee_id?, due_on?}}` | `{task}` with new `hash`. Decided in this order, atomically: `404` unknown task; `403` caller not on the task's project; `400` malformed (`task` is not an object or `hash` is not a string — a request without a hash is broken, not in conflict); `409 {error, task}` stale hash, carrying the current task; `400` bad field values, or an `assignee_id` that *changes* to a user who is not a project member (saving a task back with its current assignee is always accepted, even if that user has since left the project) | `update task` |
| DELETE | `/tasks/:id` | — | `{deleted_tasks: [id], deleted_comments: [ids]}`; `404`, `403` non-member | `delete task` |
| GET | `/tasks/:id/comments` | — | `{comments: []}` | — |
| GET | `/tasks/:id/tags` | — | `{tags: []}` (client synthesises join rows) | — |

The import endpoint deliberately returns no rows. It exists to demonstrate the
"the server changed more than the response tells me" case: the client must
clear its loaders and refetch.

## WebSocket push

Endpoint: `ws://<host>/push`. Messages are JSON.

| Direction | Message | Meaning |
|---|---|---|
| client → server | `{type:"login", uuid, token}` | must be the first message |
| server → client | `{type:"login_ok"}` | authenticated; broadcasts follow |
| server → client | `{type:"session_invalid"}` then close `4001` | bad credentials, or the session was revoked (sign-out) |
| server → client | `{type:"ping"}` every 25 s | heartbeat; client may reply `{type:"pong"}` |
| server → client | `{type:"new"\|"update", objectType, data}` | write `data` into the bucket for `objectType` |
| server → client | `{type:"delete", objectType, objectId}` | remove that id |
| server → client | `{type:"reload", objectType, objectId}` | scope changed beyond any payload; clear loaders and refetch |

`objectType` is the singular entity name (`task`, `project`, `current_user`).
Unauthenticated sockets receive nothing. Frames that are not a JSON object
(`null`, numbers, strings, arrays, invalid JSON) are ignored; unknown `type`s too. Entity changes are broadcast to every
authenticated socket; `current_user` updates go only to that user's sockets.

## Development notes

Under `bun dev` (`bun --hot`) the backend state (data, sessions, open sockets)
is kept on `globalThis` by `src/server/dev.ts`, so saving a server file swaps
the handlers but keeps you signed in, keeps your data, and keeps existing
WebSockets receiving events. Restart the process to reset to the seed data.

## curl walkthrough

```sh
bun dev                                   # http://localhost:3000

# 1. sign in and keep the header
AUTH=$(curl -s localhost:3000/api/v1/sign_in \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"password"}' \
  | bun -e 'const b=await Bun.stdin.json(); console.log(`${b.uuid}:${b.token}`)')

# 2. read
curl -s -H "authorization: $AUTH" localhost:3000/api/v1/users/current
curl -s -H "authorization: $AUTH" localhost:3000/api/v1/projects
curl -s -H "authorization: $AUTH" localhost:3000/api/v1/projects/1/tasks

# 3. mutate with optimistic locking
HASH=$(curl -s -H "authorization: $AUTH" localhost:3000/api/v1/tasks/2 \
  | bun -e 'console.log((await Bun.stdin.json()).task.hash)')
curl -s -X PUT -H "authorization: $AUTH" -H 'content-type: application/json' \
  -d "{\"task\":{\"hash\":\"$HASH\",\"status\":\"done\"}}" localhost:3000/api/v1/tasks/2

# 4. delete → deleted_* arrays
curl -s -X DELETE -H "authorization: $AUTH" localhost:3000/api/v1/tasks/1

# 5. unauthenticated → 401
curl -s -i localhost:3000/api/v1/projects | head -1
```
