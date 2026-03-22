export interface BaseInfo {
  channel_version: string;
}

export interface TextItem {
  text?: string;
}

export interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
}

export interface ImageItem {
  media?: CDNMedia;
  thumb_media?: CDNMedia;
  aeskey?: string; // Raw AES key as hex string (preferred over media.aes_key)
  mid_size?: number;
  hd_size?: number;
}

export interface RefMessage {
  message_item?: MessageItem;
  title?: string;
}

export interface MessageItem {
  type?: number; // 1=TEXT, 2=IMAGE, 3=VOICE, 4=FILE, 5=VIDEO
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: { text?: string };
  ref_msg?: RefMessage;
}

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  session_id?: string;
  message_type?: number; // 1=USER, 2=BOT
  message_state?: number; // 0=NEW, 1=GENERATING, 2=FINISH
  item_list?: MessageItem[];
  context_token?: string;
}

export interface GetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface GetConfigResponse {
  ret?: number;
  errmsg?: string;
  typing_ticket?: string;
}

// QR login: GET ilink/bot/get_bot_qrcode?bot_type=3
export interface QrCodeResponse {
  qrcode: string;            // key for polling status
  qrcode_img_content: string; // URL to QR code image (used for terminal display)
}

// QR login: GET ilink/bot/get_qrcode_status?qrcode={qrcode}
export interface QrCodeStatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;     // e.g. "6aae015d6e34@im.bot"
  baseurl?: string;          // e.g. "https://ilinkai.weixin.qq.com"
  ilink_user_id?: string;    // e.g. "o9cq801y8at...@im.wechat"
}

// Stored account data (per-account JSON file)
export interface WeixinAccountData {
  token: string;             // "{ilink_bot_id}:{bot_token}"
  savedAt: string;
  baseUrl: string;
  userId?: string;           // ilink_user_id of the person who scanned
}
