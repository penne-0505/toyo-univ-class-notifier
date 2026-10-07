import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { loadProjectEnv } from './toyo-env';

/**
 * 通知の送り先を差し替え可能にした薄いラッパー。送り先は .env.local で選ぶ（複数あれば全部に送る）。
 *   TOYO_ALERT_DISCORD_WEBHOOK   Discord webhook URL
 *   TOYO_ALERT_NTFY_TOPIC        ntfy のトピック名（任意で TOYO_ALERT_NTFY_SERVER、既定 https://ntfy.sh）
 * どちらも未設定なら notify-send、それも失敗したら標準エラーに出すだけ。
 * notify() は決して例外を投げない（通知の失敗でジョブの結果を変えないため）。
 */

export type NotifyLevel = 'alert' | 'recovered' | 'info';
export type NotifyMessage = { level: NotifyLevel; title: string; body: string };
export type NotifyResult = { delivered: string[]; failed: string[] };

const DISCORD_LIMIT = 2000;
const NTFY_BODY_LIMIT = 1000;
const SEND_TIMEOUT_MS = 10_000;
const NOTIFY_SEND = '/usr/bin/notify-send';

const LEVEL_LABEL: Record<NotifyLevel, string> = { alert: 'ALERT', recovered: 'RECOVERED', info: 'INFO' };

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * 個人情報・鍵らしきものを伏せる。health.json（クラウドへ送る）と通知本文の両方に使う。
 *   - 学籍番号らしき 10 桁の数字
 *   - ログイン用の環境変数（TOYO_USERNAME / TOYO_PASSWORD）の値そのもの
 *   - Bearer トークン
 */
export function redactSensitive(text: string): string {
  let out = text;
  for (const name of ['TOYO_USERNAME', 'TOYO_PASSWORD']) {
    const value = process.env[name]?.trim();
    if (value && value.length >= 4) out = out.split(value).join('***');
  }
  return out.replace(/Bearer\s+\S+/gi, 'Bearer ***').replace(/(?<!\d)\d{10}(?!\d)/g, '**********');
}

/** 公開サーバー（ntfy.sh）へ送る本文用。URL と長いトークン様の文字列も落とす。 */
export function scrubForPublic(text: string): string {
  return redactSensitive(text)
    .replace(/https?:\/\/\S+/gi, '<url>')
    .replace(/[A-Za-z0-9_-]{32,}/g, '***');
}

async function post(url: string, init: { headers?: Record<string, string>; body: string }): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: init.headers,
    body: init.body,
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function sendDiscord(webhook: string, msg: NotifyMessage): Promise<void> {
  const content = truncate(`**[${LEVEL_LABEL[msg.level]}] ${msg.title}**\n${msg.body}`, DISCORD_LIMIT);
  await post(webhook, {
    headers: { 'Content-Type': 'application/json' },
    // エラー文中の @everyone などで誰かを呼び出さない
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  });
}

/** ntfy は UTF-8 のヘッダ値を RFC 2047（=?UTF-8?B?...?=）で受け取る。 */
function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

async function sendNtfy(server: string, topic: string, msg: NotifyMessage): Promise<void> {
  const headers: Record<string, string> = { Title: encodeHeader(scrubForPublic(msg.title)) };
  if (msg.level === 'alert') headers.Priority = 'high';
  await post(`${server.replace(/\/+$/, '')}/${encodeURIComponent(topic)}`, {
    headers,
    body: truncate(scrubForPublic(msg.body), NTFY_BODY_LIMIT),
  });
}

function sendDesktop(msg: NotifyMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(NOTIFY_SEND)) {
      reject(new Error('notify-send not found'));
      return;
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
    // systemd のユーザーサービスにはセッション DBus の場所が渡らないことがあるので補う
    const env = {
      ...process.env,
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=/run/user/${uid}/bus`,
    };
    const urgency = msg.level === 'alert' ? 'critical' : 'normal';
    const child = spawn(NOTIFY_SEND, ['-a', 'toyo', '-u', urgency, `[${LEVEL_LABEL[msg.level]}] ${msg.title}`, msg.body], {
      env,
      stdio: 'ignore',
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('notify-send timed out'));
    }, 5_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`notify-send exited with ${code}`));
    });
  });
}

export async function notify(msg: NotifyMessage): Promise<NotifyResult> {
  loadProjectEnv();
  const result: NotifyResult = { delivered: [], failed: [] };
  const attempts: Array<[string, () => Promise<void>]> = [];

  const webhook = process.env.TOYO_ALERT_DISCORD_WEBHOOK?.trim();
  if (webhook) attempts.push(['discord', () => sendDiscord(webhook, msg)]);

  const topic = process.env.TOYO_ALERT_NTFY_TOPIC?.trim();
  if (topic) {
    const server = process.env.TOYO_ALERT_NTFY_SERVER?.trim() || 'https://ntfy.sh';
    attempts.push(['ntfy', () => sendNtfy(server, topic, msg)]);
  }

  const configured = attempts.length > 0;
  if (!configured) attempts.push(['notify-send', () => sendDesktop(msg)]);

  for (const [name, send] of attempts) {
    try {
      await send();
      result.delivered.push(name);
    } catch (error) {
      // エラー文に URL（webhook など）が入りうるので、メッセージは出さず種別だけ残す
      result.failed.push(name);
      console.error(`[notify] ${name} failed (${error instanceof Error ? error.name : 'error'})`);
    }
  }

  // 何も届かなかったときは最後の手段として標準エラー（= journal）に残す
  if (result.delivered.length === 0) {
    console.error(`[notify] ${LEVEL_LABEL[msg.level]} ${msg.title}\n${msg.body}`);
    result.delivered.push('stderr');
  }
  return result;
}
