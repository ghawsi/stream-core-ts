/**
 * Runs once when the server starts, before it handles requests.
 * Outbound HTTPS trust: Node.js ignores the operating system's certificate
 * store, so SAP systems with certificates from a company PKI would fail.
 * See lib/tls/trust.ts.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { configureOutboundTrust } = await import("./lib/tls/trust")
    configureOutboundTrust()
  }
}
