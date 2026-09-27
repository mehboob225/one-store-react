import { describe, expect, test } from "bun:test";
import { DomainConfiguration, resolveDomainConfiguration, type ResolveInputs } from "./DomainConfiguration";

const http: ResolveInputs["location"] = { protocol: "http:", host: "localhost:3000", hostname: "localhost" };
const https: ResolveInputs["location"] = { protocol: "https:", host: "app.example.com", hostname: "app.example.com" };

describe("resolveDomainConfiguration", () => {
  test("same-origin defaults when nothing is configured", () => {
    expect(resolveDomainConfiguration({ location: http, hostnameMap: {} })).toEqual({
      api: "/api/",
      sock: "ws://localhost:3000/push",
    });
  });

  test("defaults use wss on https pages", () => {
    expect(resolveDomainConfiguration({ location: https, hostnameMap: {} }).sock).toBe("wss://app.example.com/push");
  });

  test("hostname map applies only to the matching hostname", () => {
    const hostnameMap = {
      "app.example.com": { api: "https://api.example.com/v2", sock: "wss://api.example.com/push" },
    };
    expect(resolveDomainConfiguration({ location: https, hostnameMap })).toEqual({
      api: "https://api.example.com/v2/",
      sock: "wss://api.example.com/push",
    });
    expect(resolveDomainConfiguration({ location: http, hostnameMap })).toEqual({
      api: "/api/",
      sock: "ws://localhost:3000/push",
    });
  });

  test("window injection beats the hostname map", () => {
    const hostnameMap = { localhost: { api: "https://map.example.com/api/" } };
    const injected = { api: "https://injected.example.com/api" };
    expect(resolveDomainConfiguration({ location: http, hostnameMap, injected }).api).toBe(
      "https://injected.example.com/api/",
    );
  });

  test("build-time env beats everything", () => {
    const result = resolveDomainConfiguration({
      location: http,
      hostnameMap: { localhost: { api: "https://map.example.com/api/", sock: "wss://map.example.com/push" } },
      injected: { api: "https://injected.example.com/api/", sock: "wss://injected.example.com/push" },
      env: { BUN_PUBLIC_API_URL: "http://localhost:4000/api", BUN_PUBLIC_SOCK_URL: "ws://localhost:4000/push" },
    });
    expect(result).toEqual({ api: "http://localhost:4000/api/", sock: "ws://localhost:4000/push" });
  });

  test("each endpoint falls through independently", () => {
    const result = resolveDomainConfiguration({
      location: https,
      hostnameMap: { "app.example.com": { sock: "wss://push.example.com/push" } },
      injected: { api: "https://api.example.com/api/" },
      env: {},
    });
    expect(result).toEqual({ api: "https://api.example.com/api/", sock: "wss://push.example.com/push" });
  });

  test("empty and whitespace values are ignored", () => {
    const result = resolveDomainConfiguration({
      location: http,
      hostnameMap: {},
      injected: { api: "   ", sock: "" },
      env: { BUN_PUBLIC_API_URL: "", BUN_PUBLIC_SOCK_URL: " " },
    });
    expect(result).toEqual({ api: "/api/", sock: "ws://localhost:3000/push" });
  });

  test("api always ends with a slash", () => {
    expect(resolveDomainConfiguration({ location: http, hostnameMap: {}, injected: { api: "/backend" } }).api).toBe("/backend/");
    expect(resolveDomainConfiguration({ location: http, hostnameMap: {}, injected: { api: "/backend/" } }).api).toBe("/backend/");
  });

  test("sock accepts paths, http(s) URLs and ws(s) URLs", () => {
    const sock = (value: string, location = http) =>
      resolveDomainConfiguration({ location, hostnameMap: {}, injected: { sock: value } }).sock;
    expect(sock("/realtime")).toBe("ws://localhost:3000/realtime");
    expect(sock("realtime")).toBe("ws://localhost:3000/realtime");
    expect(sock("/realtime", https)).toBe("wss://app.example.com/realtime");
    expect(sock("http://push.example.com/push")).toBe("ws://push.example.com/push");
    expect(sock("https://push.example.com/push")).toBe("wss://push.example.com/push");
    expect(sock("ws://push.example.com/push")).toBe("ws://push.example.com/push");
    expect(sock("WSS://push.example.com/push")).toBe("WSS://push.example.com/push");
  });
});

describe("DomainConfiguration singleton", () => {
  // The singleton reads the real environment at import time, and `bun test`
  // auto-loads `.env`, so this test must not assume BUN_PUBLIC_* are unset.
  // It checks the wiring: the singleton equals the resolver fed with the live
  // env, the live window injection and the real window location.
  test("is the resolver applied to the live environment and window", () => {
    expect(DomainConfiguration).toEqual(
      resolveDomainConfiguration({
        env: {
          BUN_PUBLIC_API_URL: process.env.BUN_PUBLIC_API_URL,
          BUN_PUBLIC_SOCK_URL: process.env.BUN_PUBLIC_SOCK_URL,
        },
        injected: window.__APP_CONFIG__,
        location: window.location,
      }),
    );
  });

  test("reads the test origin from window.location", () => {
    // test/setup.ts registers happy-dom at http://localhost:3000; with no env
    // override the sock must be derived from that origin.
    if (!process.env.BUN_PUBLIC_SOCK_URL) expect(DomainConfiguration.sock).toBe("ws://localhost:3000/push");
    else expect(DomainConfiguration.sock).toMatch(/^wss?:\/\//i);
  });
});
