// tests/mcp-connection.test.ts — Test MCP stdio connection
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Test MCP server initialization and basic tool listing
describe("MCP Connection", () => {
  let serverProcess: ReturnType<typeof spawn> | null = null;
  
  // Give server time to initialize
  const INIT_TIMEOUT_MS = 2000;
  
  afterAll(() => {
    if (serverProcess) {
      serverProcess.kill();
    }
  });

  test("MCP server should initialize and respond to JSON-RPC messages", async () => {
    // Start the MCP server
    serverProcess = spawn(
      "/home/fychao/.bun/bin/bun",
      ["/home/fychao/plugin-symphony/opencode-symphony/dist/index.js"],
      {
        env: {
          ...process.env,
          LINEAR_API_KEY: "test_api_key",
        },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    let stdout = "";
    let stderr = "";

    serverProcess.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    serverProcess.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    // Wait for server to initialize
    await new Promise(resolve => setTimeout(resolve, INIT_TIMEOUT_MS));

    // Send initialize request
    const initializeRequest = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "test-client",
          version: "1.0.0"
        }
      }
    }) + "\n";

    serverProcess.stdin?.write(initializeRequest);

    // Wait for response
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Check if we got a valid response
    const lines = stdout.trim().split("\n");
    const responses = lines
      .filter(line => line.trim())
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    // Should have at least one response
    expect(responses.length).toBeGreaterThan(0);
    
    // First response should be the initialize result
    const initResponse = responses[0];
    expect(initResponse).toBeDefined();
    expect(initResponse.id).toBe(1);
    expect(initResponse.result).toBeDefined();
    expect(initResponse.result.serverInfo).toBeDefined();
    expect(initResponse.result.serverInfo.name).toBe("symphony");
    
    console.log("✅ MCP server initialized successfully");
    console.log("Server info:", initResponse.result.serverInfo);
  });

  test("MCP server should expose tools list after initialization", async () => {
    // Start a new server process for this test
    const testProcess = spawn(
      "/home/fychao/.bun/bin/bun",
      ["/home/fychao/plugin-symphony/opencode-symphony/dist/index.js"],
      {
        env: {
          ...process.env,
          LINEAR_API_KEY: "test_api_key",
        },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    let stdout = "";

    testProcess.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    // Wait for server to initialize
    await new Promise(resolve => setTimeout(resolve, INIT_TIMEOUT_MS));

    // Send initialized notification (required after initialize)
    const initializedNotification = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {}
    }) + "\n";

    testProcess.stdin?.write(initializedNotification);

    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 500));

    // Send tools/list request
    const toolsListRequest = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {}
    }) + "\n";

    testProcess.stdin?.write(toolsListRequest);

    // Wait for response
    await new Promise(resolve => setTimeout(resolve, 1000));

    testProcess.kill();

    // Parse responses
    const lines = stdout.trim().split("\n");
    const responses = lines
      .filter(line => line.trim())
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    // Find the tools/list response
    const toolsResponse = responses.find(r => r.id === 2);
    expect(toolsResponse).toBeDefined();
    expect(toolsResponse.result).toBeDefined();
    expect(toolsResponse.result.tools).toBeDefined();
    
    const tools = toolsResponse.result.tools;
    expect(tools.length).toBeGreaterThan(0);
    
    // Verify we have all the expected tools
    const toolNames = tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain("symphony.start");
    expect(toolNames).toContain("symphony.stop");
    expect(toolNames).toContain("symphony.status");
    expect(toolNames).toContain("symphony.listIssues");
    expect(toolNames).toContain("symphony.reloadWorkflow");
    expect(toolNames).toContain("symphony.runOnce");
    expect(toolNames).toContain("symphony.retryIssue");
    expect(toolNames).toContain("symphony.inspect");
    
    console.log("✅ MCP server exposed all expected tools:");
    toolNames.forEach((name: string) => console.log(`  - ${name}`));
  });

  test("symphony.status should return correct initial state", async () => {
    const testProcess = spawn(
      "/home/fychao/.bun/bin/bun",
      ["/home/fychao/plugin-symphony/opencode-symphony/dist/index.js"],
      {
        env: {
          ...process.env,
          LINEAR_API_KEY: "test_api_key",
        },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    let stdout = "";

    testProcess.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    // Wait for server to initialize
    await new Promise(resolve => setTimeout(resolve, INIT_TIMEOUT_MS));

    // Send initialized notification
    testProcess.stdin?.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {}
    }) + "\n");

    await new Promise(resolve => setTimeout(resolve, 500));

    // Send tools/call request for symphony.status
    const statusRequest = JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "symphony.status",
        arguments: {}
      }
    }) + "\n";

    testProcess.stdin?.write(statusRequest);

    // Wait for response
    await new Promise(resolve => setTimeout(resolve, 1000));

    testProcess.kill();

    // Parse responses
    const lines = stdout.trim().split("\n");
    const responses = lines
      .filter(line => line.trim())
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const statusResponse = responses.find(r => r.id === 3);
    expect(statusResponse).toBeDefined();
    expect(statusResponse.result).toBeDefined();
    
    const content = statusResponse.result.content;
    expect(content).toBeDefined();
    expect(content[0]).toBeDefined();
    expect(content[0].type).toBe("text");
    
    const statusData = JSON.parse(content[0].text);
    expect(statusData.isRunning).toBe(false);
    expect(statusData.workflow).toBeNull();
    
    console.log("✅ symphony.status returned correct initial state:", statusData);
  });
});
