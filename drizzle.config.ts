import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/platform/db/schema.ts", "./src/modules/bounty/schema.ts", "./src/modules/answer/schema.ts"],
  out: "netlify/database/migrations",
});
