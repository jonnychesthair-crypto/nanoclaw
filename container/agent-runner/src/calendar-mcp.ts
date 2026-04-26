#!/usr/bin/env node
/**
 * Vendored Google Calendar MCP server for NanoClaw.
 * Based on @gongrzhe/server-calendar-autoauth-mcp with multi-calendar support.
 *
 * Reads CALENDAR_IDS env var (comma-separated) to query multiple calendars.
 * Defaults to "primary" if not set.  Write operations (create/update/delete)
 * always target "primary" since imported calendars are read-only.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { google, calendar_v3 } from "googleapis";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// zod v4 types aren't compatible with zodToJsonSchema's v3 type signatures
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toJsonSchema = (schema: any) => zodToJsonSchema(schema);
import { OAuth2Client } from "google-auth-library";
import fs from "fs";
import path from "path";
import os from "os";

const CONFIG_DIR = path.join(os.homedir(), ".calendar-mcp");
const OAUTH_PATH =
  process.env.CALENDAR_OAUTH_PATH || path.join(CONFIG_DIR, "gcp-oauth.keys.json");
const CREDENTIALS_PATH =
  process.env.CALENDAR_CREDENTIALS_PATH || path.join(CONFIG_DIR, "credentials.json");

const calendarIds = (process.env.CALENDAR_IDS || "primary")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

let oauth2Client: OAuth2Client;

async function loadCredentials() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }

  const localOAuthPath = path.join(process.cwd(), "gcp-oauth.keys.json");
  if (fs.existsSync(localOAuthPath)) {
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
const CreateEventSchema = z.object({
  summary: z.string().describe("Event title"),
  start: z.object({
    dateTime: z.string().describe("Start time (ISO format)"),
    timeZone: z.string().optional().describe("Time zone"),
  }),
  end: z.object({
    dateTime: z.string().describe("End time (ISO format)"),
    timeZone: z.string().optional().describe("Time zone"),
  }),
  description: z.string().optional().describe("Event description"),
  location: z.string().optional().describe("Event location"),
});

const GetEventSchema = z.object({
  eventId: z.string().describe("ID of the event to retrieve"),
  calendarId: z.string().optional().describe("Calendar ID (defaults to primary)"),
});

const UpdateEventSchema = z.object({
  eventId: z.string().describe("ID of the event to update"),
  summary: z.string().optional().describe("New event title"),
  start: z
    .object({
      dateTime: z.string().describe("New start time (ISO format)"),
      timeZone: z.string().optional().describe("Time zone"),
    })
    .optional(),
  end: z
    .object({
      dateTime: z.string().describe("New end time (ISO format)"),
      timeZone: z.string().optional().describe("Time zone"),
    })
    .optional(),
  description: z.string().optional().describe("New event description"),
  location: z.string().optional().describe("New event location"),
});

const DeleteEventSchema = z.object({
  eventId: z.string().describe("ID of the event to delete"),
});

const ListEventsSchema = z.object({
  timeMin: z.string().describe("Start of time range (ISO format)"),
  timeMax: z.string().describe("End of time range (ISO format)"),
  maxResults: z
    .number()
    .optional()
    .describe("Maximum number of events to return per calendar"),
  orderBy: z
    .enum(["startTime", "updated"])
    .optional()
    .describe("Sort order"),
});

async function main() {
  await loadCredentials();

  const calendar = google.calendar({ version: "v3", auth: oauth2Client });

  const server = new Server(
    {
      name: "google-calendar",
      version: "1.1.0",
    },
    {
      capabilities: { tools: {} },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "create_event",
        description: "Creates a new event in Google Calendar (primary calendar)",
        inputSchema: toJsonSchema(CreateEventSchema),
      },
      {
        name: "get_event",
        description: "Retrieves details of a specific event",
        inputSchema: toJsonSchema(GetEventSchema),
      },
      {
        name: "update_event",
        description: "Updates an existing event (primary calendar only)",
        inputSchema: toJsonSchema(UpdateEventSchema),
      },
      {
        name: "delete_event",
        description: "Deletes an event (primary calendar only)",
        inputSchema: toJsonSchema(DeleteEventSchema),
      },
      {
        name: "list_events",
        description: `Lists events within a time range across all configured calendars: ${calendarIds.join(", ")}`,
        inputSchema: toJsonSchema(ListEventsSchema),
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      switch (name) {
        case "create_event": {
          const v = CreateEventSchema.parse(args);
          const response = await calendar.events.insert({
            calendarId: "primary",
            requestBody: v,
          });
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Event created with ID: ${response.data.id}\n` +
                  `Title: ${v.summary}\n` +
                  `Start: ${v.start.dateTime}\n` +
                  `End: ${v.end.dateTime}`,
              },
            ],
          };
        }

        case "get_event": {
          const v = GetEventSchema.parse(args);
          const response = await calendar.events.get({
            calendarId: v.calendarId || "primary",
            eventId: v.eventId,
          });
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(response.data, null, 2) },
            ],
          };
        }

        case "update_event": {
          const v = UpdateEventSchema.parse(args);
          const { eventId, ...updates } = v;
          const response = await calendar.events.patch({
            calendarId: "primary",
            eventId,
            requestBody: updates,
          });
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Event updated: ${eventId}\n` +
                  `New title: ${updates.summary || "(unchanged)"}\n` +
                  `New start: ${updates.start?.dateTime || "(unchanged)"}\n` +
                  `New end: ${updates.end?.dateTime || "(unchanged)"}`,
              },
            ],
          };
        }

        case "delete_event": {
          const v = DeleteEventSchema.parse(args);
          await calendar.events.delete({
            calendarId: "primary",
            eventId: v.eventId,
          });
          return {
            content: [
              { type: "text" as const, text: `Event deleted: ${v.eventId}` },
            ],
          };
        }

        case "list_events": {
          const v = ListEventsSchema.parse(args);
          const maxPerCal = v.maxResults || 10;

          // Query all configured calendars in parallel
          const results = await Promise.allSettled(
            calendarIds.map(async (calId) => {
              const response = await calendar.events.list({
                calendarId: calId,
                timeMin: v.timeMin,
                timeMax: v.timeMax,
                maxResults: maxPerCal,
                orderBy: v.orderBy || "startTime",
                singleEvents: true,
              });
              return {
                calendarId: calId,
                events: response.data.items || [],
              };
            })
          );

          // Merge results, tagging each event with its source calendar
          const allEvents: Array<calendar_v3.Schema$Event & { _calendar: string }> = [];
          const errors: string[] = [];

          for (const r of results) {
            if (r.status === "fulfilled") {
              for (const evt of r.value.events) {
                allEvents.push({ ...evt, _calendar: r.value.calendarId });
              }
            } else {
              errors.push(String(r.reason));
            }
          }

          // Sort merged results by start time
          allEvents.sort((a, b) => {
            const aTime = a.start?.dateTime || a.start?.date || "";
            const bTime = b.start?.dateTime || b.start?.date || "";
            return aTime.localeCompare(bTime);
          });

          let text = `Found ${allEvents.length} events across ${calendarIds.length} calendar(s):\n`;
          text += JSON.stringify(allEvents, null, 2);
          if (errors.length > 0) {
            text += `\n\nErrors from some calendars:\n${errors.join("\n")}`;
          }

          return {
            content: [{ type: "text" as const, text }],
          };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `Google Calendar MCP Server running (calendars: ${calendarIds.join(", ")})`
  );
}

main().catch(console.error);
