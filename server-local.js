import { createServer } from "node:http";
import handler from "./api/mcp.js";

const port = Number(process.env.PORT ?? 8787);

const server = createServer(async (req, res) => {
  // Mock request url parsing if needed (Node's req.url is just the pathname + query)
  if (req.url === "/") {
    res.writeHead(200, { "content-type": "text/plain" }).end("Earthquake MCP Server");
    return;
  }
  
  // Forward to Vercel handler
  await handler(req, res);
});

server.listen(port, () => {
  console.log(`Local MCP server listening on http://localhost:${port}/mcp`);
});
