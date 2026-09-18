import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import cors from "cors";
import express from "express";
import { inspectRepository, parseGitHubUrl, prepareRepository } from "./github.js";
import { answerQuestion, indexRepository } from "./rag.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(currentDirectory, "../../../.env") });

const app = express();
app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json({ limit: "20kb" }));

app.get("/api/health", (_request, response) => response.json({ ok: true }));

app.post("/api/repositories/ingest", async (request, response) => {
  const url = typeof request.body?.url === "string" ? request.body.url : "";
  const ref = parseGitHubUrl(url);
  if (!ref) return response.status(400).json({ error: "Enter a public GitHub repository URL, such as https://github.com/owner/repository." });

  try {
    response.json(await inspectRepository(ref));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to inspect this repository.";
    const status = message.startsWith("404") ? 404 : message.startsWith("403") ? 429 : 502;
    response.status(status).json({ error: message });
  }
});

app.post("/api/repositories/prepare", async (request, response) => {
  const url = typeof request.body?.url === "string" ? request.body.url : "";
  const ref = parseGitHubUrl(url);
  if (!ref) return response.status(400).json({ error: "Enter a public GitHub repository URL first." });
  try { response.json(await prepareRepository(ref)); }
  catch (error) {
    const message = error instanceof Error ? error.message : "Unable to prepare this repository.";
    response.status(502).json({ error: message });
  }
});

app.post("/api/repositories/index", async (request, response) => {
  const url = typeof request.body?.url === "string" ? request.body.url : "";
  const ref = parseGitHubUrl(url);
  if (!ref) return response.status(400).json({ error: "Enter a public GitHub repository URL first." });
  try { response.json(await indexRepository(url, ref)); }
  catch (error) {
  const message =
    error instanceof Error ? error.message : "Unable to index this repository.";

  const status =
    message.startsWith("429") ? 429 :
    message.startsWith("403") ? 403 :
    message.startsWith("404") ? 404 :
    502;

  response.status(status).json({ error: message });
}
});

app.post("/api/questions", async (request, response) => {
  const url = typeof request.body?.url === "string" ? request.body.url : "";
  const question = typeof request.body?.question === "string" ? request.body.question.trim() : "";
  if (!parseGitHubUrl(url) || !question) return response.status(400).json({ error: "A repository URL and question are required." });
  try { response.json(await answerQuestion(url, question)); }
  catch (error) { response.status(502).json({ error: error instanceof Error ? error.message : "Unable to answer this question." }); }
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => console.log(`RepoLens API listening on http://localhost:${port}`));
