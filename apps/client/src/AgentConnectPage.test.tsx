import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AgentConnectPage, isAgentConnectPath } from "./AgentConnectPage";

describe("remote agent page", () => {
  it("routes only /agent to the remote surface instead of the human game client", () => {
    expect(isAgentConnectPath("/agent")).toBe(true);
    expect(isAgentConnectPath("/agent/")).toBe(true);
    expect(isAgentConnectPath("/")).toBe(false);
  });

  it("shows useful unsupported-WebMCP instructions without accepting or displaying a code", () => {
    const markup = renderToStaticMarkup(
      <AgentConnectPage
        apiBaseUrl="https://api.alpha7.example"
        bridge={{
          connected: false,
          disconnect: vi.fn(async () => undefined),
          registerRemote: vi.fn(async () => () => undefined),
          supported: false
        }}
      />
    );

    expect(markup).toContain("does not support WebMCP site tools");
    expect(markup).toContain("No human player seat is created");
    expect(markup).not.toContain("pairing-secret");
    expect(markup).not.toContain("broker-secret");
    expect(markup).not.toContain("<input");
  });

  it("describes protocol-neutral gameplay tools without exposing connection secrets", () => {
    const markup = renderToStaticMarkup(
      <AgentConnectPage
        apiBaseUrl="https://api.alpha7.example"
        bridge={{
          connected: true,
          disconnect: vi.fn(async () => undefined),
          registerRemote: vi.fn(async () => () => undefined),
          supported: true
        }}
      />
    );

    expect(markup).toContain("Gameplay tools are ready");
    expect(markup).not.toContain("tactical intent tools");
    expect(markup).not.toContain("pairing-secret");
    expect(markup).not.toContain("broker-secret");
  });
});
