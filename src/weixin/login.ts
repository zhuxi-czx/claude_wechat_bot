import { log } from "../config.js";
import type { WeixinClient } from "./client.js";
import type { StateStore } from "../state/store.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normalize an ilink_bot_id like "6aae015d6e34@im.bot" to
 * a filesystem-safe key like "6aae015d6e34-im-bot".
 */
function normalizeAccountId(raw: string): string {
  return raw.replace(/@/g, "-").replace(/\./g, "-");
}

/**
 * Perform WeChat QR code login.
 *
 * Flow matches the official openclaw-weixin-cli:
 * 1. GET get_bot_qrcode?bot_type=3 → { qrcode, qrcode_img_content }
 * 2. Display QR in terminal (qrcode_img_content is a URL)
 * 3. Long-poll get_qrcode_status?qrcode={qrcode} until confirmed
 * 4. Save token as "{ilink_bot_id}:{bot_token}" with baseUrl and userId
 */
export async function performLogin(client: WeixinClient, store: StateStore): Promise<string> {
  log.info("Starting WeChat QR login...");

  const qrResponse = await client.fetchQrCode();
  if (!qrResponse.qrcode || !qrResponse.qrcode_img_content) {
    throw new Error("Failed to get QR code from server");
  }

  console.log("\n使用微信扫描以下二维码，以完成连接：\n");

  // Display QR code in terminal
  let qrterm: typeof import("qrcode-terminal");
  try {
    qrterm = await import("qrcode-terminal");
  } catch {
    throw new Error("qrcode-terminal not installed");
  }

  await new Promise<void>((resolve) => {
    qrterm.default.generate(qrResponse.qrcode_img_content, { small: true }, (qr: string) => {
      console.log(qr);
      resolve();
    });
  });

  console.log("等待扫码...\n");

  const timeoutMs = 480_000;
  const deadline = Date.now() + timeoutMs;
  let currentQrcode = qrResponse.qrcode;
  let scannedPrinted = false;
  let refreshCount = 0;
  const MAX_REFRESH = 3;

  while (Date.now() < deadline) {
    const status = await client.pollQrStatus(currentQrcode);

    switch (status.status) {
      case "wait":
        break;

      case "scaned":
        if (!scannedPrinted) {
          console.log("👀 已扫码，请在微信上确认...");
          scannedPrinted = true;
        }
        break;

      case "confirmed": {
        if (!status.ilink_bot_id || !status.bot_token) {
          throw new Error("Login confirmed but missing ilink_bot_id or bot_token");
        }

        // bot_token from server is already in "{ilink_bot_id}:{secret}" format
        // Use it directly, same as openclaw-weixin
        const fullToken = status.bot_token;
        const accountId = normalizeAccountId(status.ilink_bot_id);
        const baseUrl = status.baseurl || "https://ilinkai.weixin.qq.com";

        // Save account data (same structure as openclaw-weixin)
        store.saveAccount(accountId, {
          token: fullToken,
          savedAt: new Date().toISOString(),
          baseUrl,
          userId: status.ilink_user_id,
        });

        // Save the token for the main bot to use
        store.setToken(fullToken);

        // Set the scanning user as admin (owner of this bot)
        if (status.ilink_user_id) {
          store.setAdmin(status.ilink_user_id);
          log.info(`Admin set to: ${status.ilink_user_id}`);
        }

        console.log("\n✅ 与微信连接成功！");
        log.info(`Login successful: accountId=${accountId}, userId=${status.ilink_user_id}`);

        return fullToken;
      }

      case "expired": {
        refreshCount++;
        if (refreshCount > MAX_REFRESH) {
          throw new Error("QR code expired too many times");
        }

        console.log(`\n⏳ 二维码已过期，正在刷新...(${refreshCount}/${MAX_REFRESH})`);

        const newQr = await client.fetchQrCode();
        if (!newQr.qrcode || !newQr.qrcode_img_content) {
          throw new Error("Failed to refresh QR code");
        }

        currentQrcode = newQr.qrcode;
        scannedPrinted = false;

        console.log("🔄 新二维码已生成，请重新扫描\n");
        await new Promise<void>((resolve) => {
          qrterm.default.generate(newQr.qrcode_img_content, { small: true }, (qr: string) => {
            console.log(qr);
            resolve();
          });
        });
        break;
      }
    }

    await sleep(1000);
  }

  throw new Error("Login timed out");
}
