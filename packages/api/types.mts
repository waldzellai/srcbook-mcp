// packages/api/types.mts

import type { CellType, CodeLanguageType } from '@srcbook/shared';

export type SessionType = {
  id: string;
  /**
   * Path to the directory containing the srcbook files.
   */
  dir: string;
  cells: CellType[];

  /**
   * The language of the srcbook, i.e.: 'typescript' or 'javascript'
   */
  language: CodeLanguageType;

  /**
   * The tsconfig.json file contents.
   */
  'tsconfig.json'?: string;

  /**
   * Replace this with updatedAt once we store srcbooks in sqlite
   */
  openedAt: number;
};

// MCP specific types
export type SearchStatus = 'searching' | 'complete' | 'error';

export interface SearchStatusPayload {
  query: string;
  status: SearchStatus;
  error?: string;
}

export interface SearchResult {
  url: string;
  title: string;
  content: string;
}

export interface SearchResponse {
  results: SearchResult[];
}

// Add to your existing ServerToClientEvents interface or create if not exists
export interface ServerToClientEvents {
  'search:status': (payload: SearchStatusPayload) => void;
  // ... other existing events
}
