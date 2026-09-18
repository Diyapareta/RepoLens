import { GoogleGenAI } from "@google/genai";
import { database } from "./db.js";
import { prepareRepository, type CodeChunk, type RepoRef } from "./github.js";

const embeddingModel = "gemini-embedding-2";
const answerModel = "gemini-3.8-flash";

type StoredChunk = Pick<CodeChunk, "path" | "startLine" | "endLine" | "content">;
function vector(values: number[]) {
  if (!values?.length) {
    throw new Error("Invalid or missing embedding vector.");
  }

  return `[${values.join(",")}]`;
}
function client() {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is missing from .env.");
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}
async function embed(inputs: string[]) {
  const response = await client().models.embedContent({
    model: embeddingModel,
    contents: inputs.map((text) => ({
      parts: [{ text }],
    })),
    config: {
      outputDimensionality: 1536,
    },
  });

  const values =
    response.embeddings?.map((item) => item.values ?? []) ?? [];

  if (values.length !== inputs.length) {
    throw new Error(
      `Invalid embeddings: expected ${inputs.length}, got ${values.length}`
    );
  }

  if (values.some((vector) => vector.length === 0)) {
    throw new Error("Gemini returned an empty embedding.");
  }

  return values;
}
export async function indexRepository(url: string, ref: RepoRef) {
  const prepared = await prepareRepository(ref);
  const repository = await database.query<{ id: string }>(`
    INSERT INTO repositories (github_url, owner, name, branch)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (github_url) DO UPDATE SET branch = EXCLUDED.branch
    RETURNING id`, [url, prepared.repository.owner, prepared.repository.name, prepared.repository.branch]);
  const repositoryId = repository.rows[0].id;
  await database.query("DELETE FROM code_chunks WHERE repository_id = $1", [repositoryId]);

  const MAX_BATCH_CHARS = 45_000;

let batch: typeof prepared.chunks = [];
let batchChars = 0;

async function processBatch(chunks: typeof prepared.chunks) {
  if (!chunks.length) return;

  console.log(
    `Embedding ${chunks.length} chunks (~${chunks.reduce(
      (total, chunk) => total + chunk.content.length,
      0
    )} chars)...`
  );

  const embeddings = await embed(
    chunks.map((chunk) => chunk.content)
  );

  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];

    await database.query(
      `INSERT INTO code_chunks
        (repository_id, path, start_line, end_line, content, embedding)
       VALUES ($1, $2, $3, $4, $5, $6::vector)`,
      [
        repositoryId,
        chunk.path,
        chunk.startLine,
        chunk.endLine,
        chunk.content,
        vector(embeddings[index]),
      ]
    );
  }
}

for (const chunk of prepared.chunks) {
  const chunkSize = chunk.content.length;

  if (
    batch.length > 0 &&
    batchChars + chunkSize > MAX_BATCH_CHARS
  ) {
    await processBatch(batch);
    batch = [];
    batchChars = 0;
  }

  batch.push(chunk);
  batchChars += chunkSize;
}

await processBatch(batch);
  return { repositoryId, indexedChunks: prepared.chunks.length, processedFiles: prepared.processedFiles };
}

export async function answerQuestion(url: string, question: string) {
  const [questionEmbedding] = await embed([question]);
  const results = await database.query<StoredChunk>(`
    SELECT c.path, c.start_line AS "startLine", c.end_line AS "endLine", c.content
    FROM code_chunks c JOIN repositories r ON r.id = c.repository_id
    WHERE r.github_url = $1
    ORDER BY c.embedding <=> $2::vector
    LIMIT 8`, [url, vector(questionEmbedding)]);
  if (!results.rows.length) throw new Error("This repository has not been indexed yet. Click Build AI index first.");
  const context = results.rows.map((chunk, index) => `[${index + 1}] ${chunk.path}:${chunk.startLine}-${chunk.endLine}\n${chunk.content}`).join("\n\n");
  const response = await client().models.generateContent({
    model: answerModel,
    contents: `Question: ${question}\n\nRepository context:\n${context}`,
    config: {
      maxOutputTokens: 500,
      temperature: 0.2,
      systemInstruction: "Answer only from the supplied repository context. If the context is insufficient, say so. Be concise and do not invent source locations."
    }
  });
  return { answer: response.text ?? "No answer was returned.", sources: results.rows.map(({ path, startLine, endLine }) => ({ path, startLine, endLine })) };
}
