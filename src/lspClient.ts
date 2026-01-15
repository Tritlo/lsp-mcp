import { spawn } from "child_process";
import path from "path";
import { LSPMessage, DiagnosticUpdateCallback, LoggingLevel } from "./types/index.js";
import { debug, info, notice, warning, log, logError } from "./logging/index.js";

export class LSPClient {
  private process: any;
  private buffer: string = "";
  private messageQueue: LSPMessage[] = [];
  private nextId: number = 1;
  private responsePromises: Map<string | number, { resolve: Function; reject: Function }> = new Map();
  private initialized: boolean = false;
  private serverCapabilities: any = null;
  private lspServerPath: string;
  private lspServerArgs: string[];
  private openedDocuments: Set<string> = new Set();
  private documentVersions: Map<string, number> = new Map();
  private processingQueue: boolean = false;
  private documentDiagnostics: Map<string, any[]> = new Map();
  private diagnosticSubscribers: Set<DiagnosticUpdateCallback> = new Set();

  constructor(lspServerPath: string, lspServerArgs: string[] = []) {
    this.lspServerPath = lspServerPath;
    this.lspServerArgs = lspServerArgs;
    // Don't start the process automatically - it will be started when needed
  }

  private startProcess(): void {
    info(`Starting LSP client with binary: ${this.lspServerPath}`);
    info(`Using LSP server arguments: ${this.lspServerArgs.join(' ')}`);
    this.process = spawn(this.lspServerPath, this.lspServerArgs, {
      stdio: ["pipe", "pipe", "pipe"]
    });

    // Set up event listeners
    this.process.stdout.on("data", (data: Buffer) => this.handleData(data));
    this.process.stderr.on("data", (data: Buffer) => {
      debug(`LSP Server Message: ${data.toString()}`);
    });

    this.process.on("close", (code: number) => {
      notice(`LSP server process exited with code ${code}`);
    });
  }

  private handleData(data: Buffer): void {
    // Append new data to buffer
    this.buffer += data.toString();

    // Implement a safety limit to prevent excessive buffer growth
    const MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB limit
    if (this.buffer.length > MAX_BUFFER_SIZE) {
      logError(`Buffer size exceeded ${MAX_BUFFER_SIZE} bytes, clearing buffer to prevent memory issues`);
      this.buffer = this.buffer.substring(this.buffer.length - MAX_BUFFER_SIZE);
    }

    // Process complete messages
    while (true) {
      // Look for Content-Length header and capture all headers before the empty line
      // This handles cases where there are other headers like Content-Type before Content-Length
      const headerMatch = this.buffer.match(/((?:.*\r?\n)*Content-Length: (\d+)\r?\n\r?\n)/);
      if (!headerMatch) break;

      const fullHeader = headerMatch[1];
      const contentLength = parseInt(headerMatch[2], 10);
      const headerEnd = fullHeader.length;

      // Prevent processing unreasonably large messages
      if (contentLength > MAX_BUFFER_SIZE) {
        logError(`Received message with content length ${contentLength} exceeds maximum size, skipping`);
        this.buffer = this.buffer.substring(headerEnd + contentLength);
        continue;
      }

      // Check if we have the complete message (excluding the header)
      if (this.buffer.length < headerEnd + contentLength) break; // Message not complete yet

      // Extract the message content - starting after the complete header block
      let content = this.buffer.substring(headerEnd, headerEnd + contentLength);
      // Make the parsing more robust by ensuring content ends with a closing brace
      if (content.length === 0 || content[content.length - 1] !== '}') {
        debug("Content doesn't end with '}', adjusting...");
        const lastBraceIndex = content.lastIndexOf('}');
        if (lastBraceIndex !== -1) {
          const actualContentLength = lastBraceIndex + 1;
          debug(`Adjusted content length from ${contentLength} to ${actualContentLength}`);
          content = content.substring(0, actualContentLength);
          // Update buffer position based on actual content length
          this.buffer = this.buffer.substring(headerEnd + actualContentLength);
        } else {
          debug("No closing brace found, using original content length");
          // No closing brace found, use original approach
          this.buffer = this.buffer.substring(headerEnd + contentLength);
        }
      } else {
        debug("Content ends with '}', no adjustment needed");
        // Content looks good, remove precisely this processed message from buffer
        this.buffer = this.buffer.substring(headerEnd + contentLength);
      }


      // Parse the message and add to queue
      try {
        const message = JSON.parse(content) as LSPMessage;
        this.messageQueue.push(message);
        this.processMessageQueue();
      } catch (error) {
        logError("Failed to parse LSP message:", error);
      }
    }
  }

  private async processMessageQueue(): Promise<void> {
    // If already processing, return to avoid concurrent processing
    if (this.processingQueue) return;

    this.processingQueue = true;

    try {
      while (this.messageQueue.length > 0) {
        const message = this.messageQueue.shift()!;
        await this.handleMessage(message);
      }
    } finally {
      this.processingQueue = false;
    }
  }

  private async handleMessage(message: LSPMessage): Promise<void> {
    // Log the message with appropriate level
    try {
      const direction = 'RECEIVED';
      const messageStr = JSON.stringify(message, null, 2);
      // Use method to determine log level if available, otherwise use debug
      const method = message.method || '';
      const logLevel = this.getLSPMethodLogLevel(method);
      log(logLevel, `LSP ${direction} (${method}): ${messageStr}`);
    } catch (error) {
      warning("Error logging LSP message:", error);
    }

    // Handle response messages
    if ('id' in message && (message.result !== undefined || message.error !== undefined)) {
      const promise = this.responsePromises.get(message.id!);
      if (promise) {
        if (message.error) {
          promise.reject(message.error);
        } else {
          promise.resolve(message.result);
        }
        this.responsePromises.delete(message.id!);
      }
    }

    // Store server capabilities from initialize response
    if ('id' in message && message.result?.capabilities) {
      this.serverCapabilities = message.result.capabilities;
    }

    // Handle notification messages
    if ('method' in message && message.id === undefined) {
      // Handle diagnostic notifications
      if (message.method === 'textDocument/publishDiagnostics' && message.params) {
        const { uri, diagnostics } = message.params;

        if (uri && Array.isArray(diagnostics)) {
          const severity = diagnostics.length > 0 ?
            Math.min(...diagnostics.map(d => d.severity || 4)) : 4;

          // Map LSP severity to our log levels
          const severityToLevel: Record<number, string> = {
            1: 'error',      // Error
            2: 'warning',    // Warning
            3: 'info',       // Information
            4: 'debug'       // Hint
          };

          const level = severityToLevel[severity] || 'debug';

          log(level as any, `Received ${diagnostics.length} diagnostics for ${uri}`);

          // Store diagnostics, replacing any previous ones for this URI
          this.documentDiagnostics.set(uri, diagnostics);

          // Notify all subscribers about this update
          this.notifyDiagnosticUpdate(uri, diagnostics);
        }
      }
    }
  }

  private getLSPMethodLogLevel(method: string): LoggingLevel {
    // Define appropriate log levels for different LSP methods
    if (method.startsWith('textDocument/did')) {
      return 'debug'; // Document changes are usually debug level
    }

    if (method.includes('diagnostic') || method.includes('publishDiagnostics')) {
      return 'info'; // Diagnostics depend on their severity, but base level is info
    }

    if (method === 'initialize' || method === 'initialized' ||
        method === 'shutdown' || method === 'exit') {
      return 'notice'; // Important lifecycle events are notice level
    }

    // Default to debug level for most LSP operations
    return 'debug';
  }

  private sendRequest<T>(method: string, params?: any): Promise<T> {
    // Check if the process is started
    if (!this.process) {
      return Promise.reject(new Error("LSP process not started. Please call start_lsp first."));
    }

    const id = this.nextId++;
    const request: LSPMessage = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };

    // Log the request with appropriate level
    try {
      const direction = 'SENT';
      const requestStr = JSON.stringify(request, null, 2);
      const logLevel = this.getLSPMethodLogLevel(method);
      log(logLevel as any, `LSP ${direction} (${method}): ${requestStr}`);
    } catch (error) {
      warning("Error logging LSP request:", error);
    }

    const promise = new Promise<T>((resolve, reject) => {
      // Set timeout for request
      const timeoutId = setTimeout(() => {
        if (this.responsePromises.has(id)) {
          this.responsePromises.delete(id);
          reject(new Error(`Timeout waiting for response to ${method} request`));
        }
      }, 10000); // 10 second timeout

      // Store promise with cleanup for timeout
      this.responsePromises.set(id, {
        resolve: (result: T) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (error: any) => {
          clearTimeout(timeoutId);
          reject(error);
        }
      });
    });

    const content = JSON.stringify(request);
    // Content-Length header should only include the length of the JSON content
    const header = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n`;
    this.process.stdin.write(header + content);

    return promise;
  }

  private sendNotification(method: string, params?: any): void {
    // Check if the process is started
    if (!this.process) {
      logError("LSP process not started. Please call start_lsp first.");
      return;
    }

    const notification: LSPMessage = {
      jsonrpc: "2.0",
      method,
      params
    };

    // Log the notification with appropriate level
    try {
      const direction = 'SENT';
      const notificationStr = JSON.stringify(notification, null, 2);
      const logLevel = this.getLSPMethodLogLevel(method);
      log(logLevel as any, `LSP ${direction} (${method}): ${notificationStr}`);
    } catch (error) {
      warning("Error logging LSP notification:", error);
    }

    const content = JSON.stringify(notification);
    // Content-Length header should only include the length of the JSON content
    const header = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n`;
    this.process.stdin.write(header + content);
  }

  async initialize(rootDirectory: string = "."): Promise<void> {
    if (this.initialized) return;

    try {
      // Start the process if it hasn't been started yet
      if (!this.process) {
        this.startProcess();
      }

      info("Initializing LSP connection...");
      await this.sendRequest("initialize", {
        processId: process.pid,
        clientInfo: {
          name: "lsp-mcp-server"
        },
        rootUri: "file://" + path.resolve(rootDirectory),
        capabilities: {
          textDocument: {
            hover: {
              contentFormat: ["markdown", "plaintext"]
            },
            completion: {
              completionItem: {
                snippetSupport: false
              }
            },
            codeAction: {
              dynamicRegistration: true
            },
            diagnostic: {
              dynamicRegistration: false
            },
            publishDiagnostics: {
              relatedInformation: true,
              versionSupport: false,
              tagSupport: {},
              codeDescriptionSupport: true,
              dataSupport: true
            }
          }
        }
      });

      this.sendNotification("initialized", {});
      this.initialized = true;
      notice("LSP connection initialized successfully");
    } catch (error) {
      logError("Failed to initialize LSP connection:", error);
      throw error;
    }
  }

  async openDocument(uri: string, text: string, languageId: string): Promise<void> {
    // Check if initialized, but don't auto-initialize
    if (!this.initialized) {
      throw new Error("LSP client not initialized. Please call start_lsp first.");
    }

    // If document is already open, update it instead of reopening
    if (this.openedDocuments.has(uri)) {
      // Get current version and increment
      const currentVersion = this.documentVersions.get(uri) || 1;
      const newVersion = currentVersion + 1;

      debug(`Document already open, updating content: ${uri} (version ${newVersion})`);
      this.sendNotification("textDocument/didChange", {
        textDocument: {
          uri,
          version: newVersion
        },
        contentChanges: [
          {
            text // Full document update
          }
        ]
      });

      // Update version
      this.documentVersions.set(uri, newVersion);
      return;
    }

    debug(`Opening document: ${uri}`);
    this.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text
      }
    });

    // Mark document as open and initialize version
    this.openedDocuments.add(uri);
    this.documentVersions.set(uri, 1);
  }

  // Check if a document is open
  isDocumentOpen(uri: string): boolean {
    return this.openedDocuments.has(uri);
  }

  // Get a list of all open documents
  getOpenDocuments(): string[] {
    return Array.from(this.openedDocuments);
  }

  // Close a document
  async closeDocument(uri: string): Promise<void> {
    // Check if initialized
    if (!this.initialized) {
      throw new Error("LSP client not initialized. Please call start_lsp first.");
    }

    // Only close if document is open
    if (this.openedDocuments.has(uri)) {
      debug(`Closing document: ${uri}`);
      this.sendNotification("textDocument/didClose", {
        textDocument: { uri }
      });

      // Remove from tracking
      this.openedDocuments.delete(uri);
      this.documentVersions.delete(uri);
    } else {
      debug(`Document not open: ${uri}`);
    }
  }

  // Get diagnostics for a file
  getDiagnostics(uri: string): any[] {
    return this.documentDiagnostics.get(uri) || [];
  }

  // Get all diagnostics
  getAllDiagnostics(): Map<string, any[]> {
    return new Map(this.documentDiagnostics);
  }

  // Subscribe to diagnostic updates
  subscribeToDiagnostics(callback: DiagnosticUpdateCallback): void {
    this.diagnosticSubscribers.add(callback);

    // Send initial diagnostics for all open documents
    this.documentDiagnostics.forEach((diagnostics, uri) => {
      callback(uri, diagnostics);
    });
  }

  // Unsubscribe from diagnostic updates
  unsubscribeFromDiagnostics(callback: DiagnosticUpdateCallback): void {
    this.diagnosticSubscribers.delete(callback);
  }

  // Notify all subscribers about diagnostic updates
  private notifyDiagnosticUpdate(uri: string, diagnostics: any[]): void {
    this.diagnosticSubscribers.forEach(callback => {
      try {
        callback(uri, diagnostics);
      } catch (error) {
        warning("Error in diagnostic subscriber callback:", error);
      }
    });
  }

  // Clear all diagnostic subscribers
  clearDiagnosticSubscribers(): void {
    this.diagnosticSubscribers.clear();
  }

  async getInfoOnLocation(uri: string, position: { line: number, character: number }): Promise<string> {
    // Check if initialized, but don't auto-initialize
    if (!this.initialized) {
      throw new Error("LSP client not initialized. Please call start_lsp first.");
    }

    debug(`Getting info on location: ${uri} (${position.line}:${position.character})`);

    try {
      // Use hover request to get information at the position
      const response = await this.sendRequest<any>("textDocument/hover", {
        textDocument: { uri },
        position
      });

      if (response?.contents) {
        if (typeof response.contents === 'string') {
          return response.contents;
        } else if (response.contents.value) {
          return response.contents.value;
        } else if (Array.isArray(response.contents)) {
          return response.contents.map((item: any) =>
            typeof item === 'string' ? item : item.value || ''
          ).join('\n');
        }
      }
    } catch (error) {
      warning(`Error getting hover information: ${error instanceof Error ? error.message : String(error)}`);
    }

    return '';
  }

  async getCompletion(uri: string, position: { line: number, character: number }): Promise<any[]> {
    // Check if initialized, but don't auto-initialize
    if (!this.initialized) {
      throw new Error("LSP client not initialized. Please call start_lsp first.");
    }

    debug(`Getting completions at location: ${uri} (${position.line}:${position.character})`);

    try {
      const response = await this.sendRequest<any>("textDocument/completion", {
        textDocument: { uri },
        position
      });

      if (Array.isArray(response)) {
        return response;
      } else if (response?.items && Array.isArray(response.items)) {
        return response.items;
      }
    } catch (error) {
      warning(`Error getting completions: ${error instanceof Error ? error.message : String(error)}`);
    }

    return [];
  }

  async getCodeActions(uri: string, range: { start: { line: number, character: number }, end: { line: number, character: number } }): Promise<any[]> {
    // Check if initialized, but don't auto-initialize
    if (!this.initialized) {
      throw new Error("LSP client not initialized. Please call start_lsp first.");
    }

    debug(`Getting code actions for range: ${uri} (${range.start.line}:${range.start.character} to ${range.end.line}:${range.end.character})`);

    try {
      const response = await this.sendRequest<any>("textDocument/codeAction", {
        textDocument: { uri },
        range,
        context: {
          diagnostics: []
        }
      });

      if (Array.isArray(response)) {
        return response;
      }
    } catch (error) {
      warning(`Error getting code actions: ${error instanceof Error ? error.message : String(error)}`);
    }

    return [];
  }

  async shutdown(): Promise<void> {
    if (!this.initialized) return;

    try {
      info("Shutting down LSP connection...");

      // Clear all diagnostic subscribers
      this.clearDiagnosticSubscribers();

      // Close all open documents before shutting down
      for (const uri of this.openedDocuments) {
        try {
          this.sendNotification("textDocument/didClose", {
            textDocument: { uri }
          });
        } catch (error) {
          warning(`Error closing document ${uri}:`, error);
        }
      }

      await this.sendRequest("shutdown");
      this.sendNotification("exit");
      this.initialized = false;
      this.openedDocuments.clear();
      notice("LSP connection shut down successfully");
    } catch (error) {
      logError("Error shutting down LSP connection:", error);
    }
  }

  async restart(rootDirectory?: string): Promise<void> {
    info("Restarting LSP server...");

    // If initialized, try to shut down cleanly first
    if (this.initialized) {
      try {
        await this.shutdown();
      } catch (error) {
        warning("Error shutting down LSP server during restart:", error);
      }
    }

    // Kill the process if it's still running
    if (this.process && !this.process.killed) {
      try {
        this.process.kill();
        notice("Killed existing LSP process");
      } catch (error) {
        logError("Error killing LSP process:", error);
      }
    }

    // Reset state
    this.buffer = "";
    this.messageQueue = [];
    this.nextId = 1;
    this.responsePromises.clear();
    this.initialized = false;
    this.serverCapabilities = null;
    this.openedDocuments.clear();
    this.documentVersions.clear();
    this.processingQueue = false;
    this.documentDiagnostics.clear();
    this.clearDiagnosticSubscribers();

    // Start a new process
    this.startProcess();

    // Initialize with the provided root directory or use the stored one
    if (rootDirectory) {
      await this.initialize(rootDirectory);
      notice(`LSP server restarted and initialized with root directory: ${rootDirectory}`);
    } else {
      info("LSP server restarted but not initialized. Call start_lsp to initialize.");
    }
  }
}
