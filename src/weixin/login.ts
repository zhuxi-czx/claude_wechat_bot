import { log } from "../config.js";
import type { WeixinClient } from "./client.js";
import type { StateStore } from "../state/store.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function performLogin(client: WeixinClient, store: StateStore): Promise<string> {
  log.info("Starting WeChat QR login...");

  const startResult = await client.startLogin();
  if (!startResult.qrcode_url) {
    throw new Error(`Failed to get QR code: ${startResult.message || "unknown error"}`);
  }

  console.log("\nScan the QR code below with WeChat to connect:\n");

  let qrcode: typeof import("qrcode-terminal");
  try {
    qrcode = await import("qrcode-terminal");
  } catch {
    throw new Error("qrcode-terminal not installed");
  }

  await new Promise<void>((resolve) => {
    qrcode.default.generate(startResult.qrcode_url!, { small: true }, (qr: string) => {
      console.log(qr);
      resolve();
    });
  });

  console.log("Waiting for scan...\n");

  const timeoutMs = 480_000;
  const startTime = Date.now();
  let currentQrcode = startResult.qrcode_url!;
  let refreshCount = 0;

  while (Date.now() - startTime < timeoutMs) {
    const status = await client.pollLoginStatus(currentQrcode);

    switch (status.status) {
      case "wait":
        break;

      case "scaned":
        log.info("QR code scanned, please confirm on your phone...");
        break;

      case "confirmed":
        if (status.bot_token) {
          log.info("Login successful!");
          store.setToken(status.bot_token);
          return status.bot_token;
        }
        throw new Error("Login confirmed but no token received");

      case "expired":
        refreshCount++;
        if (refreshCount > 3) {
          throw new Error("QR code expired too many times");
        }
        log.info("QR code expired, refreshing...");
        if (status.qrcode) {
          currentQrcode = status.qrcode;
          await new Promise<void>((resolve) => {
            qrcode.default.generate(status.qrcode!, { small: true }, (qr: string) => {
              console.log(qr);
              resolve();
            });
          });
        } else {
          const newStart = await client.startLogin();
          if (!newStart.qrcode_url) {
            throw new Error("Failed to refresh QR code");
          }
          currentQrcode = newStart.qrcode_url;
          await new Promise<void>((resolve) => {
            qrcode.default.generate(newStart.qrcode_url!, { small: true }, (qr: string) => {
              console.log(qr);
              resolve();
            });
          });
        }
        break;

      default:
        log.debug(`Unknown login status: ${status.status}`);
    }

    await sleep(2000);
  }

  throw new Error("Login timed out");
}
