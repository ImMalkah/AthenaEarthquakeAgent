import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

// Read HTML widget template
let earthquakeHtml = "";
try {
  const htmlPath = join(process.cwd(), "public", "earthquake-widget.html");
  earthquakeHtml = readFileSync(htmlPath, "utf8");
} catch (error) {
  console.error("Failed to read earthquake-widget.html:", error);
  // Fallback in case of pathing issues on Vercel
  earthquakeHtml = `<h1>Error loading Earthquake Widget template: ${error.message}</h1>`;
}

function createEarthquakeServer() {
  const server = new McpServer({
    name: "earthquake-explorer",
    version: "1.0.0"
  });

  // Register the widget resource
  server.registerResource(
    "earthquake-widget",
    "ui://widget/earthquake.html",
    {},
    async () => ({
      contents: [
        {
          uri: "ui://widget/earthquake.html",
          mimeType: "text/html+skybridge",
          text: earthquakeHtml,
          _meta: {
            "openai/widgetPrefersBorder": true,
            "openai/widgetDomain": "https://athenachat.bot",
            "openai/widgetCSP": {
              connect_domains: [
                "https://athenachat.bot",
                "https://*.athenachat.bot",
                "https://earthquake.usgs.gov"
              ],
              resource_domains: [
                "https://*.athenachat.bot",
                "https://*.oaistatic.com",
                "https://unpkg.com",
                "https://*.tile.openstreetmap.org",
                "https://cdnjs.cloudflare.com",
                "https://*.basemaps.cartocdn.com"
              ]
            }
          }
        }
      ]
    })
  );

  // Register the get_earthquakes tool
  server.registerTool(
    "get_earthquakes",
    {
      title: "Get Earthquakes",
      description: "Query and retrieve recent earthquakes by magnitude, place, depth, and time range.",
      inputSchema: {
        minMagnitude: z.coerce.number().optional().default(2.5),
        maxMagnitude: z.coerce.number().optional(),
        startTime: z.string().optional(),
        endTime: z.string().optional(),
        limit: z.coerce.number().optional().default(100),
      },
      _meta: {
        "openai/outputTemplate": "ui://widget/earthquake.html",
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "Searching USGS earthquake database",
        "openai/toolInvocation/invoked": "Retrieved earthquakes from USGS",
      }
    },
    async (args) => {
      const minMagnitude = args?.minMagnitude ?? 2.5;
      const maxMagnitude = args?.maxMagnitude;
      const limit = args?.limit ?? 100;
      
      // Default dates (past 7 days if not provided)
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      
      const startTime = args?.startTime ?? sevenDaysAgo.toISOString();
      const endTime = args?.endTime ?? now.toISOString();

      try {
        const queryUrl = new URL("https://earthquake.usgs.gov/fdsnws/event/1/query");
        queryUrl.searchParams.set("format", "geojson");
        queryUrl.searchParams.set("minmagnitude", String(minMagnitude));
        if (maxMagnitude !== undefined) {
          queryUrl.searchParams.set("maxmagnitude", String(maxMagnitude));
        }
        queryUrl.searchParams.set("starttime", startTime);
        queryUrl.searchParams.set("endtime", endTime);
        queryUrl.searchParams.set("limit", String(limit));

        console.log(`Fetching from USGS: ${queryUrl.toString()}`);
        const response = await fetch(queryUrl.toString());
        
        if (!response.ok) {
          throw new Error(`USGS API returned code ${response.status}`);
        }

        const geojson = await response.json();
        
        // Map geojson features to clean simple JSON structure
        const earthquakes = (geojson.features || []).map(feature => {
          return {
            id: feature.id,
            magnitude: feature.properties.mag ?? 0,
            place: feature.properties.place ?? "Unknown Location",
            time: feature.properties.time ?? Date.now(),
            depth: feature.geometry?.coordinates?.[2] ?? 0,
            lat: feature.geometry?.coordinates?.[1] ?? 0,
            lng: feature.geometry?.coordinates?.[0] ?? 0,
            tsunami: feature.properties.tsunami ?? 0
          };
        });

        const sortedEarthquakes = earthquakes.sort((a, b) => b.time - a.time);

        return {
          content: [
            {
              type: "text",
              text: `Retrieved ${sortedEarthquakes.length} earthquakes matching criteria (Magnitude >= ${minMagnitude}, Time range: ${new Date(startTime).toLocaleDateString()} to ${new Date(endTime).toLocaleDateString()}).`
            }
          ],
          structuredContent: {
            earthquakes: sortedEarthquakes,
            query: {
              minMagnitude,
              maxMagnitude,
              startTime,
              endTime,
              limit
            }
          }
        };
      } catch (err) {
        console.error("USGS API call error:", err);
        return {
          content: [
            {
              type: "text",
              text: `Error retrieving data from USGS: ${err.message}`
            }
          ],
          structuredContent: {
            earthquakes: [],
            error: err.message,
            query: {
              minMagnitude,
              startTime,
              endTime,
              limit
            }
          }
        };
      }
    }
  );

  return server;
}

export default async function handler(req, res) {
  // Setup CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "content-type, mcp-session-id");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const server = createEarthquakeServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error handling MCP request in handler:", error);
    if (!res.headersSent) {
      res.writeHead(500).end("Internal server error");
    }
  }
}
