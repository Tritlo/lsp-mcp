import * as fs from "fs/promises";
import * as path from "path";
import { pathToFileURL } from "url";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  GetInfoOnLocationArgsSchema,
  GetCompletionsArgsSchema,
  GetCodeActionsArgsSchema,
  OpenDocumentArgsSchema,
  CloseDocumentArgsSchema,
  GetDiagnosticsArgsSchema,
  SetLogLevelArgsSchema,
  RestartLSPServerArgsSchema,
  StartLSPArgsSchema,
  ToolInput,
  ToolHandler
} from "../types/index.js";
import { LSPClient } from "../lspClient.js";
import { debug, info, logError, notice, warning, setLogLevel } from "../logging/index.js";
import { activateExtension, deactivateExtension, listActiveExtensions } from "../extensions/index.js";

// Create a file URI from a file path
export const createFileUri = (filePath: string): string => {
  return pathToFileURL(path.resolve(filePath)).href;
};

// Check if LSP client is initialized
export const checkLspClientInitialized = (lspClient: LSPClient | null): void => {
  if (!lspClient) {
    throw new Error("LSP server not started. Call start_lsp first with a root directory.");
  }
};

// Define handlers for each tool
export const getToolHandlers = (lspClient: LSPClient | null, lspServerPath: string, lspServerArgs: string[], setLspClient: (client: LSPClient) => void, rootDir: string, setRootDir: (dir: string) => void, server?: any) => {
  return {
    "get_info_on_location": {
      schema: GetInfoOnLocationArgsSchema,
      handler: async (args: any) => {
        debug(`Getting info on location in file: ${args.file_path} (${args.line}:${args.column})`);

        checkLspClientInitialized(lspClient);

        // Read the file content
        const fileContent = await fs.readFile(args.file_path, 'utf-8');

        // Create a file URI
        const fileUri = createFileUri(args.file_path);

        // Open the document in the LSP server (won't reopen if already open)
        await lspClient!.openDocument(fileUri, fileContent, args.language_id);

        // Get information at the location
        const text = await lspClient!.getInfoOnLocation(fileUri, {
          line: args.line - 1, // LSP is 0-based
          character: args.column - 1
        });

        debug(`Returned info on location: ${text.slice(0, 100)}${text.length > 100 ? '...' : ''}`);

        return {
          content: [{ type: "text", text }],
        };
      }
    },

    "get_completions": {
      schema: GetCompletionsArgsSchema,
      handler: async (args: any) => {
        debug(`Getting completions in file: ${args.file_path} (${args.line}:${args.column})`);

        checkLspClientInitialized(lspClient);

        // Read the file content
        const fileContent = await fs.readFile(args.file_path, 'utf-8');

        // Create a file URI
        const fileUri = createFileUri(args.file_path);

        // Open the document in the LSP server (won't reopen if already open)
        await lspClient!.openDocument(fileUri, fileContent, args.language_id);

        // Get completions at the location
        const completions = await lspClient!.getCompletion(fileUri, {
          line: args.line - 1, // LSP is 0-based
          character: args.column - 1
        });

        debug(`Returned ${completions.length} completions`);

        return {
          content: [{ type: "text", text: JSON.stringify(completions, null, 2) }],
        };
      }
    },

    "get_code_actions": {
      schema: GetCodeActionsArgsSchema,
      handler: async (args: any) => {
        debug(`Getting code actions in file: ${args.file_path} (${args.start_line}:${args.start_column} to ${args.end_line}:${args.end_column})`);

        checkLspClientInitialized(lspClient);

        // Read the file content
        const fileContent = await fs.readFile(args.file_path, 'utf-8');

        // Create a file URI
        const fileUri = createFileUri(args.file_path);

        // Open the document in the LSP server (won't reopen if already open)
        await lspClient!.openDocument(fileUri, fileContent, args.language_id);

        // Get code actions for the range
        const codeActions = await lspClient!.getCodeActions(fileUri, {
          start: {
            line: args.start_line - 1, // LSP is 0-based
            character: args.start_column - 1
          },
          end: {
            line: args.end_line - 1,
            character: args.end_column - 1
          }
        });

        debug(`Returned ${codeActions.length} code actions`);

        return {
          content: [{ type: "text", text: JSON.stringify(codeActions, null, 2) }],
        };
      }
    },

    "restart_lsp_server": {
      schema: RestartLSPServerArgsSchema,
      handler: async (args: any) => {
        checkLspClientInitialized(lspClient);

        // Get the root directory from args or use the stored one
        const restartRootDir = args.root_dir || rootDir;

        info(`Restarting LSP server${args.root_dir ? ` with root directory: ${args.root_dir}` : ''}...`);

        try {
          // If root_dir is provided, update the stored rootDir
          if (args.root_dir) {
            setRootDir(args.root_dir);
          }

          // Restart with the root directory
          await lspClient!.restart(restartRootDir);

          return {
            content: [{
              type: "text",
              text: args.root_dir
                ? `LSP server successfully restarted and initialized with root directory: ${args.root_dir}`
                : "LSP server successfully restarted"
            }],
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logError(`Error restarting LSP server: ${errorMessage}`);
          throw new Error(`Failed to restart LSP server: ${errorMessage}`);
        }
      }
    },

    "start_lsp": {
      schema: StartLSPArgsSchema,
      handler: async (args: any) => {
        const startRootDir = args.root_dir || rootDir;
        info(`Starting LSP server with root directory: ${startRootDir}`);

        try {
          setRootDir(startRootDir);

          // Create LSP client if it doesn't exist
          if (!lspClient) {
            const newClient = new LSPClient(lspServerPath, lspServerArgs);
            setLspClient(newClient);
          }

          // Initialize with the specified root directory
          await lspClient!.initialize(startRootDir);

          return {
            content: [{ type: "text", text: `LSP server successfully started with root directory: ${rootDir}` }],
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logError(`Error starting LSP server: ${errorMessage}`);
          throw new Error(`Failed to start LSP server: ${errorMessage}`);
        }
      }
    },

    "open_document": {
      schema: OpenDocumentArgsSchema,
      handler: async (args: any) => {
        debug(`Opening document: ${args.file_path}`);

        checkLspClientInitialized(lspClient);

        try {
          // Read the file content
          const fileContent = await fs.readFile(args.file_path, 'utf-8');

          // Create a file URI
          const fileUri = createFileUri(args.file_path);

          // Open the document in the LSP server
          await lspClient!.openDocument(fileUri, fileContent, args.language_id);

          return {
            content: [{ type: "text", text: `File successfully opened: ${args.file_path}` }],
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logError(`Error opening document: ${errorMessage}`);
          throw new Error(`Failed to open document: ${errorMessage}`);
        }
      }
    },

    "close_document": {
      schema: CloseDocumentArgsSchema,
      handler: async (args: any) => {
        debug(`Closing document: ${args.file_path}`);

        checkLspClientInitialized(lspClient);

        try {
          // Create a file URI
          const fileUri = createFileUri(args.file_path);

          // Use the closeDocument method
          await lspClient!.closeDocument(fileUri);

          return {
            content: [{ type: "text", text: `File successfully closed: ${args.file_path}` }],
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logError(`Error closing document: ${errorMessage}`);
          throw new Error(`Failed to close document: ${errorMessage}`);
        }
      }
    },

    "get_diagnostics": {
      schema: GetDiagnosticsArgsSchema,
      handler: async (args: any) => {
        checkLspClientInitialized(lspClient);

        try {
          // Get diagnostics for a specific file or all files
          if (args.file_path) {
            // For a specific file
            debug(`Getting diagnostics for file: ${args.file_path}`);
            const fileUri = createFileUri(args.file_path);

            // Verify the file is open
            if (!lspClient!.isDocumentOpen(fileUri)) {
              throw new Error(`File ${args.file_path} is not open. Please open the file with open_document before requesting diagnostics.`);
            }

            const diagnostics = lspClient!.getDiagnostics(fileUri);

            return {
              content: [{
                type: "text",
                text: JSON.stringify({ [fileUri]: diagnostics }, null, 2)
              }],
            };
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

            return {
              content: [{
                type: "text",
                text: JSON.stringify(diagnosticsObject, null, 2)
              }],
            };
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logError(`Error getting diagnostics: ${errorMessage}`);
          throw new Error(`Failed to get diagnostics: ${errorMessage}`);
        }
      }
    },

    "set_log_level": {
      schema: SetLogLevelArgsSchema,
      handler: async (args: any) => {
        // Set the log level
        const { level } = args;
        setLogLevel(level);

        return {
          content: [{ type: "text", text: `Log level set to: ${level}` }],
        };
      }
    },
  };
};

// Get tool definitions for the server
export const getToolDefinitions = () => {
  return [
    {
      name: "get_info_on_location",
      description: "Get information on a specific location in a file via LSP hover. Use this tool to retrieve detailed type information, documentation, and other contextual details about symbols in your code. Particularly useful for understanding variable types, function signatures, and module documentation at a specific location in the code. Use this whenever you need to get a better idea on what a particular function is doing in that context. Requires the file to be opened first.",
      inputSchema: zodToJsonSchema(GetInfoOnLocationArgsSchema) as ToolInput,
    },
    {
      name: "get_completions",
      description: "Get completion suggestions at a specific location in a file. Use this tool to retrieve code completion options based on the current context, including variable names, function calls, object properties, and more. Helpful for code assistance and auto-completion at a particular location. Use this when determining which functions you have available in a given package, for example when changing libraries. Requires the file to be opened first.",
      inputSchema: zodToJsonSchema(GetCompletionsArgsSchema) as ToolInput,
    },
    {
      name: "get_code_actions",
      description: "Get code actions for a specific range in a file. Use this tool to obtain available refactorings, quick fixes, and other code modifications that can be applied to a selected code range. Examples include adding imports, fixing errors, or implementing interfaces. Requires the file to be opened first.",
      inputSchema: zodToJsonSchema(GetCodeActionsArgsSchema) as ToolInput,
    },
    {
      name: "restart_lsp_server",
      description: "Restart the LSP server process. Use this tool to reset the LSP server if it becomes unresponsive, has stale data, or when you need to apply configuration changes. Can optionally reinitialize with a new root directory. Useful for troubleshooting language server issues or when switching projects.",
      inputSchema: zodToJsonSchema(RestartLSPServerArgsSchema) as ToolInput,
    },
    {
      name: "start_lsp",
      description: "Start the LSP server with a specified root directory. IMPORTANT: This tool must be called before using any other LSP functionality. The root directory should point to the project's base folder, which typically contains configuration files like tsconfig.json, package.json, or other language-specific project files. All file paths in other tool calls will be resolved relative to this root.",
      inputSchema: zodToJsonSchema(StartLSPArgsSchema) as ToolInput,
    },
    {
      name: "open_document",
      description: "Open a file in the LSP server for analysis. Use this tool before performing operations like getting diagnostics, hover information, or completions for a file. The file remains open for continued analysis until explicitly closed. The language_id parameter tells the server which language service to use (e.g., 'typescript', 'javascript', 'haskell').",
      inputSchema: zodToJsonSchema(OpenDocumentArgsSchema) as ToolInput,
    },
    {
      name: "close_document",
      description: "Close a file in the LSP server. Use this tool when you're done with a file to free up resources and reduce memory usage. It's good practice to close files that are no longer being actively analyzed, especially in long-running sessions or when working with large codebases.",
      inputSchema: zodToJsonSchema(CloseDocumentArgsSchema) as ToolInput,
    },
    {
      name: "get_diagnostics",
      description: "Get diagnostic messages (errors, warnings) for files. Use this tool to identify problems in code files such as syntax errors, type mismatches, or other issues detected by the language server. When used without a file_path, returns diagnostics for all open files. Requires files to be opened first.",
      inputSchema: zodToJsonSchema(GetDiagnosticsArgsSchema) as ToolInput,
    },
    {
      name: "set_log_level",
      description: "Set the server logging level. Use this tool to control the verbosity of logs generated by the LSP MCP server. Available levels from least to most verbose: emergency, alert, critical, error, warning, notice, info, debug. Increasing verbosity can help troubleshoot issues but may generate large amounts of output.",
      inputSchema: zodToJsonSchema(SetLogLevelArgsSchema) as ToolInput,
    },
  ];
};
