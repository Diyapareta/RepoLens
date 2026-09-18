export type RepoRef = { owner: string; repo: string; ref?: string };

export type RepositoryFile = {
  path: string;
  size: number;
  extension: string;
  url: string;
};

export type CodeChunk = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  content: string;
};

type GitHubTreeItem = {
  path: string;
  type: "blob" | "tree" | "commit";
  size?: number;
};

const ALLOWED_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".java", ".go", ".rs",
  ".rb", ".php", ".cs", ".cpp", ".c", ".h", ".swift", ".kt", ".kts", ".sql",
  ".html", ".css", ".scss", ".json", ".yml", ".yaml", ".md", ".sh", ".dockerfile"
]);
const IGNORED_DIRECTORIES = new Set([
  "node_modules", "vendor", ".git", "dist", "build", "coverage", ".next", ".cache", "__pycache__"
]);
const MAX_FILE_SIZE = 250_000;
const MAX_FILES = 300;

export function parseGitHubUrl(input: string): RepoRef | null {
  try {
    const url = new URL(input.trim());
    if (url.hostname !== "github.com") return null;
    const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (parts.length < 2 || !parts[0] || !parts[1]) return null;

    const repo = parts[1].replace(/\.git$/, "");
    const ref = parts[2] === "tree" && parts[3] ? parts[3] : undefined;
    return { owner: parts[0], repo, ref };
  } catch {
    return null;
  }
}

function isEligible(item: GitHubTreeItem): boolean {
  if (item.type !== "blob" || !item.path || (item.size ?? 0) > MAX_FILE_SIZE) return false;
  const segments = item.path.split("/");
  if (segments.some((segment) => IGNORED_DIRECTORIES.has(segment))) return false;
  const filename = segments.at(-1)?.toLowerCase() ?? "";
  const extension = filename.includes(".") ? `.${filename.split(".").at(-1)}` : "";
  return ALLOWED_EXTENSIONS.has(extension) || filename === "dockerfile";
}

async function githubFetch(path: string) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "RepoLens-MVP",
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
    }
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const message = typeof body.message === "string" ? body.message : "GitHub request failed";
    throw new Error(`${response.status}: ${message}`);
  }
  return response.json();
}

async function githubText(path: string): Promise<string> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github.raw+json",
      "User-Agent": "RepoLens-MVP",
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
    }
  });
  if (!response.ok) throw new Error(`Unable to download a repository file (${response.status}).`);
  return response.text();
}

export async function inspectRepository(ref: RepoRef) {
  const repository = await githubFetch(`/repos/${ref.owner}/${ref.repo}`) as {
    default_branch: string; description: string | null; language: string | null; stargazers_count: number; html_url: string;
  };
  const branch = ref.ref ?? repository.default_branch;
  const tree = await githubFetch(`/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`) as {
    truncated: boolean; tree: GitHubTreeItem[];
  };
  const files = tree.tree.filter(isEligible).slice(0, MAX_FILES).map((item) => {
    const filename = item.path.split("/").at(-1)?.toLowerCase() ?? "";
    const extension = filename.includes(".") ? `.${filename.split(".").at(-1)}` : "";
    return {
      path: item.path,
      size: item.size ?? 0,
      extension: filename === "dockerfile" ? ".dockerfile" : extension,
      url: `https://github.com/${ref.owner}/${ref.repo}/blob/${branch}/${item.path}`
    };
  });

  return {
    repository: { owner: ref.owner, name: ref.repo, branch, description: repository.description, language: repository.language, stars: repository.stargazers_count, url: repository.html_url },
    files,
    ignoredCount: tree.tree.length - files.length,
    truncated: tree.truncated,
    limits: { maxFileSize: MAX_FILE_SIZE, maxFiles: MAX_FILES }
  };
}

function splitIntoChunks(path: string, content: string, maxLines = 80, overlap = 12): CodeChunk[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const chunks: CodeChunk[] = [];
  for (let start = 0; start < lines.length; start += maxLines - overlap) {
    const end = Math.min(start + maxLines, lines.length);
    const text = lines.slice(start, end).join("\n").trim();
    if (text) chunks.push({ id: `${path}:${start + 1}-${end}`, path, startLine: start + 1, endLine: end, content: text });
    if (end === lines.length) break;
  }
  return chunks;
}

export async function prepareRepository(ref: RepoRef) {
  const inspection = await inspectRepository(ref);
  const chunks: CodeChunk[] = [];
  const skipped: string[] = [];
  for (const file of inspection.files.slice(0, 100)) {
    try {
      const content = await githubText(`/repos/${ref.owner}/${ref.repo}/contents/${file.path}?ref=${encodeURIComponent(inspection.repository.branch)}`);
      if (!content.includes("\u0000")) chunks.push(...splitIntoChunks(file.path, content));
      else skipped.push(file.path);
    } catch { skipped.push(file.path); }
  }
  return {
    repository: inspection.repository,
    processedFiles: Math.min(inspection.files.length, 100) - skipped.length,
    chunks,
    skippedFiles: skipped,
    note: "Chunks are currently prepared in memory. The next MVP step stores their embeddings in PostgreSQL with pgvector."
  };
}
