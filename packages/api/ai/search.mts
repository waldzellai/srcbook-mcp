import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { 
  type SearchStatus, 
  type SearchStatusPayload, 
  type SearchResponse,
  type SearchResult,
  type SessionType 
} from '../types.mjs';
import type WebSocketServer from '../server/ws-client.mjs';
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourcesResultSchema,
  ReadResourceResultSchema,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * Custom error class for search-related errors
 * Includes the search query that caused the error for better error handling
 */
// Keep the existing SearchError
export class SearchError extends Error {
  constructor(message: string, public readonly searchQuery: string) {
    super(message);
    this.name = 'SearchError';
  }
}

// Add connection error
export class MCPConnectionError extends Error {
  constructor(message: string, public readonly searchQuery: string, public readonly cause?: Error) {
    super(message);
    this.name = 'MCPConnectionError';
  }
}

// Add timeout error
export class MCPTimeoutError extends Error {
  constructor(message: string, public readonly searchQuery: string) {
    super(message);
    this.name = 'MCPTimeoutError';
  }
}
/**
 * Main service class for handling Model Context Protocol operations
 * Manages search functionality, WebSocket communications, and result formatting
 */
export class McpService {
  private client: Client | null = null;
  private wss: WebSocketServer;
  private sessionId: string;
  // Limit tokens per search result to maintain reasonable response sizes
  private readonly maxTokensPerResult = 300;

  constructor(wss: WebSocketServer, sessionId: string) {
    this.wss = wss;
    this.sessionId = sessionId;
  }

  /**
   * Broadcasts search status updates to connected WebSocket clients
   */
  private broadcastStatus(status: SearchStatus, query: string, error?: string) {
    const payload: SearchStatusPayload = { status, query, error };
    this.wss.broadcast(`session:${this.sessionId}`, 'search:status', payload);
  }

  /**
   * Initializes or returns an existing MCP client
   * Sets up the transport layer and configures search capabilities
   */
  private async getClient() {
    if (this.client) {
      return this.client;
    }

    // Set up stdio transport for MCP server communication
    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['@exa/mcp-server'],
    });

    // Initialize client with search capabilities
    const client = new Client({
        name: "srcbook-client",
        version: "1.0.0",
      }, {
        capabilities: {
            search: {
                query: {
                    type: 'string',
                    description: 'The query to search for',
                },
                numResults: {
                    type: 'number',
                    description: 'The number of results to return',
                },
            }
        }
      });
    await client.connect(transport);

    // List available resources
const resources = await client.request(
  { method: "resources/list" },
  ListResourcesResultSchema
);

// Read a specific resource
const resourceContent = await client.request(
  {
    method: "resources/read",
    params: {
      resourceId: "resource-id", // Replace with actual resource ID
      options: {
        format: "text", // Or other format like "json", "binary" etc
        encoding: "utf-8" // Or other encoding as needed
      }
    }
  },
  ReadResourceResultSchema
);
    this.client = client;
    return client;
  }

  /**
   * Disconnects the MCP client and cleans up resources
   */
  public async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }

  /**
   * Truncates text content to stay within token limits while preserving readability
   * Attempts to break at sentence boundaries first, then word boundaries
   */
  private truncateContent(content: string, maxLength: number = this.maxTokensPerResult): string {
    const charLimit = maxLength * 6; // Approximate chars per token
    
    if (content.length <= charLimit) {
      return content;
    }

    const truncated = content.slice(0, charLimit);
    const lastPeriod = truncated.lastIndexOf('.');
    // Prefer sentence boundaries if we can keep most of the content
    if (lastPeriod > charLimit * 0.7) {
      return truncated.slice(0, lastPeriod + 1);
    }

    // Fall back to word boundaries
    const lastSpace = truncated.lastIndexOf(' ');
    return truncated.slice(0, lastSpace) + '...';
  }

  /**
   * Executes a search query using the MCP client
   * Includes error handling and type validation of the response
   */
  public async search(query: string, numResults: number = 10): Promise<SearchResponse> {
    try {
      const client = await this.getClient();
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new MCPTimeoutError('Search timeout', query)), 30000));
      const searchPromise = client.callTool({
        name: 'search',
        arguments: { query, numResults },
      });
      const response = await Promise.race([searchPromise, timeoutPromise]);
      
      if (typeof response === 'object' && response !== null && 'results' in response) {
        return response as unknown as SearchResponse;
      }
      throw new SearchError('Response missing results array', query);
    } catch (error) {
      // Handle client connection errors
      if (error instanceof Error && error.message.includes('connection')) {
        throw new MCPConnectionError(
          'Failed to connect to search service',
          query,
          error
        );
      }
      if (error instanceof SearchError || 
          error instanceof MCPTimeoutError || 
          error instanceof MCPConnectionError) {
        throw error;
      }
      throw new SearchError(
        error instanceof Error ? error.message : 'Unknown search error',
        query
      );
    }
  }

  /**
   * Detects and extracts search commands from user input
   * Supports explicit @web commands and URL detection
   */
  public detectSearchCommand(input: string): string | null {
    const webCommandMatch = input.match(/@web\s+(.+)$/);
    if (webCommandMatch) {
      return webCommandMatch[1] ?? null;
    }

    const urlMatch = input.match(/https?:\/\/[^\s<>{}|\^~[\]`"]+[a-zA-Z0-9/]/);
    if (urlMatch) {
      return urlMatch[0];
    }

    return null;
  }

  /**
   * Formats search results into a readable string format
   * Includes metadata and truncated content for each result
   */
  private formatSearchResults(results: SearchResult[], query: string): string {
    const header = `Search Results for: "${query}"\n\n`;

    const formattedResults = results
      .map((result, index) => {
        const truncatedContent = this.truncateContent(result.content);
        return [
          `[Result ${index + 1}]`,
          `Source: ${result.url}`,
          `Title: ${result.title}`,
          `Summary: ${truncatedContent}`,
          ''
        ].join('\n');
      })
      .join('\n');

    if (results.length === 0) {
      return header + 'No relevant results found.';
    }

    return [
      header,
      formattedResults,
      `End of search results. Found ${results.length} relevant sources.\n`
    ].join('\n');
  }

  /**
   * Enhances the original query with web search results
   * Manages the complete search workflow including:
   * - Search command detection
   * - Status broadcasting
   * - Error handling
   * - Result formatting
   * - Instructions for using the search results
   */
  public async enrichPromptWithWebResults(session: SessionType, query: string): Promise<string> {
    const searchQuery = this.detectSearchCommand(query);
    if (!searchQuery) {
      return query;
    }

    try {
      this.broadcastStatus('searching', searchQuery);
      const searchResults = await this.search(searchQuery);
      this.broadcastStatus('complete', searchQuery);

      const formattedResults = this.formatSearchResults(searchResults.results, searchQuery);

      return `I found some relevant information from web searches that might help answer your query. Here are the search results:

${formattedResults}

Based on the above search results, please address the following query:
${query}

Important instructions:
1. Use the search results to inform your response
2. Cite specific sources when drawing from the search results
3. If the search results aren't relevant, rely on your general knowledge
4. If you need more specific information, let me know and we can perform another search`;

    } catch (error) {
      const errorMessage = error instanceof SearchError 
        ? error.message 
        : 'Unknown error during web search';
      
      this.broadcastStatus('error', searchQuery, errorMessage);
      console.error('Error performing web search:', error);
      
      return query; // Fall back to original query if search fails
    }
  }
}