import "dotenv/config";
import express from "express";
import multer from "multer";
import OpenAI from "openai";
import puppeteer from "puppeteer";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.OPENAI_MODEL || "gpt-5.6";
const GUIDE_PATH = path.join(__dirname, "guide", "해설제작가이드.md");
const DATA_DIR = path.join(__dirname, "data");

if (!process.env.OPENAI_API_KEY) {
  console.warn("[주의] OPENAI_API_KEY가 없습니다. .env 파일에 키를 입력하세요.");
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set(["image/jpeg", "image/png"]);
    if (!allowed.has(file.mimetype)) {
      return cb(new Error("JPG, JPEG 또는 PNG 파일만 첨부할 수 있습니다."));
    }
    cb(null, true);
  }
});

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const explanationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    topic: { type: "string" },
    problem: {
      type: "object",
      additionalProperties: false,
      properties: {
        number: { type: "string" },
        prompt: { type: "string" },
        passage: { type: "string" },
        choices: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              label: { type: "string" },
              text: { type: "string" }
            },
            required: ["label", "text"]
          }
        },
        footnotes: { type: "array", items: { type: "string" } }
      },
      required: ["number", "prompt", "passage", "choices", "footnotes"]
    },
    answer: {
      type: "object",
      additionalProperties: false,
      properties: {
        number: { type: "string" },
        choice: { type: "string" },
        explanation: { type: "string" },
        distractors: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              label: { type: "string" },
              reason: { type: "string" }
            },
            required: ["label", "reason"]
          }
        }
      },
      required: ["number", "choice", "explanation", "distractors"]
    },
    step0: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          number: { type: "integer" },
          sentence: { type: "string" }
        },
        required: ["number", "sentence"]
      }
    },
    step1: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          number: { type: "integer" },
          direct_en: { type: "string" },
          direct_ko: { type: "string" },
          original_en: { type: "string" },
          natural_ko: { type: "string" }
        },
        required: ["number", "direct_en", "direct_ko", "original_en", "natural_ko"]
      }
    },
    key_patterns: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          sentence_number: { type: "integer" },
          pattern: { type: "string" },
          meaning: { type: "string" },
          examples: {
            type: "array",
            minItems: 2,
            maxItems: 2,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                en: { type: "string" },
                ko: { type: "string" }
              },
              required: ["en", "ko"]
            }
          }
        },
        required: ["sentence_number", "pattern", "meaning", "examples"]
      }
    },
    logic: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          order: { type: "integer" },
          title: { type: "string" },
          description: { type: "string" }
        },
        required: ["order", "title", "description"]
      }
    },
    logic_note: { type: "string" },
    step2: { type: "string" },
    summary: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: { type: "string" }
    },
    answer_point: { type: "string" }
  },
  required: [
    "topic", "problem", "answer", "step0", "step1", "key_patterns",
    "logic", "logic_note", "step2", "summary", "answer_point"
  ]
};

const revisionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["ok", "ambiguous"] },
    message: { type: "string" },
    patches: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          replacement: { type: "string" }
        },
        required: ["path", "replacement"]
      }
    }
  },
  required: ["status", "message", "patches"]
};

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function nl2br(value = "") {
  return escapeHtml(value).replace(/\n/g, "<br>");
}

function sanitizeTopic(topic) {
  const cleaned = String(topic || "영어지문")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 50);
  return cleaned || "영어지문";
}

function sectionTitle(text) {
  return `<h2 class="section-title">${escapeHtml(text)}</h2>`;
}

function renderDocumentHtml(doc) {
  const answerRows = doc.answer.distractors
    .map(d => `<p class="explanation"><strong>${escapeHtml(d.label)}</strong> ${nl2br(d.reason)}</p>`)
    .join("");

  const step0 = doc.step0.map(item => `
    <div class="step0-item">
      <span class="step0-number">${item.number}.</span>
      <div class="step0-text">${escapeHtml(item.sentence)}</div>
    </div>`).join("");

  const step1 = doc.step1.map(item => `
    <div class="sentence-block">
      <span class="sentence-number">${item.number}.</span>
      <p class="direct-en">${escapeHtml(item.direct_en)}</p>
      <p class="direct-ko">${escapeHtml(item.direct_ko)}</p>
      <p class="original-en">${escapeHtml(item.original_en)}</p>
      <p class="natural-ko">${escapeHtml(item.natural_ko)}</p>
    </div>`).join("");

  const patterns = doc.key_patterns.map((item, index) => {
    const examples = item.examples.map((ex, i) => `
      <p class="example-en">Example ${i + 1}. ${escapeHtml(ex.en)}</p>
      <p class="example-ko">→ ${escapeHtml(ex.ko)}</p>`).join("");
    return `<div class="pattern-block">
      <p><strong>(${item.sentence_number}) - ${escapeHtml(item.pattern)}</strong> : ${escapeHtml(item.meaning)}</p>
      ${examples}
    </div>`;
  }).join("");

  const logic = doc.logic.map((item, i) => `
    <div class="logic-block">
      <p class="logic-title">${circled(item.order)} ${escapeHtml(item.title)}</p>
      <p>${nl2br(item.description)}</p>
    </div>
    ${i < doc.logic.length - 1 ? '<div class="logic-arrow">↓</div>' : ''}`
  ).join("");

  const summary = doc.summary.map(line => `<p class="summary-line">${escapeHtml(line)}</p>`).join("");

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<style>
  @page { size: A3 portrait; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Times New Roman", "Batang", "Noto Serif CJK KR", serif;
    font-size: 10.5pt;
    line-height: 1.32;
    color: #111;
    background: #fff;
  }
  .exam-body { column-count: 2; column-gap: 8mm; column-rule: 0.4pt solid #222; }
  .section-title {
    font-family: "Batang", "Noto Serif CJK KR", serif;
    font-size: 12pt; font-weight: 700;
    margin: 5mm 0 3mm 0; padding: 0;
    break-after: avoid;
  }
  .section-title:first-child { margin-top: 0; }
  p { margin: 0 0 1.8mm 0; }
  .explanation, .direct-ko, .natural-ko, .example-ko, .logic-block, .summary-line {
    font-family: "Batang", "Noto Serif CJK KR", serif;
  }
  .answer-choice { font-weight: 700; }
  .step0-item {
    position: relative; margin: 0 0 3.5mm 0; padding-left: 8.5mm;
    break-inside: avoid;
  }
  .step0-number {
    position: absolute; left: 0; top: 0; width: 6mm;
    font-family: "Times New Roman", serif; font-size: 10.5pt; font-weight: 700;
  }
  .step0-text { font-family: "Times New Roman", serif; font-size: 10.5pt; text-align: justify; }
  .sentence-block {
    position: relative; break-inside: avoid;
    margin: 0 0 5mm 0; padding: 0 0 0 8.5mm;
  }
  .sentence-number {
    position: absolute; left: 0; top: 0; width: 6mm;
    font-family: "Times New Roman", serif; font-size: 10.8pt; font-weight: 700; line-height: 1.32;
  }
  .direct-en {
    margin: 0 0 1.8mm 0; font-family: "Times New Roman", serif;
    font-size: 10.5pt; font-weight: 700; line-height: 1.32; text-align: justify;
  }
  .direct-ko, .natural-ko { font-size: 10.2pt; line-height: 1.34; text-align: justify; }
  .original-en, .example-en { font-family: "Times New Roman", serif; font-size: 10.3pt; line-height: 1.30; text-align: justify; }
  .pattern-block { break-inside: avoid; margin-bottom: 4.5mm; }
  .example-en { margin-top: 1.5mm; margin-bottom: 0.8mm; }
  .example-ko { margin-bottom: 1.5mm; }
  .logic-block { break-inside: avoid; }
  .logic-title { font-weight: 700; margin-bottom: 1mm; }
  .logic-arrow { text-align: center; margin: 1.5mm 0; font-size: 12pt; }
  .logic-note { margin-top: 4mm; }
  .step2 { font-family: "Times New Roman", serif; text-align: justify; }
  .summary-group { break-inside: avoid; }
  .summary-line { margin-bottom: 1.5mm; }
  .answer-point { font-weight: 700; break-inside: avoid; }
</style>
</head>
<body>
  <main class="exam-body">
    ${sectionTitle("[정답 및 문제 풀이]")}
    <p class="answer-choice">정답은 ${escapeHtml(doc.answer.number)}이다.${doc.answer.choice ? ` ${escapeHtml(doc.answer.choice)}` : ""}</p>
    <div class="explanation">${nl2br(doc.answer.explanation)}</div>
    ${answerRows}

    ${sectionTitle("[직독직해 연습하기 STEP0]")}
    <p class="explanation">직접 끊어읽어보자.</p>
    ${step0}

    ${sectionTitle("[직독직해 연습하기 STEP1]")}
    ${step1}

    ${sectionTitle("[핵심 구문]")}
    ${patterns || '<p class="explanation">별도의 핵심 구문 없음.</p>'}

    ${sectionTitle("[글 전체 논리 구조]")}
    ${logic}
    ${doc.logic_note ? `<p class="logic-note">${nl2br(doc.logic_note)}</p>` : ""}

    ${sectionTitle("[직독직해 연습하기 STEP2]")}
    <p class="step2">${escapeHtml(doc.step2)}</p>

    ${sectionTitle("[전체 내용 세 줄 정리]")}
    <div class="summary-group">${summary}</div>

    ${sectionTitle("[한 줄로 정리하는 정답 포인트]")}
    <p class="answer-point">${escapeHtml(doc.answer_point)}</p>
  </main>
</body>
</html>`;
}

function circled(n) {
  const map = ["", "①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];
  return map[n] || `${n}.`;
}

async function makePdf(doc) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  try {
    const page = await browser.newPage();
    await page.setContent(renderDocumentHtml(doc), { waitUntil: "networkidle0" });

    const headerTemplate = `
      <div style="width:100%; padding:0 31mm; font-size:10px; color:#111; box-sizing:border-box;">
        <div style="display:grid; grid-template-columns:1fr 1fr 1fr; align-items:center; border-bottom:0.7pt solid #222; padding-bottom:3mm;">
          <div style="font-family:'Times New Roman',serif; font-size:24px;"><span class="pageNumber"></span></div>
          <div style="text-align:center; font-family:Arial,sans-serif; font-size:24px; font-weight:800;">영어 영역</div>
          <div style="text-align:right;"><span style="display:inline-block; border:0.7pt solid #111; padding:1.5mm 3mm; font-family:Arial,sans-serif; font-size:14px; font-weight:700;">해설지</span></div>
        </div>
      </div>`;

    const footerTemplate = `
      <div style="width:100%; padding:0 31mm; font-size:10px; color:#111; box-sizing:border-box; text-align:center;">
        <span class="pageNumber"></span> / <span class="totalPages"></span>
      </div>`;

    const pdf = await page.pdf({
      width: "297mm",
      height: "420mm",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate,
      footerTemplate,
      margin: { top: "30mm", bottom: "22mm", left: "31mm", right: "31mm" }
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

async function readGuide() {
  return fs.readFile(GUIDE_PATH, "utf8");
}

function generationInstruction(guide) {
  return `너는 대한민국 수능형 영어 직독직해 해설지 제작기다.\n\n아래 제작 가이드는 최우선 규칙이다. 가이드에 없는 내용을 임의로 추가하지 말고, 가이드의 순서/문체/직독직해/정답 풀이 규칙을 정확히 적용하라.\n\n=== 제작 가이드 시작 ===\n${guide}\n=== 제작 가이드 끝 ===\n\n출력은 지정된 JSON Schema에만 맞춰 작성한다. PDF 디자인은 서버가 가이드에 맞춰 렌더링하므로, JSON에는 콘텐츠만 정확히 담는다.\n\n추가 규칙:\n- 입력은 영어 문제 1개이다.\n- 사진이면 문제번호, 발문, 지문, 선지, 각주를 시각적으로 정확히 읽는다.\n- 원문은 임의로 고치거나 축약하지 않는다.\n- 문제 유형과 정답을 스스로 판단한다.\n- topic은 파일명에 쓸 수 있는 짧은 한국어 명사구로 작성한다.\n- summary는 정확히 3개 문장이다.\n- STEP0/STEP1은 마지막 문장까지 빠짐없이 작성한다.\n- 문서 내부 해설은 -다/-이다체로 작성한다.`;
}

async function generateWithOpenAI({ inputMode, problemText, image }) {
  const guide = await readGuide();
  const userContent = [];

  if (inputMode === "photo") {
    const dataUrl = `data:${image.mimetype};base64,${image.buffer.toString("base64")}`;
    userContent.push({
      type: "input_text",
      text: "첨부 이미지에 있는 영어 문제 1개를 정확히 읽고 제작 가이드에 따라 해설 콘텐츠를 생성하라."
    });
    userContent.push({ type: "input_image", image_url: dataUrl, detail: "high" });
  } else {
    userContent.push({
      type: "input_text",
      text: `다음 텍스트 전체를 영어 문제 1개로 간주하고 제작 가이드에 따라 해설 콘텐츠를 생성하라.\n\n${problemText}`
    });
  }

  const response = await openai.responses.create({
    model: MODEL,
    store: false,
    max_output_tokens: 30000,
    input: [
      { role: "developer", content: [{ type: "input_text", text: generationInstruction(guide) }] },
      { role: "user", content: userContent }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "english_explanation_document",
        description: "수능형 영어 직독직해 해설지의 구조화 콘텐츠",
        strict: true,
        schema: explanationSchema
      }
    }
  });

  if (!response.output_text) throw new Error("모델 응답이 비어 있습니다.");
  return JSON.parse(response.output_text);
}

async function saveDocument(id, doc) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(
    path.join(DATA_DIR, `${id}.json`),
    JSON.stringify({ id, updatedAt: new Date().toISOString(), document: doc }, null, 2),
    "utf8"
  );
}

async function loadDocument(id) {
  const raw = await fs.readFile(path.join(DATA_DIR, `${id}.json`), "utf8");
  return JSON.parse(raw).document;
}

function parsePath(pathString) {
  const tokens = [];
  const regex = /([^[.\]]+)|\[(\d+)\]/g;
  let match;
  while ((match = regex.exec(pathString))) {
    tokens.push(match[1] ?? Number(match[2]));
  }
  return tokens;
}

function getAtPath(obj, pathString) {
  return parsePath(pathString).reduce((acc, key) => acc?.[key], obj);
}

function setAtPath(obj, pathString, value) {
  const tokens = parsePath(pathString);
  let cursor = obj;
  for (let i = 0; i < tokens.length - 1; i++) {
    cursor = cursor[tokens[i]];
    if (cursor == null) throw new Error("잘못된 수정 경로입니다.");
  }
  cursor[tokens.at(-1)] = value;
}

const ALLOWED_PATCH_PATHS = [
  /^topic$/,
  /^answer\.(number|choice|explanation)$/,
  /^answer\.distractors\[\d+\]\.(label|reason)$/,
  /^step0\[\d+\]\.sentence$/,
  /^step1\[\d+\]\.(direct_en|direct_ko|original_en|natural_ko)$/,
  /^key_patterns\[\d+\]\.(pattern|meaning)$/,
  /^key_patterns\[\d+\]\.examples\[\d+\]\.(en|ko)$/,
  /^logic\[\d+\]\.(title|description)$/,
  /^logic_note$/,
  /^step2$/,
  /^summary\[\d+\]$/,
  /^answer_point$/
];

function isAllowedPatchPath(p) {
  return ALLOWED_PATCH_PATHS.some(re => re.test(p));
}

function flattenStringLeaves(value, prefix = "", out = new Map()) {
  if (typeof value === "string") {
    out.set(prefix, value);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => flattenStringLeaves(v, `${prefix}[${i}]`, out));
    return out;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      flattenStringLeaves(v, prefix ? `${prefix}.${k}` : k, out);
    }
  }
  return out;
}

function changedStringPaths(before, after) {
  const a = flattenStringLeaves(before);
  const b = flattenStringLeaves(after);
  const keys = new Set([...a.keys(), ...b.keys()]);
  return [...keys].filter(k => a.get(k) !== b.get(k));
}

async function planRevision(document, requestText) {
  const guide = await readGuide();
  const instruction = `현재 문서는 확정된 기준본이다. 사용자가 요청한 범위 밖의 내용은 절대 변경하면 안 된다.\n\n너의 역할은 문서를 다시 작성하는 것이 아니라, 사용자의 수정 요청에 해당하는 '문자열 leaf 필드' 경로와 교체 문자열만 제안하는 것이다.\n\n허용 경로 예시:\n- answer.explanation\n- step1[2].natural_ko\n- step1[4].direct_en\n- key_patterns[0].meaning\n- key_patterns[1].examples[0].ko\n- logic[2].description\n- summary[1]\n- answer_point\n\n배열 인덱스는 0부터 시작한다. 사용자가 말하는 '3번 문장'은 일반적으로 step1에서 number=3인 항목을 찾아 그 실제 배열 인덱스를 사용해야 한다.\n수정 대상을 확실히 특정할 수 없으면 status를 ambiguous로 하고 patches를 빈 배열로 반환한다.\n요청하지 않은 표현 개선, 맞춤법 교정, 문체 통일, 다른 문장 수정은 금지한다.\n\n제작 가이드 참고:\n${guide}\n\n기준 문서 JSON:\n${JSON.stringify(document)}\n\n사용자 수정 요청:\n${requestText}`;

  const response = await openai.responses.create({
    model: MODEL,
    store: false,
    max_output_tokens: 8000,
    input: instruction,
    text: {
      format: {
        type: "json_schema",
        name: "revision_patch_plan",
        description: "기준 문서에서 허용된 문자열 필드만 수정하기 위한 패치 계획",
        strict: true,
        schema: revisionSchema
      }
    }
  });
  if (!response.output_text) throw new Error("수정 계획 응답이 비어 있습니다.");
  return JSON.parse(response.output_text);
}

function applyVerifiedPatches(document, plan) {
  if (plan.status !== "ok" || !plan.patches.length) {
    const err = new Error(plan.message || "수정 대상을 특정할 수 없습니다.");
    err.statusCode = 422;
    throw err;
  }

  const before = structuredClone(document);
  const after = structuredClone(document);
  const allowedChanged = new Set();

  for (const patch of plan.patches) {
    if (!isAllowedPatchPath(patch.path)) {
      throw new Error(`허용되지 않은 수정 경로: ${patch.path}`);
    }
    const oldValue = getAtPath(after, patch.path);
    if (typeof oldValue !== "string") {
      throw new Error(`문자열 필드만 수정할 수 있습니다: ${patch.path}`);
    }
    setAtPath(after, patch.path, patch.replacement);
    allowedChanged.add(patch.path);
  }

  const actualChanges = changedStringPaths(before, after);
  const outsideChanges = actualChanges.filter(p => !allowedChanged.has(p));
  if (outsideChanges.length) {
    throw new Error(`요청 범위 밖 변경 감지: ${outsideChanges.join(", ")}`);
  }
  return after;
}

function sendPdf(res, pdf, documentId, topic) {
  const safeTopic = sanitizeTopic(topic);
  const filename = `${safeTopic}_해설.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Length", pdf.length);
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader("X-Document-Id", documentId);
  res.setHeader("X-Document-Topic", encodeURIComponent(safeTopic));
  res.send(pdf);
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, model: MODEL, apiKeyConfigured: Boolean(process.env.OPENAI_API_KEY) });
});

app.post("/api/generate-explanation", upload.single("problemImage"), async (req, res, next) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ message: "OPENAI_API_KEY가 설정되지 않았습니다." });
    }

    const inputMode = req.body.inputMode;
    if (!['photo', 'text'].includes(inputMode)) {
      return res.status(400).json({ message: "입력 방식이 올바르지 않습니다." });
    }
    if (inputMode === "photo" && !req.file) {
      return res.status(400).json({ message: "문제 이미지가 없습니다." });
    }
    if (inputMode === "text" && !String(req.body.problemText || "").trim()) {
      return res.status(400).json({ message: "문제 텍스트가 없습니다." });
    }

    const document = await generateWithOpenAI({
      inputMode,
      problemText: String(req.body.problemText || "").trim(),
      image: req.file
    });

    const id = randomUUID();
    await saveDocument(id, document);
    const pdf = await makePdf(document);
    sendPdf(res, pdf, id, document.topic);
  } catch (error) {
    next(error);
  }
});

app.post("/api/revise-explanation", async (req, res, next) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ message: "OPENAI_API_KEY가 설정되지 않았습니다." });
    }
    const documentId = String(req.body.documentId || "");
    const revisionRequest = String(req.body.revisionRequest || "").trim();
    if (!documentId || !revisionRequest) {
      return res.status(400).json({ message: "수정할 문서 또는 수정 요청이 없습니다." });
    }

    let current;
    try {
      current = await loadDocument(documentId);
    } catch {
      return res.status(404).json({ message: "기준 문서를 찾을 수 없습니다. 새로운 해설을 제작해주세요." });
    }

    const plan = await planRevision(current, revisionRequest);
    const revised = applyVerifiedPatches(current, plan);
    await saveDocument(documentId, revised);
    const pdf = await makePdf(revised);
    sendPdf(res, pdf, documentId, revised.topic);
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  const status = error.statusCode || 500;
  res.status(status).json({
    message: status === 500 ? "다시 시도해주세요." : (error.message || "다시 시도해주세요.")
  });
});

app.listen(PORT, () => {
  console.log(`영어지문 파헤치기: http://localhost:${PORT}`);
  console.log(`OpenAI model: ${MODEL}`);
});
