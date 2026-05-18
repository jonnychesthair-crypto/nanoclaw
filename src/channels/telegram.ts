import { Api, Bot, InputFile } from 'grammy';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

const execFileAsync = promisify(execFile);
const FFMPEG_PATH = path.join(
  process.env.HOME || '/root',
  '.local',
  'bin',
  'ffmpeg',
);
const GROQ_TRANSCRIPTION_URL =
  'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_TRANSCRIPTION_MODEL = 'whisper-large-v3-turbo';
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** If the file is a zip, extract the first audio file from it and return the new path. */
async function unzipIfNeeded(
  filePath: string,
  tmpDir: string,
): Promise<string> {
  const header = Buffer.alloc(4);
  const fd = await fs.promises.open(filePath, 'r');
  await fd.read(header, 0, 4, 0);
  await fd.close();
  if (!header.subarray(0, 4).equals(ZIP_MAGIC)) return filePath;

  await execFileAsync('unzip', ['-o', '-j', filePath, '-d', tmpDir]);
  const entries = await fs.promises.readdir(tmpDir);
  const audio = entries.find((f) =>
    /\.(m4a|mp3|ogg|opus|wav|aac|flac|wma)$/i.test(f),
  );
  if (!audio) throw new Error('Zip contained no recognizable audio file');
  return path.join(tmpDir, audio);
}

async function transcribeWithGroq(audioPath: string): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY is not set');

  const fileBuffer = await readFile(audioPath);
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const formData = new FormData();
      formData.append(
        'file',
        new Blob([fileBuffer], { type: 'audio/ogg' }),
        'audio.ogg',
      );
      formData.append('model', GROQ_TRANSCRIPTION_MODEL);
      formData.append('response_format', 'json');

      const res = await fetch(GROQ_TRANSCRIPTION_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData,
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok)
        throw new Error(
          `Groq transcription returned ${res.status}: ${await res.text()}`,
        );
      const json = (await res.json()) as any;
      return (json.text || '').trim() || '[inaudible]';
    } catch (err) {
      if (attempt < maxAttempts) {
        logger.warn(
          { attempt, maxAttempts },
          'Groq transcription attempt failed, retrying',
        );
        await new Promise((r) => setTimeout(r, 2_000));
      } else {
        throw err;
      }
    }
  }
  throw new Error('Groq transcription failed after retries');
}

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

/**
 * Download a file from the Bot API.
 * With --local mode, getFile returns absolute filesystem paths — read directly.
 * With the public API, it returns relative paths — download via HTTP.
 */
async function downloadFile(
  apiRoot: string | undefined,
  botToken: string,
  filePath: string,
): Promise<Buffer> {
  // Local Bot API server returns absolute paths on disk
  if (apiRoot && path.isAbsolute(filePath)) {
    return readFile(filePath);
  }
  const root = apiRoot || 'https://api.telegram.org';
  const url = `${root}/file/bot${botToken}/${filePath}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

/**
 * Save a downloaded file to the group's attachments directory.
 * Returns the path relative to the group folder (e.g. "attachments/photo_123.jpg").
 */
function saveAttachment(
  group: RegisteredGroup,
  fileName: string,
  buf: Buffer,
): string {
  const groupDir = resolveGroupFolderPath(group.folder);
  const attachDir = path.join(groupDir, 'attachments');
  fs.mkdirSync(attachDir, { recursive: true });

  // Prefix with timestamp to avoid collisions
  const ts = Date.now();
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const finalName = `${ts}_${safeName}`;
  const fullPath = path.join(attachDir, finalName);
  fs.writeFileSync(fullPath, buf);
  return path.join('attachments', finalName);
}

interface TextSegment {
  type: 'text';
  content: string;
}

interface CodeSegment {
  type: 'code';
  lang: string;
  content: string;
}

/**
 * Split a message into text and code block segments.
 * Code blocks (``` delimited) are extracted so they can be sent as file attachments.
 */
function _splitCodeBlocks(text: string): (TextSegment | CodeSegment)[] {
  const segments: (TextSegment | CodeSegment)[] = [];
  const regex = /```(\w*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    // Text before this code block
    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index).trim();
      if (before) segments.push({ type: 'text', content: before });
    }
    segments.push({ type: 'code', lang: match[1] || '', content: match[2] });
    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last code block
  if (lastIndex < text.length) {
    const after = text.slice(lastIndex).trim();
    if (after) segments.push({ type: 'text', content: after });
  }

  // No code blocks found - return as single text segment
  if (segments.length === 0) {
    segments.push({ type: 'text', content: text });
  }

  return segments;
}

/** Map common language identifiers to file extensions. */
function _langToExt(lang: string): string {
  const map: Record<string, string> = {
    typescript: 'ts',
    ts: 'ts',
    javascript: 'js',
    js: 'js',
    python: 'py',
    py: 'py',
    bash: 'sh',
    sh: 'sh',
    shell: 'sh',
    zsh: 'sh',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    html: 'html',
    css: 'css',
    sql: 'sql',
    rust: 'rs',
    go: 'go',
    java: 'java',
    cpp: 'cpp',
    c: 'c',
    ruby: 'rb',
    markdown: 'md',
    md: 'md',
    xml: 'xml',
    toml: 'toml',
    ini: 'ini',
    dockerfile: 'Dockerfile',
    docker: 'Dockerfile',
  };
  return map[lang.toLowerCase()] || 'txt';
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private apiRoot: string | undefined;

  constructor(botToken: string, opts: TelegramChannelOpts, apiRoot?: string) {
    this.botToken = botToken;
    this.opts = opts;
    this.apiRoot = apiRoot;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(
      this.botToken,
      this.apiRoot
        ? {
            client: { apiRoot: this.apiRoot },
          }
        : {},
    );

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      try {
        // Get the highest-resolution photo (last in the array)
        const photos = ctx.message.photo;
        const photo = photos[photos.length - 1];
        const file = await ctx.api.getFile(photo.file_id);
        const filePath = file.file_path;

        if (!filePath) throw new Error('No file_path returned');

        const buf = await downloadFile(this.apiRoot, this.botToken, filePath);
        const ext = filePath.split('.').pop()?.toLowerCase() || 'jpg';
        const savedPath = saveAttachment(group, `photo.${ext}`, buf);

        const caption = ctx.message.caption ? `\n${ctx.message.caption}` : '';
        const content = `[Photo: ${savedPath}]${caption}`;

        const timestamp = new Date(ctx.message.date * 1000).toISOString();
        const senderName =
          ctx.from?.first_name ||
          ctx.from?.username ||
          ctx.from?.id?.toString() ||
          'Unknown';
        const isGroup =
          ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

        this.opts.onChatMetadata(
          chatJid,
          timestamp,
          undefined,
          'telegram',
          isGroup,
        );
        this.opts.onMessage(chatJid, {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
        });
      } catch (err) {
        logger.error({ err }, 'Failed to download Telegram photo');
        storeNonText(ctx, '[Photo]');
      }
    });
    this.bot.on('message:video', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      try {
        const file = await ctx.api.getFile(ctx.message.video.file_id);
        const filePath = file.file_path;
        if (!filePath) throw new Error('No file_path returned');

        const buf = await downloadFile(this.apiRoot, this.botToken, filePath);
        const ext = filePath.split('.').pop()?.toLowerCase() || 'mp4';
        const savedPath = saveAttachment(group, `video.${ext}`, buf);

        const caption = ctx.message.caption ? `\n${ctx.message.caption}` : '';
        const content = `[Video: ${savedPath}]${caption}`;

        const timestamp = new Date(ctx.message.date * 1000).toISOString();
        const senderName =
          ctx.from?.first_name ||
          ctx.from?.username ||
          ctx.from?.id?.toString() ||
          'Unknown';
        const isGroup =
          ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

        this.opts.onChatMetadata(
          chatJid,
          timestamp,
          undefined,
          'telegram',
          isGroup,
        );
        this.opts.onMessage(chatJid, {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
        });
      } catch (err) {
        logger.error({ err }, 'Failed to download Telegram video');
        storeNonText(ctx, '[Video]');
      }
    });
    this.bot.on('message:voice', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      const sender = ctx.from?.id?.toString() || '';
      const msgId = ctx.message.message_id.toString();

      let savedPath: string | undefined;
      let buf: Buffer;
      let filePath: string;
      try {
        const file = await ctx.api.getFile(ctx.message.voice.file_id);
        filePath = file.file_path || '';
        if (!filePath) throw new Error('No file_path returned');

        buf = await downloadFile(this.apiRoot, this.botToken, filePath);
        const ext = filePath.split('.').pop()?.toLowerCase() || 'ogg';
        savedPath = saveAttachment(group, `voice.${ext}`, buf);
      } catch (err) {
        logger.error({ err }, 'Failed to download Telegram voice message');
        this.opts.onChatMetadata(
          chatJid,
          timestamp,
          undefined,
          'telegram',
          isGroup,
        );
        this.opts.onMessage(chatJid, {
          id: msgId,
          chat_jid: chatJid,
          sender,
          sender_name: senderName,
          content: '[Voice message] (download failed)',
          timestamp,
          is_from_me: false,
        });
        return;
      }

      const duration = ctx.message.voice.duration;

      // Deliver saved-file message immediately so grammy can continue polling
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content: `[Voice message: ${savedPath}] (transcribing...)`,
        timestamp,
        is_from_me: false,
      });

      // Transcribe in the background — does NOT block grammy update polling
      void (async () => {
        try {
          const tmpDir = await mkdtemp(path.join(tmpdir(), 'tg-voice-'));
          const inputPath = path.join(tmpDir, 'voice-in.ogg');
          const opusPath = path.join(tmpDir, 'voice.ogg');

          await writeFile(inputPath, buf);
          const audioPath = await unzipIfNeeded(inputPath, tmpDir);
          await execFileAsync(FFMPEG_PATH, [
            '-i',
            audioPath,
            '-ar',
            '16000',
            '-ac',
            '1',
            '-c:a',
            'libopus',
            '-b:a',
            '16k',
            opusPath,
            '-y',
          ]);

          const text = await transcribeWithGroq(opusPath);
          await fs.promises
            .rm(tmpDir, { recursive: true, force: true })
            .catch(() => {});

          // Deliver transcript as a follow-up message
          const transcriptTimestamp = new Date().toISOString();
          this.opts.onMessage(chatJid, {
            id: `${msgId}-transcript`,
            chat_jid: chatJid,
            sender,
            sender_name: senderName,
            content: `[Voice transcript] ${text}`,
            timestamp: transcriptTimestamp,
            is_from_me: false,
          });
          logger.info({ chatJid, duration }, 'Voice transcription completed');
        } catch (err) {
          logger.error({ err }, 'Background voice transcription failed');
          const failTimestamp = new Date().toISOString();
          this.opts.onMessage(chatJid, {
            id: `${msgId}-transcript`,
            chat_jid: chatJid,
            sender,
            sender_name: senderName,
            content: `[Voice message: ${savedPath}] (transcription failed)`,
            timestamp: failTimestamp,
            is_from_me: false,
          });
        }
      })();
    });
    this.bot.on('message:audio', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      const sender = ctx.from?.id?.toString() || '';
      const msgId = ctx.message.message_id.toString();

      let savedPath: string | undefined;
      let buf: Buffer;
      let filePath: string;
      try {
        const file = await ctx.api.getFile(ctx.message.audio.file_id);
        filePath = file.file_path || '';
        if (!filePath) throw new Error('No file_path returned');

        buf = await downloadFile(this.apiRoot, this.botToken, filePath);
        const ext = filePath.split('.').pop()?.toLowerCase() || 'mp3';
        const audioName = ctx.message.audio.file_name || `audio.${ext}`;
        savedPath = saveAttachment(group, audioName, buf);
      } catch (err) {
        logger.error({ err }, 'Failed to download Telegram audio file');
        this.opts.onChatMetadata(
          chatJid,
          timestamp,
          undefined,
          'telegram',
          isGroup,
        );
        this.opts.onMessage(chatJid, {
          id: msgId,
          chat_jid: chatJid,
          sender,
          sender_name: senderName,
          content: '[Audio] (download failed)',
          timestamp,
          is_from_me: false,
        });
        return;
      }

      const duration = ctx.message.audio.duration;

      // Deliver saved-file message immediately so grammy can continue polling
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content: `[Audio: ${savedPath}] (transcribing...)`,
        timestamp,
        is_from_me: false,
      });

      // Transcribe in the background — does NOT block grammy update polling
      void (async () => {
        try {
          const tmpDir = await mkdtemp(path.join(tmpdir(), 'tg-audio-'));
          const inputPath = path.join(
            tmpDir,
            'audio' + (path.extname(filePath) || '.mp3'),
          );
          const opusPath = path.join(tmpDir, 'audio.ogg');

          await writeFile(inputPath, buf);
          const audioPath = await unzipIfNeeded(inputPath, tmpDir);
          await execFileAsync(FFMPEG_PATH, [
            '-i',
            audioPath,
            '-ar',
            '16000',
            '-ac',
            '1',
            '-c:a',
            'libopus',
            '-b:a',
            '16k',
            opusPath,
            '-y',
          ]);

          const text = await transcribeWithGroq(opusPath);
          await fs.promises
            .rm(tmpDir, { recursive: true, force: true })
            .catch(() => {});

          // Deliver transcript as a follow-up message
          const transcriptTimestamp = new Date().toISOString();
          this.opts.onMessage(chatJid, {
            id: `${msgId}-transcript`,
            chat_jid: chatJid,
            sender,
            sender_name: senderName,
            content: `[Audio transcript] ${text}`,
            timestamp: transcriptTimestamp,
            is_from_me: false,
          });
          logger.info({ chatJid, duration }, 'Audio transcription completed');
        } catch (err) {
          logger.error({ err }, 'Background audio transcription failed');
          const failTimestamp = new Date().toISOString();
          this.opts.onMessage(chatJid, {
            id: `${msgId}-transcript`,
            chat_jid: chatJid,
            sender,
            sender_name: senderName,
            content: `[Audio: ${savedPath}] (transcription failed)`,
            timestamp: failTimestamp,
            is_from_me: false,
          });
        }
      })();
    });
    this.bot.on('message:document', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const fileName = ctx.message.document?.file_name || 'file';

      try {
        const file = await ctx.api.getFile(ctx.message.document!.file_id);
        const filePath = file.file_path;
        if (!filePath) throw new Error('No file_path returned');

        const buf = await downloadFile(this.apiRoot, this.botToken, filePath);
        const savedPath = saveAttachment(group, fileName, buf);
        const ext = fileName.split('.').pop()?.toLowerCase() || '';
        let extractedText = '';

        try {
          if (ext === 'docx') {
            const mammoth = await import('mammoth');
            const result = await mammoth.default.extractRawText({
              buffer: buf,
            });
            extractedText = result.value;
          } else if (ext === 'pdf') {
            const { PDFParse } = await import('pdf-parse');
            const parser = new PDFParse({ data: buf });
            const result = await parser.getText();
            extractedText = result.text;
            await parser.destroy();
          } else if (
            [
              'txt',
              'md',
              'csv',
              'json',
              'xml',
              'yaml',
              'yml',
              'log',
              'ini',
              'cfg',
              'conf',
              'sh',
              'ts',
              'js',
              'py',
              'html',
              'css',
              'sql',
            ].includes(ext)
          ) {
            extractedText = buf.toString('utf-8');
          }
        } catch (extractErr) {
          logger.warn(
            { extractErr, fileName },
            'Text extraction failed, file still saved',
          );
        }

        const caption = ctx.message.caption ? `\n${ctx.message.caption}` : '';
        const textPart = extractedText ? `\n${extractedText}` : '';
        const content = `[Document: ${fileName} | saved: ${savedPath}]${textPart}${caption}`;

        const timestamp = new Date(ctx.message.date * 1000).toISOString();
        const senderName =
          ctx.from?.first_name ||
          ctx.from?.username ||
          ctx.from?.id?.toString() ||
          'Unknown';
        const isGroup =
          ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

        this.opts.onChatMetadata(
          chatJid,
          timestamp,
          undefined,
          'telegram',
          isGroup,
        );
        this.opts.onMessage(chatJid, {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
        });
      } catch (err) {
        logger.error({ err, fileName }, 'Failed to process Telegram document');
        storeNonText(ctx, `[Document: ${fileName}]`);
      }
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const MAX_LENGTH = 4096;

      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }

      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  async sendFile(
    jid: string,
    filePath: string,
    fileName: string,
    caption?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const fileData = await readFile(filePath);
      await this.bot.api.sendDocument(
        numericId,
        new InputFile(fileData, fileName),
        {
          caption: caption || undefined,
        },
      );
      logger.info({ jid, fileName }, 'Telegram file sent');
    } catch (err) {
      logger.error({ jid, fileName, err }, 'Failed to send Telegram file');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_API_ROOT']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  const apiRoot =
    process.env.TELEGRAM_BOT_API_ROOT || envVars.TELEGRAM_BOT_API_ROOT || '';
  return new TelegramChannel(token, opts, apiRoot || undefined);
});
