export interface BaseInfo {
  channel_version: string;
}

export interface TextItem {
  text?: string;
}

export interface MessageItem {
  type?: number; // 1=TEXT, 2=IMAGE, 3=VOICE, 4=FILE, 5=VIDEO
  text_item?: TextItem;
  voice_item?: { text?: string };
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

export interface GetUpdatesRequest {
  get_updates_buf: string;
  base_info: BaseInfo;
}

export interface GetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface SendMessageRequest {
  msg: WeixinMessage;
  base_info: BaseInfo;
}

export interface GetConfigResponse {
  ret?: number;
  errmsg?: string;
  typing_ticket?: string;
}

export interface SendTypingRequest {
  ilink_user_id: string;
  typing_ticket: string;
  status: number; // 1=typing, 2=cancel
  base_info: BaseInfo;
}

export interface QrCodeResponse {
  ret?: number;
  qrcode_url?: string;
  session_key?: string;
  message?: string;
}

export interface QrCodeStatusResponse {
  ret?: number;
  status?: string; // "wait", "scaned", "expired", "confirmed"
  bot_token?: string;
  account_id?: string;
  user_id?: string;
  base_url?: string;
  qrcode?: string;
  message?: string;
}
