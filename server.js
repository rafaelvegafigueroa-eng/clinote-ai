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

const structureLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, validate: false });

const SYSTEM_PROMPT = `You are a clinical documentation assistant for Innovaon home visit notes. Extract and structure clinical information from the provided note into the exact fields below.

Rules:
- NEVER invent or assume clinical data. If a section has no information in the note, use "No documentado".
- Use "a/c" for antes de comer (before meals). Use "NE" for not specified when something is partially mentioned but lacks detail.
- Do NOT generate a diagnosis list or ICD-10 codes — that section is handled separately in Innovaon.
- MEDICAMENTOS: list each medication on its own entry with dose, route, and frequency when available.
- ROS DETAILS: cover all 10 systems listed. For each system use "Confirms" for positive findings and "Denies" for negative findings with brief details (e.g. "Confirms mild fatigue. Denies fever, chills."). If the system is not mentioned in the note, write "No documentado".
- ASSESSMENT & PLAN: number each active diagnosis or problem. Under each, write a concise 2–3 line plan (e.g., medication changes, follow-up, labs ordered).
- JUSTIFICACIÓN CÓDIGO DE VISITA: write an MDM narrative supporting CPT 99349 or 99350 for an established home visit patient. Cite: number of problems addressed, complexity of data reviewed, and risk level (prescription drug management, chronic illness, etc.).
- REFERIDOS A CASE MANAGEMENT: state CMR risk level (Low / Medium / High) with a one-line rationale, the primary reason category, and a brief reason for referral. If no referral is indicated, write "No documentado".
- ADDITIONAL NOTES: include any clinically relevant information not captured in the sections above (e.g., patient/caregiver concerns, social factors, pending items). If none, write "No documentado".

Return a JSON object with exactly these keys:
{
  "medicamentos": string[],
  "rosDetails": {
    "General": string,
    "HEENT": string,
    "Cardiovascular": string,
    "Pulmonary": string,
    "Gastrointestinal": string,
    "Genitourinary": string,
    "Mental Health": string,
    "Neurological": string,
    "Musculoskeletal": string,
    "Skin": string
  },
  "assessmentAndPlan": string,
  "justificacionCodigoVisita": string,
  "referidosCaseManagement": string,
  "additionalNotes": string
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
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
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

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
  process.exit(1);
});
