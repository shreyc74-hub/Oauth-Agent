// RFC 6238 TOTP (the six-digit authenticator codes), so the agent can pass 2FA it set up itself.
import { createHmac } from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** Accepts a bare base32 seed or an otpauth:// URI (as shown under "can't scan the QR code?"). */
export function seedFrom(text: string): string {
  const m = text.match(/secret=([A-Z2-7= ]+)/i);
  return (m ? m[1] : text).replace(/\s+/g, "").toUpperCase();
}

export function totp(seed: string, at = Date.now(), step = 30, digits = 6): string {
  const counter = Math.floor(at / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", base32Decode(seed)).update(buf).digest();
  const off = h[h.length - 1] & 15;
  const code = (h.readUInt32BE(off) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, "0");
}
