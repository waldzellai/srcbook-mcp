import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError
} from "@modelcontextprotocol/sdk/types.js";
import { getConfig } from '../config.mjs';
import { isValidSearchArgs, type CachedSearch } from './types';

class SrcbookMCPServer {
  private server: Server;
  private recentSearches: CachedSearch[] = [];

  constructor() {
    this.server = new Server({
      name: "srcbook-mcp",
      version: "1.0.0"
    }, {
      capabilities: {
        resources: {},
        tools: {}
      }
    });

    this.setupHandlers();
    this.setupErrorHandling();
  }

  private setupErrorHandling(): void {
    this.server.onerror = (error) => {
      console.error("[MCP Error]", error);
    };

    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupHandlers(): void {
    this.setupResourceHandlers();
    this.setupToolHandlers();
  }

  private setupResourceHandlers(): void {
    // List available resources (recent searches)
    this.server.setRequestHandler(
      ListResourcesRequestSchema,
      async () => ({
        resources: this.recentSearches.map((search, index) => ({
          uri: `srcbook://searches/${index}`,
          name: `Recent search: ${search.query}`,
          mimeType: "application/json",
          description: `Search results for: ${search.query} (${search.timestamp})`
        }))
      })
    );

    // Read specific resource
    this.server.setRequestHandler(
      ReadResourceRequestSchema,
      async (request) => {
        const match = request.params.uri.match(/^srcbook:\/\/searches\/(\d+)$/);
        if (!match) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Unknown resource: ${request.params.uri}`
          );
        }

        const index = parseInt(match[1]!);
        const search = this.recentSearches[index];

        if (!search) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Search result not found: ${index}`
          );
        }

        return {
          contents: [{
            uri: request.params.uri,
            mimeType: "application/json",
            text: JSON.stringify(search.response, null, 2)
          }]
        };
      }
    );
  }

  private setupToolHandlers(): void {
    // List available tools
    this.server.setRequestHandler(
      ListToolsRequestSchema,
      async () => ({
        tools: [{
          name: "search",
          description: "Search the web using Exa AI",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Search query"
              },
              numResults: {
                type: "number",
                description: "Number of results to return (default: 10)",
                minimum: 1,
                maximum: 50
              }
            },
            required: ["query"]
          }
        }]
      })
    );

    // Handle tool calls
    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request) => {
        if (request.params.name !== "search") {
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`
          );
        }

        if (!isValidSearchArgs(request.params.arguments)) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "Invalid search arguments"
          );
        }

        const config = await getConfig();
        if (!config.exaApiKey) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            "Exa API key not configured"
          );
        }

        try {
          const response = await fetch('https://api.exa.ai/search', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${config.exaApiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              query: request.params.arguments.query,
              type: "auto",
              numResults: request.params.arguments.numResults || 10,
              contents: {
                text: true
              }
            })
          });

          if (!response.ok) {
            throw new Error(`Exa API error: ${response.statusText}`);
          }

          const data = await response.json();

          // Cache the search result
          this.recentSearches.unshift({
            query: request.params.arguments.query,
            response: data,
            timestamp: new Date().toISOString()
          });

          // Keep only recent searches
          if (this.recentSearches.length > 5) {
            this.recentSearches.pop();
          }

          return {
            content: [{
              type: "text",
              text: JSON.stringify(data, null, 2)
            }]
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          throw new McpError(
            ErrorCode.InternalError,
            `Error while searching: ${errorMessage}`
          );
        }
      }
    );
  }

  async initialize(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.log("Srcbook MCP server running on stdio");
  }

  async stop(): Promise<void> {
    await this.server.close();
    console.log("Srcbook MCP server stopped");
  }
}

export { SrcbookMCPServer };