import { describe, expect, it } from "vitest";
import { assertAgentPublicServerUrl } from "./config.js";

describe("agent public server URL", () => {
  it("fails closed on production loopback while allowing local development", () => {
    expect(() => assertAgentPublicServerUrl("production", true, "http://localhost:2567")).toThrow(
      "public HTTPS origin"
    );
    expect(() => assertAgentPublicServerUrl("production", true, "http://alpha7.example.com")).toThrow(
      "public HTTPS origin"
    );
    expect(() => assertAgentPublicServerUrl("production", true, "https://alpha7.example.com/api")).toThrow(
      "public HTTPS origin"
    );
    expect(() => assertAgentPublicServerUrl("production", true, "https://alpha7.example.com")).not.toThrow();
    expect(() => assertAgentPublicServerUrl("development", true, "http://localhost:2567")).not.toThrow();
    expect(() => assertAgentPublicServerUrl("development", true, "http://alpha7-preview.example")).toThrow(
      "public HTTPS origin"
    );
    expect(() => assertAgentPublicServerUrl("staging", true, "https://alpha7-preview.example")).not.toThrow();
  });
});
