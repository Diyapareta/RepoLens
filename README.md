# RepoLens

An AI-powered analyzer for public GitHub repositories. This first milestone accepts a public GitHub URL, reads its file tree through the GitHub API, and filters files ready for the later chunking and RAG stages.

## Run locally

1. Copy `.env.example` to `.env` and add your Neon `DATABASE_URL` and Gemini `GEMINI_API_KEY`. A GitHub token is optional.
2. Install dependencies: `npm install`
3. Create the database tables: `npm run db:init -w @repolens/api`
4. Start both apps: `npm run dev`
4. Open `http://localhost:5173`

The API runs on port 4000. Public repositories work without a token, though GitHub applies a low anonymous rate limit.

## MVP roadmap

- [x] Project shell and public-repository ingestion
- [x] Download eligible file contents and split them into chunks
- [x] Generate embeddings and store chunks in PostgreSQL with pgvector
- [x] Retrieve relevant chunks and answer questions with citations
- [ ] Add persistence and deployment polish

## Deliberately out of scope

OAuth, private repositories, deep security scanning, and collaboration features are not part of this MVP.
