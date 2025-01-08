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

export class McpService {
  private client: Client | null = null;
  private wss: WebSocketServer;
  private sessionId: string;
  private readonly maxTokensPerResult = 300;

  constructor(wss: WebSocketServer, sessionId: string) {
    this.wss = wss;
    this.sessionId = sessionId;
  }

  private async getClient() {
    if (this.client) {
      return this.client;
    }

    // Set up stdio transport for MCP server communication
    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-exa'],
    });

    // Initialize client
    const client = new Client({
      name: "srcbook-client",
      version: "1.0.0",
    }, {
      capabilities: {}  // Exa server handles capabilities negotiation
    });

    await client.connect(transport);
    this.client = client;
    return client;
  }

  public async search(query: string, numResults: number = 10): Promise<SearchResponse> {
    try {
      const client = await this.getClient();
      
      // Call the search tool using the proper MCP format
      const response = await client.request({
        method: "tools/call",
        params: {
          name: "search",
          arguments: { 
            query,
            numResults 
          }
        }
      });

      if (!response || !Array.isArray((response as any).content)) {
        throw new Error('Invalid search response format');
      }

      // Transform the response into our expected format
      return {
        results: response.content.map(item => ({
          title: item.title || '',
          url: item.url || '',
          content: item.text || ''
        }))
      };

    } catch (error) {
      console.error('Search error:', error);
      throw error;
    }
  }

  private broadcastStatus(status: SearchStatus, query: string, error?: string) {
    const payload: SearchStatusPayload = { status, query, error };
    this.wss.broadcast(`session:${this.sessionId}`, 'search:status', payload);
  }

  /**
   * Detects and extracts search commands from user input
   * Supports explicit @web commands and URL detection
   */
  public detectSearchCommand(input: string): string | null {
    const webCommandMatch = input.match(/@web\\s+(.+)$/);
    if (webCommandMatch) {
      return webCommandMatch[1] ?? null;
    }

    const urlMatch = input.match(/https?:\\/\\/[^\\s<>{}|\\^~[\\]`"]+[a-zA-Z0-9/]/);
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
      const errorMessage = error instanceof Error ? error.message : 'Unknown error during web search';
      
      this.broadcastStatus('error', searchQuery, errorMessage);
      console.error('Error performing web search:', error);
      
      return query; // Fall back to original query if search fails
    }
  }
}