import { GoogleGenAI } from "@google/genai";
import { database } from "./db.js";
import {
  prepareRepository,
  type CodeChunk,
  type RepoRef,
} from "./github.js";

const answerModel = "gemini-3.8-flash";

type StoredChunk = Pick<
  CodeChunk,
  "path" | "startLine" | "endLine" | "content"
>;

function vector(values: number[]) {
  if (!values?.length) {
    throw new Error("Invalid or missing embedding vector.");
  }

  return `[${values.join(",")}]`;
}

function client() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is missing from .env.");
  }

  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
  });
}

/**
 * Generate embeddings using Voyage AI.
 *
 * "document" is used for code chunks being indexed.
 * "query" is used for user questions.
 */
async function embed(
  inputs: string[],
  inputType: "query" | "document"
) {
  if (!process.env.VOYAGE_API_KEY) {
    throw new Error("VOYAGE_API_KEY is missing from .env.");
  }

  if (!inputs.length) {
    throw new Error("No text provided for embedding.");
  }

  const response = await fetch(
    "https://api.voyageai.com/v1/embeddings",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({
        model: "voyage-code-4",
        input: inputs,
        input_type: inputType,
        output_dimension: 1024,
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();

    throw new Error(
      `Voyage embedding failed: ${response.status} ${error}`
    );
  }

  const data = await response.json();

  if (!data.data || data.data.length !== inputs.length) {
    throw new Error(
      `Invalid embeddings: expected ${inputs.length}, got ${
        data.data?.length ?? 0
      }`
    );
  }

  const embeddings = data.data
    .sort(
      (a: { index: number }, b: { index: number }) =>
        a.index - b.index
    )
    .map(
      (item: { embedding: number[] }) =>
        item.embedding
    );

  if (
    embeddings.some(
      (embedding: number[]) =>
        !embedding || embedding.length !== 1024
    )
  ) {
    throw new Error(
      "Voyage returned an invalid embedding vector."
    );
  }

  console.log(
    `Voyage generated ${embeddings.length} embeddings with ${embeddings[0].length} dimensions.`
  );

  return embeddings;
}

export async function indexRepository(
  url: string,
  ref: RepoRef
) {
  const prepared = await prepareRepository(ref);

  const repository = await database.query<{ id: string }>(
    `
      INSERT INTO repositories (
        github_url,
        owner,
        name,
        branch
      )
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (github_url)
      DO UPDATE SET branch = EXCLUDED.branch
      RETURNING id
    `,
    [
      url,
      prepared.repository.owner,
      prepared.repository.name,
      prepared.repository.branch,
    ]
  );

  const repositoryId = repository.rows[0].id;

  // Remove old chunks before creating a new index.
  await database.query(
    "DELETE FROM code_chunks WHERE repository_id = $1",
    [repositoryId]
  );

  /**
   * Keep requests reasonably sized.
   * This is based on characters rather than number of chunks
   * because different chunks can have very different sizes.
   */
  const MAX_BATCH_CHARS = 45_000;

  let batch: typeof prepared.chunks = [];
  let batchChars = 0;

  async function processBatch(
    chunks: typeof prepared.chunks
  ) {
    if (!chunks.length) {
      return;
    }

    console.log(
      `Embedding ${chunks.length} chunks (~${chunks.reduce(
        (total, chunk) =>
          total + chunk.content.length,
        0
      )} chars)...`
    );

    const embeddings = await embed(
      chunks.map((chunk) => chunk.content),
      "document"
    );

    for (
      let index = 0;
      index < chunks.length;
      index++
    ) {
      const chunk = chunks[index];

      await database.query(
        `
          INSERT INTO code_chunks (
            repository_id,
            path,
            start_line,
            end_line,
            content,
            embedding
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6::vector
          )
        `,
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

  return {
    repositoryId,
    indexedChunks: prepared.chunks.length,
    processedFiles: prepared.processedFiles,
  };
}

export async function answerQuestion(
  url: string,
  question: string
) {
  /**
   * Convert the user's question into a query embedding.
   */
  const [questionEmbedding] = await embed(
    [question],
    "query"
  );

  /**
   * Find the 8 code chunks most similar to the question.
   */
  const results = await database.query<StoredChunk>(
    `
      SELECT
        c.path,
        c.start_line AS "startLine",
        c.end_line AS "endLine",
        c.content
      FROM code_chunks c
      JOIN repositories r
        ON r.id = c.repository_id
      WHERE r.github_url = $1
      ORDER BY c.embedding <=> $2::vector
      LIMIT 8
    `,
    [
      url,
      vector(questionEmbedding),
    ]
  );

  if (!results.rows.length) {
    throw new Error(
      "This repository has not been indexed yet. Click Build AI index first."
    );
  }

  /**
   * Convert retrieved chunks into context for Gemini.
   */
  const context = results.rows
    .map(
      (chunk, index) =>
        `[${index + 1}] ${chunk.path}:${chunk.startLine}-${chunk.endLine}\n${chunk.content}`
    )
    .join("\n\n");

  /**
   * Gemini is used only for generating the final answer.
   */
  const response =
    await client().models.generateContent({
      model: answerModel,
      contents: `
Question:
${question}

Repository context:
${context}
      `,
      config: {
        maxOutputTokens: 500,
        temperature: 0.2,
        systemInstruction:
          "Answer only from the supplied repository context. If the context is insufficient, say so. Be concise and do not invent source locations.",
      },
    });

  return {
    answer:
      response.text ??
      "No answer was returned.",

    sources: results.rows.map(
      ({
        path,
        startLine,
        endLine,
      }) => ({
        path,
        startLine,
        endLine,
      })
    ),
  };
}