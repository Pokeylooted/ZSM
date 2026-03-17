import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

interface LocalStdServer {
    process: child_process.ChildProcess;
    port: number;
    baseUrl: string;
}

let activeServer: LocalStdServer | null = null;

function findZigExecutable(): string {
    const zigPath = process.env.ZIG_PATH || "zig";
    try {
        const result = child_process.execSync(`${zigPath} version`, { encoding: "utf8" });
        if (result.includes("dev") || /\d+\.\d+\.\d+/.test(result)) {
            return zigPath;
        }
    } catch {
        // Continue to fallback
    }

    const commonPaths = [
        "/usr/local/bin/zig",
        "/usr/bin/zig",
        "/opt/homebrew/bin/zig",
        "/opt/zig/zig",
        path.join(process.env.HOME || "", ".local/bin/zig"),
    ];

    for (const p of commonPaths) {
        if (fs.existsSync(p)) {
            try {
                child_process.execSync(`${p} version`, { encoding: "utf8" });
                return p;
            } catch {
                // Continue checking
            }
        }
    }

    return "zig";
}

export function getZigVersion(): string {
    const zigPath = findZigExecutable();
    try {
        const result = child_process.execSync(`${zigPath} version`, { encoding: "utf8" });
        return result.trim();
    } catch (error) {
        throw new Error(`Failed to get Zig version: ${error}`);
    }
}

export async function startLocalStdServer(): Promise<LocalStdServer> {
    if (activeServer) {
        return activeServer;
    }

    const zigPath = findZigExecutable();

    return new Promise((resolve, reject) => {
        const stdProcess = child_process.spawn(zigPath, ["std", "--no-open-browser"], {
            stdio: ["ignore", "pipe", "pipe"],
        });

        let output = "";
        let errorOutput = "";
        let resolved = false;

        const timeout = setTimeout(() => {
            if (!resolved) {
                stdProcess.kill();
                reject(new Error("Timeout waiting for Zig std server to start"));
            }
        }, 10000);

        stdProcess.stdout?.on("data", (data) => {
            output += data.toString();

            // Match patterns like "http://127.0.0.1:43695/"
            const match = output.match(/(http:\/\/[0-9.]+:[0-9]+)/);
            if (match && !resolved) {
                resolved = true;
                clearTimeout(timeout);

                const baseUrl = match[1];
                const port = parseInt(baseUrl.split(":").pop() || "43695");

                activeServer = {
                    process: stdProcess,
                    port,
                    baseUrl,
                };

                resolve(activeServer);
            }
        });

        stdProcess.stderr?.on("data", (data) => {
            errorOutput += data.toString();
        });

        stdProcess.on("error", (error) => {
            clearTimeout(timeout);
            if (!resolved) {
                resolved = true;
                reject(new Error(`Failed to start Zig std server: ${error.message}`));
            }
        });

        stdProcess.on("exit", (code) => {
            clearTimeout(timeout);
            if (!resolved) {
                resolved = true;
                reject(new Error(`Zig std server exited with code ${code}: ${errorOutput}`));
            }
            activeServer = null;
        });
    });
}

export function stopLocalStdServer(): void {
    if (activeServer) {
        activeServer.process.kill();
        activeServer = null;
    }
}

export async function fetchFromLocalServer(urlPath: string): Promise<string> {
    const server = await startLocalStdServer();
    const url = `${server.baseUrl}${urlPath}`;

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    return await response.text();
}

export async function getLocalStdSources(): Promise<Uint8Array<ArrayBuffer>> {
    const server = await startLocalStdServer();
    const url = `${server.baseUrl}/sources.tar`;

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch sources.tar: HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
}

process.on("exit", stopLocalStdServer);
process.on("SIGINT", stopLocalStdServer);
process.on("SIGTERM", stopLocalStdServer);
