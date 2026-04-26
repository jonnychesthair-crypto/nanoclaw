#!/usr/bin/env node
/**
 * Google Drive MCP server for NanoClaw.
 * Provides file listing, search, read, and upload capabilities.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { google, drive_v3 } from "googleapis";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toJsonSchema = (schema: any) => zodToJsonSchema(schema);
import { OAuth2Client } from "google-auth-library";
import fs from "fs";
import path from "path";
import os from "os";

const CONFIG_DIR = path.join(os.homedir(), ".drive-mcp");
const OAUTH_PATH =
  process.env.DRIVE_OAUTH_PATH || path.join(CONFIG_DIR, "gcp-oauth.keys.json");
const CREDENTIALS_PATH =
  process.env.DRIVE_CREDENTIALS_PATH || path.join(CONFIG_DIR, "credentials.json");

let oauth2Client: OAuth2Client;

async function loadCredentials() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }

  const localOAuthPath = path.join(process.cwd(), "gcp-oauth.keys.json");
  if (fs.existsSync(localOAuthPath) && !fs.existsSync(OAUTH_PATH)) {
    fs.copyFileSync(localOAuthPath, OAUTH_PATH);
  }

  if (!fs.existsSync(OAUTH_PATH)) {
    console.error("Error: OAuth keys file not found at", OAUTH_PATH);
    process.exit(1);
  }

  const keysContent = JSON.parse(fs.readFileSync(OAUTH_PATH, "utf8"));
  const keys = keysContent.installed || keysContent.web;
  if (!keys) {
    console.error("Error: Invalid OAuth keys file format.");
    process.exit(1);
  }

  oauth2Client = new OAuth2Client(
    keys.client_id,
    keys.client_secret,
    "http://localhost:3000/oauth2callback"
  );

  if (fs.existsSync(CREDENTIALS_PATH)) {
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
    oauth2Client.setCredentials(credentials);
  }
}

// Schemas
const ListFilesSchema = z.object({
  query: z.string().optional().describe("Drive search query (e.g. \"name contains 'report'\" or \"mimeType='application/pdf'\")"),
  folderId: z.string().optional().describe("Folder ID to list contents of (defaults to root)"),
  maxResults: z.number().optional().describe("Maximum files to return (default 20)"),
  orderBy: z.string().optional().describe("Sort order (e.g. 'modifiedTime desc', 'name')"),
});

const SearchFilesSchema = z.object({
  name: z.string().optional().describe("File name to search for (partial match)"),
  mimeType: z.string().optional().describe("MIME type filter (e.g. 'application/pdf', 'application/vnd.google-apps.spreadsheet')"),
  fullText: z.string().optional().describe("Full-text search within file contents"),
  maxResults: z.number().optional().describe("Maximum files to return (default 20)"),
});

const ReadFileSchema = z.object({
  fileId: z.string().describe("ID of the file to read"),
});

const GetFileMetadataSchema = z.object({
  fileId: z.string().describe("ID of the file"),
});

const CreateFileSchema = z.object({
  name: z.string().describe("File name"),
  content: z.string().describe("File content (text)"),
  mimeType: z.string().optional().describe("MIME type (default: text/plain)"),
  folderId: z.string().optional().describe("Parent folder ID"),
});

const CreateFolderSchema = z.object({
  name: z.string().describe("Folder name"),
  parentFolderId: z.string().optional().describe("Parent folder ID"),
});

async function main() {
  await loadCredentials();

  const drive = google.drive({ version: "v3", auth: oauth2Client });

  const server = new Server(
    { name: "google-drive", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "list_files",
        description: "List files in Google Drive, optionally filtered by folder or query",
        inputSchema: toJsonSchema(ListFilesSchema),
      },
      {
        name: "search_files",
        description: "Search Google Drive files by name, type, or content",
        inputSchema: toJsonSchema(SearchFilesSchema),
      },
      {
        name: "read_file",
        description: "Read the text content of a file from Google Drive. Works with Google Docs (exported as text), PDFs, and other text files.",
        inputSchema: toJsonSchema(ReadFileSchema),
      },
      {
        name: "get_file_metadata",
        description: "Get detailed metadata for a file (name, size, modified date, sharing, etc.)",
        inputSchema: toJsonSchema(GetFileMetadataSchema),
      },
      {
        name: "create_file",
        description: "Create a new text file in Google Drive",
        inputSchema: toJsonSchema(CreateFileSchema),
      },
      {
        name: "create_folder",
        description: "Create a new folder in Google Drive",
        inputSchema: toJsonSchema(CreateFolderSchema),
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      switch (name) {
        case "list_files": {
          const v = ListFilesSchema.parse(args);
          let q = v.query || "";
          if (v.folderId) {
            q = q ? `(${q}) and '${v.folderId}' in parents` : `'${v.folderId}' in parents`;
          }
          if (!q) q = "'root' in parents";
          q += " and trashed = false";

          const response = await drive.files.list({
            q,
            pageSize: v.maxResults || 20,
            orderBy: v.orderBy || "modifiedTime desc",
            fields: "files(id, name, mimeType, modifiedTime, size, parents)",
          });

          return {
            content: [{ type: "text" as const, text: JSON.stringify(response.data.files || [], null, 2) }],
          };
        }

        case "search_files": {
          const v = SearchFilesSchema.parse(args);
          const parts: string[] = ["trashed = false"];
          if (v.name) parts.push(`name contains '${v.name.replace(/'/g, "\\'")}'`);
          if (v.mimeType) parts.push(`mimeType = '${v.mimeType}'`);
          if (v.fullText) parts.push(`fullText contains '${v.fullText.replace(/'/g, "\\'")}'`);

          const response = await drive.files.list({
            q: parts.join(" and "),
            pageSize: v.maxResults || 20,
            orderBy: "modifiedTime desc",
            fields: "files(id, name, mimeType, modifiedTime, size, parents)",
          });

          return {
            content: [{ type: "text" as const, text: JSON.stringify(response.data.files || [], null, 2) }],
          };
        }

        case "read_file": {
          const v = ReadFileSchema.parse(args);
          // Get file metadata first to determine type
          const meta = await drive.files.get({ fileId: v.fileId, fields: "mimeType, name" });
          const mime = meta.data.mimeType || "";

          let text: string;
          if (mime.startsWith("application/vnd.google-apps.")) {
            // Google Workspace file — export as plain text
            const exportMime = mime === "application/vnd.google-apps.spreadsheet"
              ? "text/csv"
              : "text/plain";
            const res = await drive.files.export({ fileId: v.fileId, mimeType: exportMime }, { responseType: "text" });
            text = String(res.data);
          } else {
            // Binary/regular file — download
            const res = await drive.files.get({ fileId: v.fileId, alt: "media" }, { responseType: "text" });
            text = String(res.data);
          }

          return {
            content: [{ type: "text" as const, text: `File: ${meta.data.name}\n\n${text}` }],
          };
        }

        case "get_file_metadata": {
          const v = GetFileMetadataSchema.parse(args);
          const response = await drive.files.get({
            fileId: v.fileId,
            fields: "id, name, mimeType, modifiedTime, createdTime, size, parents, webViewLink, owners, shared, permissions",
          });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(response.data, null, 2) }],
          };
        }

        case "create_file": {
          const v = CreateFileSchema.parse(args);
          const response = await drive.files.create({
            requestBody: {
              name: v.name,
              mimeType: v.mimeType || "text/plain",
              parents: v.folderId ? [v.folderId] : undefined,
            },
            media: {
              mimeType: v.mimeType || "text/plain",
              body: v.content,
            },
            fields: "id, name, webViewLink",
          });
          return {
            content: [{
              type: "text" as const,
              text: `Created file: ${response.data.name} (ID: ${response.data.id})\nLink: ${response.data.webViewLink}`,
            }],
          };
        }

        case "create_folder": {
          const v = CreateFolderSchema.parse(args);
          const response = await drive.files.create({
            requestBody: {
              name: v.name,
              mimeType: "application/vnd.google-apps.folder",
              parents: v.parentFolderId ? [v.parentFolderId] : undefined,
            },
            fields: "id, name, webViewLink",
          });
          return {
            content: [{
              type: "text" as const,
              text: `Created folder: ${response.data.name} (ID: ${response.data.id})\nLink: ${response.data.webViewLink}`,
            }],
          };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return {
        content: [{
          type: "text" as const,
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Google Drive MCP Server running");
}

main().catch(console.error);
