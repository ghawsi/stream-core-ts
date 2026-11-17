import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"

/**
 * AES-256-GCM encryption for provider API keys.
 *
 * Payload format: `v1:<iv base64>:<auth tag base64>:<ciphertext base64>`.
 * The key comes from ENCRYPTION_KEY: 64 hex characters or 32 bytes in base64
 * are used as is; any other string is hashed with SHA-256 into a 32-byte key.
 */

const ALGORITHM = "aes-256-gcm"
const VERSION = "v1"
const IV_LENGTH = 12

export class EncryptionKeyMissingError extends Error {
  constructor() {
    super(
      "ENCRYPTION_KEY is not set on the server. Add a 32-byte key (64 hex characters) to .env, for example with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    )
    this.name = "EncryptionKeyMissingError"
  }
}

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY?.trim()
  if (!raw) throw new EncryptionKeyMissingError()

  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex")

  const base64 = Buffer.from(raw, "base64")
  if (base64.length === 32 && base64.toString("base64") === raw) return base64

  return createHash("sha256").update(raw, "utf8").digest()
}

export function encrypt(plainText: string): string {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, getKey(), iv)
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VERSION, iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(":")
}

export function decrypt(payload: string): string {
  const [version, iv, tag, data] = payload.split(":")
  // `data` is empty (but present) for an empty key, e.g. Ollama without a key.
  if (version !== VERSION || !iv || !tag || data === undefined) {
    throw new Error("The stored API key has an unknown format. Save the provider configuration again.")
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(iv, "base64"))
    decipher.setAuthTag(Buffer.from(tag, "base64"))
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8")
  } catch (error) {
    if (error instanceof EncryptionKeyMissingError) throw error
    throw new Error(
      "The stored API key could not be decrypted. ENCRYPTION_KEY may have changed since it was saved; enter the key again in /settings/ai."
    )
  }
}

/**
 * A display form of a key, e.g. "sk-••••••••••••1234": a short prefix such as
 * "sk-" and the last four characters. Short keys are hidden completely.
 */
export function maskApiKey(plainText: string): string {
  if (!plainText) return "No key"
  if (plainText.length < 12) return "••••••••"
  const prefix = /^[a-z]{2,4}-/i.exec(plainText)?.[0] ?? ""
  return `${prefix}••••••••••••${plainText.slice(-4)}`
}
