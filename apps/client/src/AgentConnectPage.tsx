import { useEffect, useState, type CSSProperties } from "react";
import { agentWebMcp } from "./webMcp";

export const isAgentConnectPath = (pathname: string): boolean =>
  pathname === "/agent" || pathname === "/agent/";

type RemoteAgentBridge = Pick<typeof agentWebMcp, "connected" | "disconnect" | "registerRemote" | "supported">;

const pageStyle: CSSProperties = {
  alignItems: "center",
  background: "#242523",
  color: "#f7f3ed",
  display: "flex",
  fontFamily: "Inter, system-ui, sans-serif",
  justifyContent: "center",
  minHeight: "100dvh",
  padding: "24px"
};

const panelStyle: CSSProperties = {
  background: "rgba(235, 229, 221, 0.08)",
  border: "1px solid rgba(247, 243, 237, 0.18)",
  borderRadius: "8px",
  boxShadow: "0 24px 64px rgba(0, 0, 0, 0.28)",
  maxWidth: "560px",
  padding: "clamp(24px, 6vw, 48px)",
  width: "100%"
};

export function AgentConnectPage({
  apiBaseUrl,
  bridge = agentWebMcp
}: {
  apiBaseUrl: string;
  bridge?: RemoteAgentBridge;
}) {
  const [status, setStatus] = useState<"connected" | "disconnected" | "error" | "ready" | "unsupported">(
    bridge.supported ? (bridge.connected ? "connected" : "ready") : "unsupported"
  );

  useEffect(() => {
    if (!bridge.supported) return undefined;
    let disposed = false;
    let unregister: (() => void) | undefined;
    const release = () => void bridge.disconnect().catch(() => undefined);
    window.addEventListener("pagehide", release);
    void bridge.registerRemote(apiBaseUrl, (connected) => {
      if (!disposed) setStatus(connected ? "connected" : "disconnected");
    }).then((dispose) => {
      if (disposed) dispose();
      else unregister = dispose;
    }).catch(() => {
      if (!disposed) setStatus("error");
    });
    return () => {
      disposed = true;
      window.removeEventListener("pagehide", release);
      if (unregister) unregister();
      else release();
    };
  }, [apiBaseUrl, bridge]);

  const message = status === "unsupported"
    ? "This browser does not support WebMCP site tools. Open this page in a WebMCP-enabled ChatGPT or Codex browser, or use the Alpha-7 Codex / CLI connector."
    : status === "connected"
      ? "Agent control connected. Gameplay tools are ready. Leaving this page releases the seat."
      : status === "disconnected"
        ? "Agent control ended. Ask the human player for a fresh one-time code to reconnect."
      : status === "error"
        ? "Alpha-7 site tools could not start here. Reload in a WebMCP-enabled browser or use the Codex / CLI connector."
        : "Ask your agent to call connect_alpha7_agent with the one-time pairing code shown by the human player's Alpha-7 lobby.";

  return (
    <main style={pageStyle}>
      <section aria-labelledby="agent-connect-title" style={panelStyle}>
        <p style={{
          color: "#f06b2b",
          fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
          fontSize: "11px",
          letterSpacing: "0.1em",
          margin: "0 0 16px",
          textTransform: "uppercase"
        }}>
          Alpha-7 · Remote Agent Link
        </p>
        <h1 id="agent-connect-title" style={{
          fontFamily: "Rajdhani, Inter, sans-serif",
          fontSize: "clamp(34px, 8vw, 56px)",
          letterSpacing: "0.04em",
          lineHeight: 1,
          margin: "0 0 20px",
          textTransform: "uppercase"
        }}>
          Connect to the arena
        </h1>
        <p aria-live="polite" style={{ color: "rgba(247, 243, 237, 0.74)", lineHeight: 1.65, margin: 0 }}>
          {message}
        </p>
        <p style={{
          borderTop: "1px solid rgba(247, 243, 237, 0.14)",
          color: "rgba(247, 243, 237, 0.5)",
          fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
          fontSize: "10px",
          letterSpacing: "0.06em",
          margin: "28px 0 0",
          paddingTop: "18px",
          textTransform: "uppercase"
        }}>
          No human player seat is created on this page. Pairing and broker credentials are never displayed.
        </p>
        <a href="/" style={{ color: "#f06b2b", display: "inline-block", marginTop: "24px" }}>
          Return to Alpha-7
        </a>
      </section>
    </main>
  );
}
