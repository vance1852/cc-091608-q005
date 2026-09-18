/**
 * 处方签名与内容指纹。
 * 签名内容 = 处方字段的规范化 JSON（递归排序键），验签通过才允许下发。
 */
import { createHash, sign, verify, type KeyObject } from "node:crypto";

export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJSON(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJSON(record[key])}`)
    .join(",")}}`;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export interface SignatureMaterial {
  signature: string;
  keyId: string;
}

/** 用治疗师 Ed25519 私钥对处方规范化内容签名。 */
export function signCanonical(value: unknown, privateKey: KeyObject, keyId: string): SignatureMaterial {
  const bytes = Buffer.from(canonicalJSON(value), "utf8");
  const signature = sign(null, bytes, privateKey).toString("hex");
  return { signature, keyId };
}

/** 验签；失败抛错。任何下发路径都必须先通过本函数。 */
export function verifyCanonical(value: unknown, signatureHex: string, publicKey: KeyObject): void {
  const bytes = Buffer.from(canonicalJSON(value), "utf8");
  const ok = verify(null, bytes, publicKey, Buffer.from(signatureHex, "hex"));
  if (!ok) {
    throw new Error("处方签名验签失败：内容被篡改或密钥不匹配");
  }
}
