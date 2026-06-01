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

function createEarthquakeServer(req) {
  let origin = "https://athenachat.bot";
  if (req && req.headers) {
    if (req.headers.origin) {
      origin = req.headers.origin;
    } else if (req.headers.referer) {
      try {
        origin = new URL(req.headers.referer).origin;
      } catch (e) {}
    }
  }

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
            "openai/widgetPrefersBorder": true
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
        locationSearch: z.string().optional().describe("Filter by place name or region, e.g. 'Chile', 'Japan', 'California'"),
        minLatitude: z.coerce.number().optional().describe("Minimum latitude for geographic bounding box"),
        maxLatitude: z.coerce.number().optional().describe("Maximum latitude for geographic bounding box"),
        minLongitude: z.coerce.number().optional().describe("Minimum longitude for geographic bounding box"),
        maxLongitude: z.coerce.number().optional().describe("Maximum longitude for geographic bounding box"),
        latitude: z.coerce.number().optional().describe("Latitude for radial search center (used with maxRadiusKm)"),
        longitude: z.coerce.number().optional().describe("Longitude for radial search center (used with maxRadiusKm)"),
        maxRadiusKm: z.coerce.number().optional().describe("Maximum search radius in kilometers around the latitude/longitude center"),
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
      const locationSearch = args?.locationSearch;
      
      const minLatitude = args?.minLatitude;
      const maxLatitude = args?.maxLatitude;
      const minLongitude = args?.minLongitude;
      const maxLongitude = args?.maxLongitude;
      const latitude = args?.latitude;
      const longitude = args?.longitude;
      const maxRadiusKm = args?.maxRadiusKm;
      
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
        
        // Bounding box query params
        if (minLatitude !== undefined) queryUrl.searchParams.set("minlatitude", String(minLatitude));
        if (maxLatitude !== undefined) queryUrl.searchParams.set("maxlatitude", String(maxLatitude));
        if (minLongitude !== undefined) queryUrl.searchParams.set("minlongitude", String(minLongitude));
        if (maxLongitude !== undefined) queryUrl.searchParams.set("maxlongitude", String(maxLongitude));
        
        // Radial query params
        if (latitude !== undefined) queryUrl.searchParams.set("latitude", String(latitude));
        if (longitude !== undefined) queryUrl.searchParams.set("longitude", String(longitude));
        if (maxRadiusKm !== undefined) queryUrl.searchParams.set("maxradiuskm", String(maxRadiusKm));
        
        // If searching a location, increase initial limit so we have enough data to filter down from
        const fetchLimit = locationSearch ? 2000 : limit;
        queryUrl.searchParams.set("limit", String(fetchLimit));

        console.log(`Fetching from USGS: ${queryUrl.toString()}`);
        const response = await fetch(queryUrl.toString());
        
        if (!response.ok) {
          throw new Error(`USGS API returned code ${response.status}`);
        }

        const geojson = await response.json();
        
        // Map geojson features to clean simple JSON structure
        let earthquakes = (geojson.features || []).map(feature => {
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

        if (locationSearch) {
          const searchLower = locationSearch.toLowerCase().trim();
          earthquakes = earthquakes.filter(eq => 
            eq.place.toLowerCase().includes(searchLower)
          );
        }

        const sortedEarthquakes = earthquakes.sort((a, b) => b.time - a.time).slice(0, limit);

        return {
          content: [
            {
              type: "text",
              text: `Retrieved ${sortedEarthquakes.length} earthquakes matching criteria (Location: ${locationSearch ?? "Global"}, Magnitude >= ${minMagnitude}, Time range: ${new Date(startTime).toLocaleDateString()} to ${new Date(endTime).toLocaleDateString()}).`
            }
          ],
          structuredContent: {
            earthquakes: sortedEarthquakes,
            query: {
              minMagnitude,
              maxMagnitude,
              startTime,
              endTime,
              limit,
              locationSearch
            }
          },
          _meta: {
            "openai/outputTemplate": "ui://widget/earthquake.html",
            "ui": {
              "resourceUri": "ui://widget/earthquake.html"
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
          },
          _meta: {
            "openai/outputTemplate": "ui://widget/earthquake.html",
            "ui": {
              "resourceUri": "ui://widget/earthquake.html"
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

  const server = createEarthquakeServer(req);
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
