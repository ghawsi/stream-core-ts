import { X509Certificate } from "node:crypto"
import { readFileSync } from "node:fs"
import { delimiter } from "node:path"
import nodeTls from "node:tls"

/** CA functions of recent Node.js releases, newer than the installed @types/node; checked at runtime. */
type CaCertificateApi = {
  getCACertificates?: (type?: "default" | "system" | "bundled" | "extra") => string[]
  setDefaultCACertificates?: (certificates: string[]) => void
}
const tls = nodeTls as typeof nodeTls & CaCertificateApi

/**
 * Which certificate authorities outbound HTTPS (SAP systems, AI providers)
 * trusts. Node.js ships its own CA list and ignores the operating system's
 * store, so an SAP system with a certificate from a company PKI fails with
 * UNABLE_TO_GET_ISSUER_CERT_LOCALLY even though browsers trust it.
 *
 * Runs once at server start (instrumentation.ts). It only ADDS trust anchors;
 * certificate and host name verification always stay on.
 *
 * - TLS_TRUST_SYSTEM_STORE (default "true"): also trust the operating
 *   system's store (on Windows the "Trusted Root Certification Authorities",
 *   where company root CAs are usually deployed).
 * - TLS_EXTRA_CA_FILE: one or more files (separated by ";" on Windows, ":"
 *   elsewhere) with CA certificates, PEM or DER (.cer exports both work), for
 *   servers whose store does not hold the company CA.
 */
export function configureOutboundTrust() {
  if (typeof tls.setDefaultCACertificates !== "function" || typeof tls.getCACertificates !== "function") {
    console.warn(
      "[tls] This Node.js version cannot add trusted CAs at runtime. To trust a company CA, start the server with NODE_USE_SYSTEM_CA=1 or NODE_EXTRA_CA_CERTS=<file>."
    )
    return
  }

  const trusted = [...tls.getCACertificates("default")]
  const known = new Set(trusted.map(fingerprint))
  const add = (pem: string) => {
    const id = fingerprint(pem)
    if (known.has(id)) return false
    known.add(id)
    trusted.push(pem)
    return true
  }

  let fromSystem = 0
  if (process.env.TLS_TRUST_SYSTEM_STORE?.trim().toLowerCase() !== "false") {
    try {
      for (const pem of tls.getCACertificates("system")) if (add(pem)) fromSystem += 1
    } catch (error) {
      console.error(`[tls] The operating system's certificate store could not be read: ${(error as Error).message}`)
    }
  }

  let fromFiles = 0
  for (const file of (process.env.TLS_EXTRA_CA_FILE ?? "").split(delimiter).map((item) => item.trim()).filter(Boolean)) {
    try {
      const certificates = readCertificates(file)
      if (certificates.length === 0) {
        console.error(`[tls] ${file} holds no certificate. Export the CA certificate as Base-64 (PEM) or DER (.cer).`)
      }
      for (const certificate of certificates) {
        if (!certificate.ca) console.warn(`[tls] ${file}: "${certificate.subject.replace(/\n/g, ", ")}" is not a CA certificate; trusting it anyway.`)
        if (add(certificate.toString())) fromFiles += 1
      }
    } catch (error) {
      console.error(`[tls] TLS_EXTRA_CA_FILE ${file} could not be read: ${(error as Error).message}`)
    }
  }

  if (fromSystem + fromFiles > 0) tls.setDefaultCACertificates(trusted)
  console.info(
    `[tls] Outbound HTTPS trusts ${trusted.length} certificate authorities (added ${fromSystem} from the operating system and ${fromFiles} from TLS_EXTRA_CA_FILE). Certificate verification is on.`
  )
}

/** The certificates in a PEM bundle or a single DER file. */
function readCertificates(file: string): X509Certificate[] {
  const content = readFileSync(file)
  const blocks = content.toString("latin1").match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)
  if (blocks) return blocks.map((block) => new X509Certificate(block))
  return [new X509Certificate(content)]
}

function fingerprint(pem: string) {
  try {
    return new X509Certificate(pem).fingerprint256
  } catch {
    return pem.replace(/\s+/g, "")
  }
}
