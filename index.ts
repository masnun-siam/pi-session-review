import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createServer, type Server, type ServerResponse } from "http";
import { readFileSync, existsSync, writeFileSync, statSync, watch, type FSWatcher } from "fs";
import { join, relative, sep } from "path";
import { exec, execSync } from "child_process";

let server: Server | null = null;
let port: number = 0;
let watcher: FSWatcher | null = null;
const sseClients = new Set<ServerResponse>();

type Comment = {
  id: string;
  file: string;
  line: number;
  content: string;
  createdAt: string;
  status: "pending" | "sent" | "acknowledged";
  sentAt: string | null;
  piResponse: string | null;
};

type ReviewFile = {
  version: number;
  sessionId: string;
  lastReviewAt: string | null;
  comments: Comment[];
  preferences: { viewMode: "split" | "unified" };
};

type SettingsFile = {
  version: number;
  theme: string;
  appearance: string;
};

type DiffParams = {
  mode: "worktree" | "staged" | "branches";
  base: string | null;
  head: string | null;
  dots: "2" | "3";
};

function getReviewFilePath(sessionId: string): string {
  const sessionsDir = join(process.env.HOME || "", ".pi", "agent", "sessions");
  return join(sessionsDir, `${sessionId}-review.json`);
}

function readReview(reviewFile: string): ReviewFile {
  return JSON.parse(readFileSync(reviewFile, "utf-8"));
}

function ensureReviewFile(sessionId: string): string {
  const filePath = getReviewFilePath(sessionId);
  if (!existsSync(filePath)) {
    const initial: ReviewFile = {
      version: 1,
      sessionId,
      lastReviewAt: null,
      comments: [],
      preferences: { viewMode: "split" },
    };
    writeFileSync(filePath, JSON.stringify(initial, null, 2));
  }
  return filePath;
}

function getSettingsFilePath(): string {
  return join(process.env.HOME || "", ".pi", "agent", "session-review.json");
}

const ALLOWED_THEMES = ["default", "github", "dracula", "solarized", "catppuccin"];
const ALLOWED_APPEARANCES = ["dark", "light", "system"];

function readSettings(): SettingsFile {
  const path = getSettingsFilePath();
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf-8"));
    }
  } catch { /* corrupt — return defaults */ }
  return { version: 1, theme: "default", appearance: "system" };
}

function writeSettings(data: SettingsFile): void {
  writeFileSync(getSettingsFilePath(), JSON.stringify(data, null, 2));
}

function isSafeRef(name: string): boolean {
  return /^[A-Za-z0-9._/+-]+$/.test(name) && !name.startsWith("-");
}

function parseDiffParams(url: URL): { params: DiffParams } | { error: string } {
  const rawMode = url.searchParams.get("mode") || "worktree";
  if (!["worktree", "staged", "branches"].includes(rawMode)) {
    return { error: `Invalid mode: ${rawMode}` };
  }
  const mode = rawMode as DiffParams["mode"];
  const base = url.searchParams.get("base");
  const head = url.searchParams.get("head");
  const dots = (url.searchParams.get("dots") === "2" ? "2" : "3") as "2" | "3";
  if (mode === "branches") {
    if (!base || !head) return { error: "base and head required for branches mode" };
    if (!isSafeRef(base)) return { error: `Invalid base ref: ${base}` };
    if (!isSafeRef(head)) return { error: `Invalid head ref: ${head}` };
  }
  return { params: { mode, base, head, dots } };
}

function openBrowser(url: string) {
  const platform = process.platform;
  const cmd =
    platform === "darwin"
      ? `open "${url}"`
      : platform === "win32"
        ? `start "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd);
}

function corsHeaders(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", `http://localhost:${port}`);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function parseDiff(diffOutput: string) {
  const lines = diffOutput.split("\n");
  const result: Array<{ type: string; content: string; oldNum?: number; newNum?: number }> = [];
  let oldLine = 0;
  let newLine = 0;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldLine = parseInt(m[1], 10);
        newLine = parseInt(m[2], 10);
      }
      result.push({ type: "header", content: line });
    } else if (line.startsWith("+++") || line.startsWith("---")) {
      // file headers - skip
      continue;
    } else if (line.startsWith("+")) {
      result.push({ type: "added", content: line.slice(1), newNum: newLine++ });
    } else if (line.startsWith("-")) {
      result.push({ type: "removed", content: line.slice(1), oldNum: oldLine++ });
    } else if (line.startsWith(" ") || line === "") {
      result.push({ type: "context", content: line.slice(1) || "", oldNum: oldLine++, newNum: newLine++ });
    }
  }
  return result;
}

function listChangedFiles(cwd: string, params: DiffParams = { mode: "worktree", base: null, head: null, dots: "3" }) {
  // Derive the diff target from params
  let target: string;
  if (params.mode === "staged") {
    target = "--cached";
  } else if (params.mode === "branches") {
    const rangeSep = params.dots === "2" ? ".." : "...";
    target = `${params.base}${rangeSep}${params.head}`;
  } else {
    target = "HEAD";
  }

  // numstat output: "added\tdeleted\tpath"
  let numstat = "";
  try {
    numstat = execSync(`git diff --numstat ${target}`, {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    /* not a git repo or no HEAD */
  }

  // Status (A/M/D etc.) for tracked changes
  let statusOut = "";
  try {
    statusOut = execSync(`git diff --name-status ${target}`, {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    /* ignore */
  }

  const statusMap = new Map<string, string>();
  for (const line of statusOut.split("\n")) {
    if (!line) continue;
    const [code, ...rest] = line.split("\t");
    const path = rest.join("\t");
    if (path) statusMap.set(path, (code || "M").charAt(0).toUpperCase());
  }

  const files = new Map<string, { path: string; status: string; added: number; removed: number }>();

  for (const line of numstat.split("\n")) {
    if (!line) continue;
    const [a, d, path] = line.split("\t");
    if (!path) continue;
    files.set(path, {
      path,
      status: statusMap.get(path) || "M",
      added: a === "-" ? 0 : parseInt(a, 10) || 0,
      removed: d === "-" ? 0 : parseInt(d, 10) || 0,
    });
  }

  // Untracked (new) files — worktree mode only
  // NOTE: the watcher ignores .git/, so `git add` from a terminal won't trigger
  // staged-mode SSE refresh; file-saves still do. Acceptable for v1.
  if (params.mode === "worktree") {
    let untracked = "";
    try {
      untracked = execSync("git ls-files --others --exclude-standard", {
        cwd,
        encoding: "utf-8",
        stdio: "pipe",
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch {
      /* ignore */
    }

    for (const path of untracked.split("\n").map((s) => s.trim()).filter(Boolean)) {
      if (files.has(path)) continue;
      let added = 0;
      try {
        const abs = join(cwd, path);
        const content = readFileSync(abs, "utf-8");
        added = content.length === 0 ? 0 : content.split("\n").length;
        // trailing newline shouldn't count as an extra line
        if (content.endsWith("\n")) added = Math.max(0, added - 1);
      } catch {
        /* binary or unreadable */
      }
      files.set(path, { path, status: "A", added, removed: 0 });
    }
  }

  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function getDiffForFile(cwd: string, file: string, params: DiffParams = { mode: "worktree", base: null, head: null, dots: "3" }) {
  // Derive the diff target from params
  let target: string;
  if (params.mode === "staged") {
    target = "--cached";
  } else if (params.mode === "branches") {
    const rangeSep = params.dots === "2" ? ".." : "...";
    target = `${params.base}${rangeSep}${params.head}`;
  } else {
    target = "HEAD";
  }

  let out = "";
  try {
    out = execSync(`git diff ${target} -- "${file}"`, {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    /* ignore */
  }
  if (out.trim()) return parseDiff(out);

  // Untracked / new file: synthesize a full-add diff via --no-index against /dev/null
  // Only applicable in worktree mode — staged/branches can't produce untracked files
  if (params.mode === "worktree") {
    try {
      out = execSync(`git diff --no-index --no-color -- /dev/null "${file}"`, {
        cwd,
        encoding: "utf-8",
        stdio: "pipe",
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch (err: any) {
      // git diff --no-index exits 1 when files differ — that's expected
      out = err?.stdout || "";
    }
  }
  return parseDiff(out);
}

function broadcast(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

function startWatcher(cwd: string) {
  if (watcher) return;
  let timer: NodeJS.Timeout | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => broadcast("files-changed", { at: Date.now() }), 300);
  };
  try {
    watcher = watch(cwd, { recursive: true, persistent: false }, (_evt, filename) => {
      if (!filename) return schedule();
      // ignore noisy paths
      const name = filename.toString();
      if (name.includes(`.git${sep}`) || name === ".git" || name.includes("node_modules")) return;
      schedule();
    });
    watcher.on("error", () => {
      /* swallow */
    });
  } catch (err) {
    console.warn("session-review: file watcher unavailable:", err);
  }
}

function stopWatcher() {
  if (watcher) {
    try {
      watcher.close();
    } catch {
      /* ignore */
    }
    watcher = null;
  }
}

function renderCommentsAsMarkdown(comments: Comment[]): string {
  const byFile = new Map<string, Comment[]>();
  for (const c of comments) {
    if (!byFile.has(c.file)) byFile.set(c.file, []);
    byFile.get(c.file)!.push(c);
  }
  const sections: string[] = [
    "Review comments from `/changes`:",
    "",
  ];
  for (const [file, list] of byFile) {
    sections.push(`### ${file}`);
    for (const c of list) {
      sections.push(`- **line ${c.line}** — ${c.content.trim()}`);
    }
    sections.push("");
  }
  sections.push("Please address each comment.");
  return sections.join("\n");
}

export default function activate(pi: ExtensionAPI): void {
  pi.registerCommand("changes", {
    description: "Open session review UI in browser",
    handler: async (_args, ctx) => {
      try {
        const sessionFile = ctx.sessionManager.getSessionFile();
        if (!sessionFile) {
          console.log("session-review: No active session found.");
          return;
        }
        const sessionId =
          sessionFile.split("/").pop()?.replace(".jsonl", "") || "unknown";
        const reviewFile = ensureReviewFile(sessionId);
        const cwd = (ctx as any).cwd || process.cwd();

        if (server) {
          console.log(`session-review: Review UI already running at http://localhost:${port}`);
          openBrowser(`http://localhost:${port}`);
          return;
        }

        const uiDir = join(__dirname, "ui");
        const indexHtml = readFileSync(join(uiDir, "index.html"), "utf-8");
        const appJs = readFileSync(join(uiDir, "app.js"), "utf-8");
        const stylesCss = readFileSync(join(uiDir, "styles.css"), "utf-8");

        server = createServer((req, res) => {
          try {
            const url = new URL(req.url || "/", `http://localhost`);

            if (req.method === "OPTIONS") {
              corsHeaders(res);
              res.writeHead(204);
              res.end();
              return;
            }

            if (url.pathname === "/") {
              res.writeHead(200, { "Content-Type": "text/html" });
              res.end(indexHtml);
              return;
            }

            if (url.pathname === "/styles.css") {
              res.writeHead(200, { "Content-Type": "text/css" });
              res.end(stylesCss);
              return;
            }

            if (url.pathname === "/app.js") {
              corsHeaders(res);
              res.writeHead(200, { "Content-Type": "application/javascript" });
              res.end(appJs);
              return;
            }

            if (url.pathname === "/api/session") {
              corsHeaders(res);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ sessionId }));
              return;
            }

            if (url.pathname === "/api/events") {
              corsHeaders(res);
              res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
              });
              res.write("retry: 3000\n\n");
              sseClients.add(res);
              req.on("close", () => sseClients.delete(res));
              return;
            }

            if (url.pathname === "/api/files") {
              corsHeaders(res);
              const parsedFiles = parseDiffParams(url);
              if ("error" in parsedFiles) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: parsedFiles.error }));
                return;
              }
              try {
                const files = listChangedFiles(cwd, parsedFiles.params);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ files }));
              } catch (err) {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(
                  JSON.stringify({
                    files: [],
                    error: err instanceof Error ? err.message : String(err),
                  })
                );
              }
              return;
            }

            if (url.pathname === "/api/diff") {
              corsHeaders(res);
              const file = url.searchParams.get("file");
              if (!file) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: "file parameter required" }));
                return;
              }
              const parsedDiff = parseDiffParams(url);
              if ("error" in parsedDiff) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: parsedDiff.error }));
                return;
              }
              try {
                const lines = getDiffForFile(cwd, file, parsedDiff.params);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ lines }));
              } catch (err) {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(
                  JSON.stringify({
                    lines: [],
                    error: err instanceof Error ? err.message : String(err),
                  })
                );
              }
              return;
            }

            if (url.pathname === "/api/review" && req.method === "GET") {
              corsHeaders(res);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(readFileSync(reviewFile, "utf-8"));
              return;
            }

            if (url.pathname === "/api/review" && req.method === "POST") {
              let body = "";
              req.on("error", () => {
                if (!res.headersSent) res.writeHead(500);
                res.end(JSON.stringify({ error: "Request stream error" }));
              });
              req.on("data", (chunk) => (body += chunk));
              req.on("end", () => {
                try {
                  writeFileSync(reviewFile, body);
                  corsHeaders(res);
                  res.writeHead(200, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ success: true }));
                } catch (writeErr) {
                  if (!res.headersSent) res.writeHead(500);
                  res.end(
                    JSON.stringify({
                      error: writeErr instanceof Error ? writeErr.message : "Failed to save review",
                    })
                  );
                }
              });
              return;
            }

            if (url.pathname === "/api/send" && req.method === "POST") {
              try {
                const data = readReview(reviewFile);
                const pending = data.comments.filter((c) => c.status === "pending");
                if (pending.length === 0) {
                  corsHeaders(res);
                  res.writeHead(200, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ sent: 0 }));
                  return;
                }
                const message = renderCommentsAsMarkdown(pending);
                try {
                  pi.sendUserMessage(message, { deliverAs: "followUp" });
                } catch (err) {
                  console.error("session-review: sendUserMessage failed:", err);
                }
                const now = new Date().toISOString();
                data.comments = data.comments.map((c) =>
                  c.status === "pending" ? { ...c, status: "sent", sentAt: now } : c
                );
                data.lastReviewAt = now;
                writeFileSync(reviewFile, JSON.stringify(data, null, 2));
                corsHeaders(res);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ sent: pending.length }));
              } catch (err) {
                corsHeaders(res);
                if (!res.headersSent) res.writeHead(500);
                res.end(
                  JSON.stringify({
                    error: err instanceof Error ? err.message : String(err),
                  })
                );
              }
              return;
            }

            if (url.pathname === "/api/branches") {
              corsHeaders(res);
              try {
                // git branch output: "  name\n* current\n  other"
                const branchOut = execSync("git branch", { cwd, encoding: "utf-8", stdio: "pipe" });
                let current: string | null = null;
                const branches = branchOut
                  .split("\n")
                  .map((s) => s.trim())
                  .filter(Boolean)
                  .map((s) => {
                    if (s.startsWith("* ")) {
                      current = s.slice(2).trim();
                      return current;
                    }
                    return s;
                  });
                const detached = current !== null && current.startsWith("(");
                if (detached) current = null;
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ branches, current, detached }));
              } catch {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ branches: [], current: null, detached: false }));
              }
              return;
            }

            if (url.pathname === "/api/settings" && req.method === "GET") {
              corsHeaders(res);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify(readSettings()));
              return;
            }

            if (url.pathname === "/api/settings" && req.method === "POST") {
              let body = "";
              req.on("error", () => {
                if (!res.headersSent) res.writeHead(500);
                res.end(JSON.stringify({ error: "Request stream error" }));
              });
              req.on("data", (chunk) => (body += chunk));
              req.on("end", () => {
                try {
                  const incoming = JSON.parse(body);
                  const current = readSettings();
                  if (incoming.theme !== undefined && ALLOWED_THEMES.includes(incoming.theme)) {
                    current.theme = incoming.theme;
                  }
                  if (incoming.appearance !== undefined && ALLOWED_APPEARANCES.includes(incoming.appearance)) {
                    current.appearance = incoming.appearance;
                  }
                  writeSettings(current);
                  corsHeaders(res);
                  res.writeHead(200, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ success: true }));
                } catch (err) {
                  if (!res.headersSent) res.writeHead(500);
                  res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Failed to save settings" }));
                }
              });
              return;
            }

            res.writeHead(404);
            res.end("Not found");
          } catch (err) {
            console.error("session-review: request handler error:", err);
            try {
              if (!res.headersSent) res.writeHead(500);
              res.end(JSON.stringify({ error: "Internal server error" }));
            } catch {
              /* ignore */
            }
          }
        });

        server.listen(0, "127.0.0.1", () => {
          const addr = server!.address();
          if (addr && typeof addr === "object") {
            port = addr.port;
            const url = `http://localhost:${port}`;
            console.log(`session-review: Review UI running at ${url}`);
            openBrowser(url);
            startWatcher(cwd);
          }
        });

        server.on("error", (err) => {
          console.error("session-review: server error:", err);
          server = null;
        });
      } catch (err) {
        console.error(
          `session-review: Error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },
  });

  pi.on("session_end", () => {
    stopWatcher();
    for (const c of sseClients) {
      try {
        c.end();
      } catch {
        /* ignore */
      }
    }
    sseClients.clear();
    if (server) {
      server.close();
      server = null;
      port = 0;
    }
  });
}
