import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import { DiagnosticUpdateCallback, ResourceHandler, SubscriptionContext, SubscriptionHandler, UnsubscriptionHandler } from "../types/index.js";
import { LSPClient } from "../lspClient.js";
import { createFileUri, checkLspClientInitialized } from "../tools/index.js";
import { debug, logError } from "../logging/index.js";

// Helper function to parse a URI path
export const parseUriPath = (uri: URL): string => {
  // Ensure we handle paths correctly - URL parsing can remove the leading slash
  let decodedPath = decodeURIComponent(uri.pathname);
  // Normalize path to ensure it starts with a slash
  return path.posix.normalize(decodedPath.startsWith('/') ? decodedPath : '/' + decodedPath);
};

// Helper function to parse location parameters
export const parseLocationParams = (uri: URL): { filePath: string, line: number, character: number, languageId: string } => {
  // Get the file path
  const filePath = parseUriPath(uri);

  // Get the query parameters
  const lineParam = uri.searchParams.get('line');
  const columnParam = uri.searchParams.get('column');
  const languageId = uri.searchParams.get('language_id');

  if (!languageId) {
    throw new Error("language_id parameter is required");
  }

  if (!filePath || !lineParam || !columnParam) {
    throw new Error("Required parameters: file_path, line, column");
  }

  // Parse line and column as numbers
  const line = parseInt(lineParam, 10);
  const character = parseInt(columnParam, 10);

  if (isNaN(line) || isNaN(character)) {
    throw new Error("Line and column must be valid numbers");
  }

  return { filePath, line, character, languageId };
};

// Get resource handlers
export const getResourceHandlers = (lspClient: LSPClient | null): Record<string, ResourceHandler> => {
  return {
    // Handler for lsp-diagnostics://
    'lsp-diagnostics://': async (uri: string) => {
      checkLspClientInitialized(lspClient);

      try {
        // Parse the URI to handle query parameters correctly
        const diagnosticsUri = new URL(uri);
        
        // Get the file path from the pathname
        let filePath = parseUriPath(diagnosticsUri);
        
        // Remove query parameters from the file path if needed
        const questionMarkIndex = filePath.indexOf('?');
        if (questionMarkIndex !== -1) {
          filePath = filePath.substring(0, questionMarkIndex);
        }

        let diagnosticsContent: string;

        if (filePath && filePath !== '/') {
          // For a specific file
          debug(`Getting diagnostics for file: ${filePath}`);
          const fileUri = createFileUri(filePath);

          // Verify the file is open
          if (!lspClient!.isDocumentOpen(fileUri)) {
            throw new Error(`File ${filePath} is not open. Please open the file with open_document before requesting diagnostics.`);
          }

          const diagnostics = lspClient!.getDiagnostics(fileUri);
          diagnosticsContent = JSON.stringify({ [fileUri]: diagnostics }, null, 2);
        } else {
          // For all files
          debug("Getting diagnostics for all files");
          const allDiagnostics = lspClient!.getAllDiagnostics();

          // Convert Map to object for JSON serialization
          const diagnosticsObject: Record<string, any[]> = {};
          allDiagnostics.forEach((value: any[], key: string) => {
            // Only include diagnostics for open files
            if (lspClient!.isDocumentOpen(key)) {
              diagnosticsObject[key] = value;
            }
          });

          diagnosticsContent = JSON.stringify(diagnosticsObject, null, 2);
        }

        return {
          contents: [{ type: "text", text: diagnosticsContent, uri }],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError(`Error parsing diagnostics URI or getting diagnostics: ${errorMessage}`);
        throw new Error(`Error processing diagnostics request: ${errorMessage}`);
      }
    },

    // Handler for lsp-hover://
    'lsp-hover://': async (uri: string) => {
      checkLspClientInitialized(lspClient);

      try {
        // Extract parameters from URI
        // Format: lsp-hover://{file_path}?line={line}&character={character}&language_id={language_id}
        const hoverUri = new URL(uri);
        const { filePath, line, character, languageId } = parseLocationParams(hoverUri);

        debug(`Getting hover info for ${filePath} at line ${line}, character ${character}`);

        // Read the file content
        const fileContent = await fs.readFile(filePath, 'utf-8');

        // Create a file URI
        const fileUri = createFileUri(filePath);

        // Open the document in the LSP server (won't reopen if already open)
        await lspClient!.openDocument(fileUri, fileContent, languageId);

        // Get information at the location (LSP is 0-based)
        const hoverText = await lspClient!.getInfoOnLocation(fileUri, {
          line: line - 1,
          character: character - 1
        });

        debug(`Got hover information: ${hoverText.slice(0, 100)}${hoverText.length > 100 ? '...' : ''}`);

        return {
          contents: [{ type: "text", text: hoverText, uri }],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError(`Error parsing hover URI or getting hover information: ${errorMessage}`);
        throw new Error(`Error processing hover request: ${errorMessage}`);
      }
    },

    // Handler for lsp-completions://
    'lsp-completions://': async (uri: string) => {
      checkLspClientInitialized(lspClient);

      try {
        // Extract parameters from URI
        // Format: lsp-completions://{file_path}?line={line}&character={character}&language_id={language_id}
        const completionsUri = new URL(uri);
        const { filePath, line, character, languageId } = parseLocationParams(completionsUri);

        debug(`Getting completions for ${filePath} at line ${line}, character ${character}`);

        // Read the file content
        const fileContent = await fs.readFile(filePath, 'utf-8');

        // Create a file URI
        const fileUri = createFileUri(filePath);

        // Open the document in the LSP server (won't reopen if already open)
        await lspClient!.openDocument(fileUri, fileContent, languageId);

        // Get completions at the location (LSP is 0-based)
        const completions = await lspClient!.getCompletion(fileUri, {
          line: line - 1,
          character: character - 1
        });

        debug(`Got ${completions.length} completions`);

        return {
          contents: [{ type: "text", text: JSON.stringify(completions, null, 2), uri }],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logError(`Error parsing completions URI or getting completions: ${errorMessage}`);
        throw new Error(`Error processing completions request: ${errorMessage}`);
      }
    }
  };
};

// Get subscription handlers
export const getSubscriptionHandlers = (lspClient: LSPClient | null, server: any): Record<string, SubscriptionHandler> => {
  return {
    // Handler for lsp-diagnostics://
    'lsp-diagnostics://': async (uri: string) => {
      checkLspClientInitialized(lspClient);

      // Extract the file path parameter from the URI
      const filePath = uri.slice(18);

      if (filePath) {
        // Subscribe to a specific file
        const fileUri = createFileUri(filePath);

        // Verify the file is open
        if (!lspClient!.isDocumentOpen(fileUri)) {
          throw new Error(`File ${filePath} is not open. Please open the file with open_document before subscribing to diagnostics.`);
        }

        debug(`Subscribing to diagnostics for file: ${filePath}`);

        // Set up the subscription callback
        const callback: DiagnosticUpdateCallback = (diagUri: string, diagnostics: any[]) => {
          if (diagUri === fileUri) {
            // Send resource update to clients
            server.notification({
              method: "notifications/resources/update",
              params: {
                uri,
                content: [{ type: "text", text: JSON.stringify({ [diagUri]: diagnostics }, null, 2) }]
              }
            });
          }
        };

        // Store the callback in the subscription context for later use with unsubscribe
        const subscriptionContext: SubscriptionContext = { callback };

        // Subscribe to diagnostics
        lspClient!.subscribeToDiagnostics(callback);

        return {
          ok: true,
          context: subscriptionContext
        };
      } else {
        // Subscribe to all files
        debug("Subscribing to diagnostics for all files");

        // Set up the subscription callback for all files
        const callback: DiagnosticUpdateCallback = (diagUri: string, diagnostics: any[]) => {
          // Only send updates for open files
          if (lspClient!.isDocumentOpen(diagUri)) {
            // Get all open documents' diagnostics
            const allDiagnostics = lspClient!.getAllDiagnostics();

            // Convert Map to object for JSON serialization
            const diagnosticsObject: Record<string, any[]> = {};
            allDiagnostics.forEach((diagValue: any[], diagKey: string) => {
              // Only include diagnostics for open files
              if (lspClient!.isDocumentOpen(diagKey)) {
                diagnosticsObject[diagKey] = diagValue;
              }
            });

            // Send resource update to clients
            server.notification({
              method: "notifications/resources/update",
              params: {
                uri,
                content: [{ type: "text", text: JSON.stringify(diagnosticsObject, null, 2) }]
              }
            });
          }
        };

        // Store the callback in the subscription context for later use with unsubscribe
        const subscriptionContext: SubscriptionContext = { callback };

        // Subscribe to diagnostics
        lspClient!.subscribeToDiagnostics(callback);

        return {
          ok: true,
          context: subscriptionContext
        };
      }
    }
  };
};

// Get unsubscription handlers
export const getUnsubscriptionHandlers = (lspClient: LSPClient | null): Record<string, UnsubscriptionHandler> => {
  return {
    // Handler for lsp-diagnostics://
    'lsp-diagnostics://': async (uri: string, context: any) => {
      checkLspClientInitialized(lspClient);

      if (context && (context as SubscriptionContext).callback) {
        // Unsubscribe the callback
        lspClient!.unsubscribeFromDiagnostics((context as SubscriptionContext).callback);
        debug(`Unsubscribed from diagnostics for URI: ${uri}`);

        return { ok: true };
      }

      throw new Error(`Invalid subscription context for URI: ${uri}`);
    }
  };
};

// Get resource definitions for the server
export const getResourceTemplates = () => {
  return [
    {
      name: "lsp-diagnostics",
      scheme: "lsp-diagnostics",
      pattern: "lsp-diagnostics://{file_path}",
      description: "Get diagnostic messages (errors, warnings) for a specific file or all files. Use this resource to identify problems in code files such as syntax errors, type mismatches, or other issues detected by the language server. When used without a file_path, returns diagnostics for all open files. Supports live updates through subscriptions.",
      subscribe: true,
    },
    {
      name: "lsp-hover",
      scheme: "lsp-hover",
      pattern: "lsp-hover://{file_path}?line={line}&column={column}&language_id={language_id}",
      description: "Get hover information for a specific location in a file. Use this resource to retrieve type information, documentation, and other contextual details about symbols in your code. Particularly useful for understanding variable types, function signatures, and module documentation at a specific cursor position.",
      subscribe: false,
    },
    {
      name: "lsp-completions",
      scheme: "lsp-completions",
      pattern: "lsp-completions://{file_path}?line={line}&column={column}&language_id={language_id}",
      description: "Get completion suggestions for a specific location in a file. Use this resource to obtain code completion options based on the current context, including variable names, function calls, object properties, and more. Helpful for code assistance and auto-completion features at a specific cursor position.",
      subscribe: false,
    }
  ];
};

// Generate resources list from open documents
export const generateResourcesList = (lspClient: LSPClient | null) => {
  const resources: Array<{
    uri: string;
    name: string;
    description: string;
    subscribe: boolean;
    template?: boolean;
  }> = [];

  // Check if LSP client is initialized
  if (!lspClient) {
    return resources; // Return empty list if LSP is not initialized
  }

  // Add the "all diagnostics" resource
  resources.push({
    uri: "lsp-diagnostics://",
    name: "All diagnostics",
    description: "Diagnostics for all open files",
    subscribe: true,
  });

  // For each open document, add resources
  lspClient.getOpenDocuments().forEach((uri: string) => {
    if (uri.startsWith('file://')) {
      const filePath = fileURLToPath(uri);
      const fileName = path.basename(filePath);

      // Add diagnostics resource
      resources.push({
        uri: `lsp-diagnostics://${filePath}`,
        name: `Diagnostics for ${fileName}`,
        description: `LSP diagnostics for ${filePath}`,
        subscribe: true,
      });

      // Add hover resource template
      // We don't add specific hover resources since they require line/column coordinates
      // which are not known until the client requests them
      resources.push({
        uri: `lsp-hover://${filePath}?line={line}&column={column}&language_id={language_id}`,
        name: `Hover for ${fileName}`,
        description: `LSP hover information template for ${fileName}`,
        subscribe: false,
        template: true,
      });

      // Add completions resource template
      resources.push({
        uri: `lsp-completions://${filePath}?line={line}&column={column}&language_id={language_id}`,
        name: `Completions for ${fileName}`,
        description: `LSP code completion suggestions template for ${fileName}`,
        subscribe: false,
        template: true,
      });
    }
  });

  return resources;
};