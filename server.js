import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { rateLimit } from "express-rate-limit";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT;
if (!PORT) throw new Error("PORT environment variable is required.");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const structureLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait a few minutes and try again." },
});

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a clinical documentation assistant. Extract and structure clinical information from the provided note into the exact sections below.

Rules:
- Section labels are in Spanish (exactly as shown). Clinical content/findings are in English.
- NEVER invent or assume clinical data. If a section has no information in the note, use the string "No documentado".
- Use "a/c" to abbreviate "antes de comer" (before meals).
- Use "NE" for "no especificado" (not specified) when something is partially mentioned but lacks detail.
- For DIAGNÓSTICOS, include ICD-10 codes if identifiable; otherwise note "NE" for the code.
- For MEDICAMENTOS, list each medication on its own entry with dose, route, and frequency when available.
- For SCREENINGS, list any preventive screenings mentioned or ordered; use "No documentado" if none.
- For REFERIDOS A CASE MANAGEMENT, list any referrals to case management or social work; use "No documentado" if none.
- For JUSTIFICACIÓN CÓDIGO DE VISITA, explain the medical decision complexity that justifies the visit code (e.g., MDM level); use "No documentado" if not determinable.

Return a JSON object with exactly these keys:
{
  "diagnosticos": [{ "description": string, "icd10": string }],
  "medicamentos": string[],
  "revisionDeSistemas": string,
  "examenFisico": { [system: string]: string },
  "screenings": string[],
  "assessmentAndPlan": string,
  "justificacionCodigoVisita": string,
  "referidosCaseManagement": string[]
}

Return ONLY valid JSON. No markdown, no code fences, no explanation.`;

function requirePassword(req, res, next) {
  const expected = process.env.ACCESS_PASSWORD || "CliNote2025";
  const provided = req.headers["x-access-password"];
  if (provided !== expected) {
    res.status(401).json({ error: "Unauthorized. Incorrect password." });
    return;
  }
  next();
}

app.get("/api/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/auth", (req, res) => {
  const expected = process.env.ACCESS_PASSWORD || "CliNote2025";
  const { password } = req.body;
  if (password !== expected) {
    res.status(401).json({ ok: false });
    return;
  }
  res.json({ ok: true });
});

app.post("/api/structure", requirePassword, structureLimiter, async (req, res) => {
  const { note } = req.body;

  if (!note || typeof note !== "string" || note.trim().length === 0) {
    res.status(400).json({ error: "A non-empty 'note' field is required." });
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ error: "ANTHROPIC_API_KEY is not configured." });
    return;
  }

  try {
    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      messages: [{ role: "user", content: note.trim() }],
      system: SYSTEM_PROMPT,
    });

    const textBlock = message.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      res.status(500).json({ error: "No text response from Claude." });
      return;
    }

    const raw = textBlock.text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();

    let structured;
    try {
      structured = JSON.parse(raw);
    } catch {
      res.status(500).json({ error: "Claude returned non-JSON output.", raw: textBlock.text });
      return;
    }

    res.json({ structured });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/{*path}", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});
