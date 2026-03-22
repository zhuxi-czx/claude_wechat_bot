import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { log } from "../config.js";
import type { MessageItem } from "./types.js";

const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

/**
 * AES-128-ECB decrypt.
 */
function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Parse AES key from base64, supporting two formats:
 * 1. base64(raw 16 bytes) → 16-byte key directly
 * 2. base64(hex string of 16 bytes) → decode hex → 16-byte key
 */
function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) {
    return decoded;
  }
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(`Invalid AES key format (length=${decoded.length})`);
}

/**
 * Download encrypted media from CDN and decrypt with AES-128-ECB.
 */
async function downloadAndDecrypt(
  encryptQueryParam: string,
  aesKeyBase64: string,
  cdnBaseUrl = CDN_BASE_URL,
): Promise<Buffer> {
  const url = `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
  log.debug(`CDN download: ${url.slice(0, 80)}...`);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`CDN download failed: ${res.status} ${res.statusText}`);
  }

  const encrypted = Buffer.from(await res.arrayBuffer());
  const key = parseAesKey(aesKeyBase64);
  const decrypted = decryptAesEcb(encrypted, key);

  log.debug(`CDN decrypted: ${encrypted.length} → ${decrypted.length} bytes`);
  return decrypted;
}

/**
 * Detect image format from magic bytes.
 */
function detectImageExt(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xd8) return ".jpg";
  if (buf[0] === 0x89 && buf[1] === 0x50) return ".png";
  if (buf[0] === 0x47 && buf[1] === 0x49) return ".gif";
  if (buf[0] === 0x52 && buf[1] === 0x49) return ".webp";
  return ".jpg"; // default
}

/**
 * Download and save an image from a WeChat message ImageItem.
 * Returns the local file path, or null if no image data.
 */
export async function downloadImage(
  item: MessageItem,
  tempDir: string,
): Promise<string | null> {
  if (item.type !== 2) return null; // Not IMAGE type

  const img = item.image_item;
  if (!img?.media?.encrypt_query_param) return null;

  // Prefer image_item.aeskey (hex) over media.aes_key (base64)
  let aesKeyBase64: string | undefined;
  if (img.aeskey) {
    aesKeyBase64 = Buffer.from(img.aeskey, "hex").toString("base64");
  } else if (img.media.aes_key) {
    aesKeyBase64 = img.media.aes_key;
  }

  if (!aesKeyBase64) {
    log.warn("Image has encrypt_query_param but no AES key, skipping");
    return null;
  }

  try {
    const buf = await downloadAndDecrypt(img.media.encrypt_query_param, aesKeyBase64);
    const ext = detectImageExt(buf);
    const filename = `img_${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`;

    fs.mkdirSync(tempDir, { recursive: true });
    const filePath = path.join(tempDir, filename);
    fs.writeFileSync(filePath, buf);

    log.info(`Image downloaded: ${filePath} (${buf.length} bytes)`);
    return filePath;
  } catch (err) {
    log.error(`Image download/decrypt failed: ${err}`);
    return null;
  }
}
