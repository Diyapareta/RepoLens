import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

dotenv.config({
  path: resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../.env"
  ),
});

const { database, initializeDatabase } = await import("./db.js");

initializeDatabase()
  .then(() => console.log("RepoLens database is ready."))
  .finally(() => database.end())
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });