// Registers happy-dom globals (window, document, ...) before every test file.
// Loaded via `[test] preload` in bunfig.toml.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// happy-dom replaces networking and timer globals with browser emulations that
// enforce browser rules (same-origin policy, no real sockets). Server tests
// talk to an in-process Bun.serve, so keep Bun's native implementations.
const native = {
  fetch,
  Request,
  Response,
  Headers,
  WebSocket,
  AbortController,
  AbortSignal,
  FormData,
  Blob,
  File,
  URL,
  URLSearchParams,
  crypto,
  structuredClone,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
};

// A fixed origin so code that reads window.location (DomainConfiguration,
// routing) resolves deterministically.
GlobalRegistrator.register({ url: "http://localhost:3000/" });

Object.assign(globalThis, native);
