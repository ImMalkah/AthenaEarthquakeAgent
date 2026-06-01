import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const LOG_FILE = join(process.cwd(), "server.log");

// Initialize clear log file
try {
  writeFileSync(LOG_FILE, `=== Server Log Started at ${new Date().toISOString()} ===\n`, "utf8");
} catch (e) {
  console.error("Failed to initialize server.log file:", e.message);
}

function log(message, data = null) {
  const timestamp = new Date().toISOString();
  let logText = `[${timestamp}] ${message}`;
  if (data) {
    if (typeof data === "object") {
      logText += ` | Data: ${JSON.stringify(data, null, 2)}`;
    } else {
      logText += ` | Data: ${data}`;
    }
  }
  logText += "\n";
  
  // Output to console
  console.log(logText.trim());
  
  // Append to log file
  try {
    appendFileSync(LOG_FILE, logText, "utf8");
  } catch (e) {
    console.error("Failed to append to log file:", e.message);
  }
}

// Read HTML widget template
let earthquakeHtml = "";
try {
  const htmlPath = join(process.cwd(), "public", "earthquake-widget.html");
  earthquakeHtml = readFileSync(htmlPath, "utf8");
  log(`Successfully read earthquake-widget.html (${earthquakeHtml.length} bytes)`);
} catch (error) {
  log(`Failed to read earthquake-widget.html`, error);
  earthquakeHtml = `<h1>Error loading Earthquake Widget template: ${error.message}</h1>`;
}

function createEarthquakeServer(req = null) {
  // Extract client origin dynamically from request headers
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
  
  log(`Creating MCP server instance for origin: ${origin}`);

  const server = new McpServer({
    name: "earthquake-explorer",
    version: "1.0.0"
  });

  // Register the widget resource
  server.registerResource(
    "earthquake-widget",
    "ui://widget/earthquake.html",
    {},
    async () => {
      log("Resource 'ui://widget/earthquake.html' requested by client. Serving widget HTML...");
      return {
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
      };
    }
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
      log("Tool 'get_earthquakes' called with arguments", args);
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

        log(`Querying USGS API URL: ${queryUrl.toString()}`);
        const response = await fetch(queryUrl.toString());
        
        if (!response.ok) {
          throw new Error(`USGS API response code ${response.status}`);
        }

        const geojson = await response.json();
        const rawCount = geojson.features?.length ?? 0;
        log(`Successfully received ${rawCount} raw features from USGS`);
        
        let earthquakes = (geojson.features || []).map(feature => ({
          id: feature.id,
          magnitude: feature.properties.mag ?? 0,
          place: feature.properties.place ?? "Unknown Location",
          time: feature.properties.time ?? Date.now(),
          depth: feature.geometry?.coordinates?.[2] ?? 0,
          lat: feature.geometry?.coordinates?.[1] ?? 0,
          lng: feature.geometry?.coordinates?.[0] ?? 0,
          tsunami: feature.properties.tsunami ?? 0,
          alert: feature.properties.alert ?? null,
          felt: feature.properties.felt ?? null,
          sig: feature.properties.sig ?? 0
        }));

        if (locationSearch) {
          const searchLower = locationSearch.toLowerCase().trim();
          earthquakes = earthquakes.filter(eq => 
            eq.place.toLowerCase().includes(searchLower)
          );
          log(`Filtered to ${earthquakes.length} earthquakes containing place: "${locationSearch}"`);
        }

        const sortedEarthquakes = earthquakes.sort((a, b) => b.time - a.time).slice(0, limit);
        log(`Mapped, sorted, and limited to ${sortedEarthquakes.length} earthquakes. Returning response...`);

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
        log("Error during USGS data fetch", err.message);
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

const port = Number(process.env.PORT ?? 8787);

function isMcpPath(pathname) {
  return pathname === "/mcp" || pathname === "/mc" || pathname === "/mcp/" || pathname === "/mc/";
}

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  
  // Log request metadata
  const reqMeta = {
    method: req.method,
    url: req.url,
    headers: {
      host: req.headers.host,
      accept: req.headers.accept,
      origin: req.headers.origin,
      referer: req.headers.referer,
      "content-type": req.headers["content-type"],
      "mcp-session-id": req.headers["mcp-session-id"]
    }
  };
  log(`Incoming HTTP ${req.method} request to ${req.url}`, reqMeta);

  if (req.method === "OPTIONS" && isMcpPath(url.pathname)) {
    log("Handling CORS OPTIONS preflight request");
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE",
      "Access-Control-Allow-Headers": "content-type, mcp-session-id",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/plain" }).end("Earthquake MCP Local Server");
    return;
  }

  if (req.method === "GET" && url.pathname === "/earthquake-widget.html") {
    log("Serving earthquake-widget.html statically");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(earthquakeHtml);
    return;
  }

  const MCP_METHODS = new Set(["POST", "GET", "DELETE"]);
  if (isMcpPath(url.pathname) && req.method && MCP_METHODS.has(req.method)) {
    log(`Handling MCP request method ${req.method}`);
    
    // Set headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    
    const server = createEarthquakeServer(req);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    
    res.on("close", () => {
      log("Connection closed by client. Closing transport and server instances.");
      transport.close();
      server.close();
    });
    
    try {
      await server.connect(transport);
      
      // Since it's a raw Node server (no Vercel body-parser), let Hono parse the request stream
      await transport.handleRequest(req, res);
      log("MCP request successfully handled.");
    } catch (error) {
      log("Error handling MCP request in HTTP handler", error);
      if (!res.headersSent) {
        res.writeHead(500).end("Internal server error");
      }
    }
    return;
  }
  
  log(`Path ${url.pathname} not matched, returning 404`);
  res.writeHead(404).end("Not Found");
});

// Keep-alive mechanism to prevent the localhost.run tunnel from sleeping/timing out due to inactivity
function startTunnelKeepAlive() {
  const tunnelLogPath = join(process.cwd(), "tunnel.log");
  let tunnelUrl = null;

  const pingInterval = setInterval(async () => {
    try {
      const tunnelLog = readFileSync(tunnelLogPath, "utf8");
      const matches = tunnelLog.match(/https:\/\/[a-zA-Z0-9.-]+\.lhr\.life/g);
      if (matches && matches.length > 0) {
        const latestUrl = matches[matches.length - 1];
        if (latestUrl !== tunnelUrl) {
          tunnelUrl = latestUrl;
          log(`[Keep-Alive] Active tunnel URL updated to: ${tunnelUrl}`);
        }
      }
    } catch (e) {
      // Log file might not exist or be empty yet
    }

    if (tunnelUrl) {
      try {
        log(`[Keep-Alive] Sending keep-alive ping to ${tunnelUrl}...`);
        const res = await fetch(tunnelUrl);
        log(`[Keep-Alive] Ping response: ${res.status}`);
      } catch (err) {
        log(`[Keep-Alive] Ping failed: ${err.message}`);
      }
    }
  }, 120000); // Ping every 2 minutes

  // Make sure it doesn't block node from exiting
  pingInterval.unref();
}

httpServer.listen(port, () => {
  log(`Earthquake Local MCP server listening on http://localhost:${port}/mcp`);
  startTunnelKeepAlive();
});
