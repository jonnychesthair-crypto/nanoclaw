#!/usr/bin/env node
/**
 * Regrid Parcel Data MCP server for NanoClaw.
 * Provides parcel lookup by address, coordinates, owner, APN, and field queries.
 *
 * Reads REGRID_API_TOKEN env var for authentication.
 * API docs: https://support.regrid.com/api/parcel-api-endpoints
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toJsonSchema = (schema: any) => zodToJsonSchema(schema);

const API_BASE = "https://app.regrid.com/api/v2";
const TOKEN = process.env.REGRID_API_TOKEN || "";

if (!TOKEN) {
  console.error("[regrid-mcp] WARNING: REGRID_API_TOKEN not set");
}

// --- Schemas ---

const AddressSearchSchema = z.object({
  query: z.string().describe("Street address to search (e.g. '440 Burroughs Detroit MI')"),
  path: z.optional(z.string()).describe("Scope to a jurisdiction path (e.g. /us/mi/wayne/detroit)"),
  limit: z.optional(z.number()).describe("Max results (1-1000, default 10)"),
});

const PointSearchSchema = z.object({
  lat: z.number().describe("Latitude"),
  lon: z.number().describe("Longitude"),
  radius: z.optional(z.number()).describe("Search radius in meters (0-32000)"),
  limit: z.optional(z.number()).describe("Max results (1-1000, default 10)"),
});

const OwnerSearchSchema = z.object({
  owner: z.string().describe("Owner name to search (min 4 chars, matches start of name)"),
  path: z.optional(z.string()).describe("Scope to a jurisdiction path (e.g. /us/la/orleans)"),
  limit: z.optional(z.number()).describe("Max results (1-1000, default 10)"),
});

const ApnSearchSchema = z.object({
  parcelnumb: z.string().describe("Assessor parcel number"),
  path: z.optional(z.string()).describe("Scope to a jurisdiction path"),
  limit: z.optional(z.number()).describe("Max results (1-1000, default 10)"),
});

const FieldQuerySchemaObj = z.object({
  fields: z.record(z.string(), z.record(z.string(), z.string())).describe(
    "Field query object, e.g. {\"ll_gisacre\":{\"gte\":\"5\"}, \"usecode\":{\"eq\":\"R1\"}}. " +
    "Operators: eq, ne, isnull, between, gt, gte, lt, lte, in, nin, ilike, order"
  ),
  path: z.optional(z.string()).describe("Scope to a jurisdiction path"),
  limit: z.optional(z.number()).describe("Max results (1-1000, default 10)"),
});

const TypeaheadSchema = z.object({
  query: z.string().describe("Partial address for autocomplete"),
});

// --- API helpers ---

async function regridGet(endpoint: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(`${API_BASE}/${endpoint}`);
  url.searchParams.set("token", TOKEN);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, value);
    }
  }

  const resp = await fetch(url.toString());
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Regrid API error ${resp.status}: ${text}`);
  }
  return resp.json();
}

async function regridPost(endpoint: string, body: Record<string, unknown>): Promise<unknown> {
  const url = new URL(`${API_BASE}/${endpoint}`);
  url.searchParams.set("token", TOKEN);

  const resp = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Regrid API error ${resp.status}: ${text}`);
  }
  return resp.json();
}

function formatParcelSummary(data: unknown): string {
  const d = data as {
    parcels?: { features?: Array<{ properties?: Record<string, unknown>; geometry?: unknown }> };
    buildings?: { features?: unknown[] };
    zoning?: { features?: unknown[] };
  };

  const features = d.parcels?.features || [];
  if (features.length === 0) {
    return "No parcels found.";
  }

  const lines: string[] = [`Found ${features.length} parcel(s):\n`];

  for (const f of features) {
    const p = f.properties || {};
    lines.push("---");
    if (p.address) lines.push(`Address: ${p.address}`);
    if (p.owner) lines.push(`Owner: ${p.owner}`);
    if (p.parcelnumb) lines.push(`APN: ${p.parcelnumb}`);
    if (p.ll_gisacre) lines.push(`Acres: ${p.ll_gisacre}`);
    if (p.ll_gissqft) lines.push(`Sq ft: ${p.ll_gissqft}`);
    if (p.usecode) lines.push(`Use code: ${p.usecode}`);
    if (p.usedesc) lines.push(`Use: ${p.usedesc}`);
    if (p.zoning) lines.push(`Zoning: ${p.zoning}`);
    if (p.zoning_description) lines.push(`Zoning desc: ${p.zoning_description}`);
    if (p.improvval) lines.push(`Improvement value: $${p.improvval}`);
    if (p.landval) lines.push(`Land value: $${p.landval}`);
    if (p.parval) lines.push(`Total value: $${p.parval}`);
    if (p.saleprice) lines.push(`Last sale price: $${p.saleprice}`);
    if (p.saledate) lines.push(`Last sale date: ${p.saledate}`);
    if (p.yearbuilt) lines.push(`Year built: ${p.yearbuilt}`);
    if (p.ll_uuid) lines.push(`UUID: ${p.ll_uuid}`);
    if (p.path) lines.push(`Path: ${p.path}`);
    lines.push("");
  }

  const buildingCount = d.buildings?.features?.length || 0;
  const zoningCount = d.zoning?.features?.length || 0;
  if (buildingCount > 0) lines.push(`Buildings: ${buildingCount} found`);
  if (zoningCount > 0) lines.push(`Zoning records: ${zoningCount} found`);

  return lines.join("\n");
}

// --- MCP Server ---

const server = new Server(
  { name: "regrid", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "search_address",
      description: "Search parcels by street address. Returns owner, value, zoning, acreage, and more.",
      inputSchema: toJsonSchema(AddressSearchSchema),
    },
    {
      name: "search_point",
      description: "Search parcels by lat/lon coordinates (reverse geocode). Optionally specify a radius in meters.",
      inputSchema: toJsonSchema(PointSearchSchema),
    },
    {
      name: "search_owner",
      description: "Search parcels by owner name. Matches the start of the owner name string (min 4 chars).",
      inputSchema: toJsonSchema(OwnerSearchSchema),
    },
    {
      name: "search_apn",
      description: "Look up a parcel by assessor parcel number (APN). Scope with a path for accuracy.",
      inputSchema: toJsonSchema(ApnSearchSchema),
    },
    {
      name: "query_fields",
      description: "Advanced parcel query by field values. Supports operators: eq, ne, gt, gte, lt, lte, between, in, nin, ilike, isnull, order. Up to 4 fields. Example: {\"ll_gisacre\":{\"gte\":\"5\"}, \"usedesc\":{\"ilike\":\"%residential%\"}}",
      inputSchema: toJsonSchema(FieldQuerySchemaObj),
    },
    {
      name: "typeahead",
      description: "Address autocomplete/typeahead. Returns matching addresses with their parcel UUIDs for further lookup.",
      inputSchema: toJsonSchema(TypeaheadSchema),
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "search_address": {
        const { query, path: scopePath, limit } = AddressSearchSchema.parse(args);
        const params: Record<string, string> = { query, limit: String(limit || 10) };
        if (scopePath) params.path = scopePath;
        params.return_geometry = "false";
        const data = await regridGet("parcels/address", params);
        return { content: [{ type: "text", text: formatParcelSummary(data) }] };
      }

      case "search_point": {
        const { lat, lon, radius, limit } = PointSearchSchema.parse(args);
        const params: Record<string, string> = {
          lat: String(lat),
          lon: String(lon),
          limit: String(limit || 10),
          return_geometry: "false",
        };
        if (radius) params.radius = String(radius);
        const data = await regridGet("parcels/point", params);
        return { content: [{ type: "text", text: formatParcelSummary(data) }] };
      }

      case "search_owner": {
        const { owner, path: scopePath, limit } = OwnerSearchSchema.parse(args);
        const params: Record<string, string> = { owner, limit: String(limit || 10) };
        if (scopePath) params.path = scopePath;
        params.return_geometry = "false";
        const data = await regridGet("parcels/owner", params);
        return { content: [{ type: "text", text: formatParcelSummary(data) }] };
      }

      case "search_apn": {
        const { parcelnumb, path: scopePath, limit } = ApnSearchSchema.parse(args);
        const params: Record<string, string> = { parcelnumb, limit: String(limit || 10) };
        if (scopePath) params.path = scopePath;
        params.return_geometry = "false";
        const data = await regridGet("parcels/apn", params);
        return { content: [{ type: "text", text: formatParcelSummary(data) }] };
      }

      case "query_fields": {
        const parsed = FieldQuerySchemaObj.parse(args);
        const params: Record<string, string> = { limit: String(parsed.limit || 10), return_geometry: "false" };
        if (parsed.path) params.path = parsed.path;
        // Flatten fields into query params: fields[fieldName][operator]=value
        const fields = parsed.fields as Record<string, Record<string, string>>;
        for (const [fieldName, ops] of Object.entries(fields)) {
          for (const [op, val] of Object.entries(ops)) {
            params[`fields[${fieldName}][${op}]`] = val;
          }
        }
        const data = await regridGet("parcels/query", params);
        return { content: [{ type: "text", text: formatParcelSummary(data) }] };
      }

      case "typeahead": {
        const { query } = TypeaheadSchema.parse(args);
        const data = await regridGet("typeahead", { query });
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[regrid-mcp] Server started");
}

main().catch((err) => {
  console.error("[regrid-mcp] Fatal:", err);
  process.exit(1);
});
