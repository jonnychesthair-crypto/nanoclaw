#!/usr/bin/env node
/**
 * Minimal Dropbox MCP server that works headless with refresh tokens.
 * Replaces the broken Go binary that requires a browser for OAuth.
 */
import { createInterface } from 'readline';

const CLIENT_ID = process.env.DROPBOX_CLIENT_ID || '';
const CLIENT_SECRET = process.env.DROPBOX_CLIENT_SECRET || '';
const REFRESH_TOKEN = process.env.DROPBOX_REFRESH_TOKEN || '';

let cachedAccessToken = process.env.DROPBOX_ACCESS_TOKEN || '';
let tokenExpiresAt = 0;

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && Date.now() < tokenExpiresAt) {
    return cachedAccessToken;
  }

  const resp = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: REFRESH_TOKEN,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });

  if (!resp.ok) {
    throw new Error(`Token refresh failed: ${resp.status} ${await resp.text()}`);
  }

  const data = await resp.json() as { access_token: string; expires_in: number };
  cachedAccessToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in - 300) * 1000;
  return cachedAccessToken;
}

async function dropboxApi(endpoint: string, body?: Record<string, unknown>): Promise<unknown> {
  const token = await getAccessToken();
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  const opts: RequestInit = { method: 'POST', headers };

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  const resp = await fetch(`https://api.dropboxapi.com/2${endpoint}`, opts);

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Dropbox API error: ${resp.status} ${text}`);
  }

  return resp.json();
}

async function dropboxDownload(path: string): Promise<{ metadata: unknown; content: string }> {
  const token = await getAccessToken();
  const resp = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Dropbox-API-Arg': JSON.stringify({ path }),
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Dropbox download error: ${resp.status} ${text}`);
  }

  const metadata = JSON.parse(resp.headers.get('dropbox-api-result') || '{}');
  const buf = Buffer.from(await resp.arrayBuffer());

  // Try UTF-8 text first, fall back to base64
  try {
    const text = buf.toString('utf-8');
    if (text.includes('\ufffd')) throw new Error('binary');
    return { metadata, content: text };
  } catch {
    return { metadata, content: `[base64] ${buf.toString('base64')}` };
  }
}

async function dropboxUpload(path: string, content: string, mode: string = 'add'): Promise<unknown> {
  const token = await getAccessToken();
  const isBase64 = content.startsWith('[base64] ');
  const buf = isBase64
    ? Buffer.from(content.replace('[base64] ', ''), 'base64')
    : Buffer.from(content, 'utf-8');

  const resp = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Dropbox-API-Arg': JSON.stringify({ path, mode, autorename: false, mute: false }),
      'Content-Type': 'application/octet-stream',
    },
    body: buf,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Dropbox upload error: ${resp.status} ${text}`);
  }

  return resp.json();
}

const TOOLS = [
  {
    name: 'dropbox_list',
    description: 'List files and folders in a Dropbox directory',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', default: '', description: 'Path to list (empty string for root)' } },
    },
  },
  {
    name: 'dropbox_search',
    description: 'Search for files and folders in Dropbox',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        path: { type: 'string', description: 'Path to search in (optional)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'dropbox_download',
    description: 'Download/read a file from Dropbox',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to the file' } },
      required: ['path'],
    },
  },
  {
    name: 'dropbox_upload',
    description: 'Upload a file to Dropbox',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Destination path' },
        content: { type: 'string', description: 'File content (text or base64 prefixed with [base64])' },
        mode: { type: 'string', enum: ['add', 'overwrite'], default: 'add' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'dropbox_get_metadata',
    description: 'Get metadata for a file or folder',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to the file or folder' } },
      required: ['path'],
    },
  },
  {
    name: 'dropbox_create_folder',
    description: 'Create a new folder in Dropbox',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path of the folder to create' } },
      required: ['path'],
    },
  },
  {
    name: 'dropbox_delete',
    description: 'Delete a file or folder',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to delete' } },
      required: ['path'],
    },
  },
  {
    name: 'dropbox_move',
    description: 'Move or rename a file or folder',
    inputSchema: {
      type: 'object',
      properties: {
        from_path: { type: 'string', description: 'Source path' },
        to_path: { type: 'string', description: 'Destination path' },
      },
      required: ['from_path', 'to_path'],
    },
  },
  {
    name: 'dropbox_check_auth',
    description: 'Check Dropbox authentication status',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function handleToolCall(name: string, args: Record<string, string>): Promise<unknown> {
  switch (name) {
    case 'dropbox_check_auth': {
      const account = await dropboxApi('/users/get_current_account');
      return { status: 'authenticated', account };
    }
    case 'dropbox_auth': {
      const account = await dropboxApi('/users/get_current_account');
      return { status: 'authenticated', account };
    }
    case 'dropbox_list': {
      const path = args.path || '';
      const result = await dropboxApi('/files/list_folder', { path, limit: 100 });
      return result;
    }
    case 'dropbox_search': {
      const body: Record<string, unknown> = { query: args.query };
      if (args.path) {
        body.options = { path: args.path };
      }
      return dropboxApi('/files/search_v2', body);
    }
    case 'dropbox_download': {
      return dropboxDownload(args.path);
    }
    case 'dropbox_upload': {
      return dropboxUpload(args.path, args.content, args.mode || 'add');
    }
    case 'dropbox_get_metadata': {
      return dropboxApi('/files/get_metadata', { path: args.path });
    }
    case 'dropbox_create_folder': {
      return dropboxApi('/files/create_folder_v2', { path: args.path });
    }
    case 'dropbox_delete': {
      return dropboxApi('/files/delete_v2', { path: args.path });
    }
    case 'dropbox_move': {
      return dropboxApi('/files/move_v2', { from_path: args.from_path, to_path: args.to_path });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function sendResponse(id: number | string, result: unknown) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(msg + '\n');
}

function sendError(id: number | string | null, code: number, message: string) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(msg + '\n');
}

const rl = createInterface({ input: process.stdin });

rl.on('line', async (line: string) => {
  let parsed: { id: number | string; method: string; params?: Record<string, unknown> };
  try {
    parsed = JSON.parse(line);
  } catch {
    sendError(null, -32700, 'Parse error');
    return;
  }

  const { id, method, params } = parsed;

  try {
    switch (method) {
      case 'initialize':
        sendResponse(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'dropbox-mcp', version: '1.0.0' },
        });
        break;
      case 'notifications/initialized':
        // No response needed
        break;
      case 'tools/list':
        sendResponse(id, { tools: TOOLS });
        break;
      case 'tools/call': {
        const toolName = (params as { name: string }).name;
        const toolArgs = ((params as { arguments?: Record<string, string> }).arguments) || {};
        try {
          const result = await handleToolCall(toolName, toolArgs);
          sendResponse(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          sendResponse(id, { content: [{ type: 'text', text: `Error: ${message}` }], isError: true });
        }
        break;
      }
      default:
        sendError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendError(id, -32603, message);
  }
});
