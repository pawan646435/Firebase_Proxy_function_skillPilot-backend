const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { functionConfig } = require("./config");
const admin = require("firebase-admin");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

const SUPPORTED_LANGUAGES = new Set(["javascript", "python"]);
const MAX_CODE_SIZE = 20000;
const RUN_TIMEOUT_MS = 6000;

function assertAuthenticated(request) {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "You must be logged in.");
  }
  return request.auth.uid;
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeInput(rawInput) {
  const parsed = parseMaybeJson(rawInput);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function normalizeExpected(rawExpected) {
  const parsed = parseMaybeJson(rawExpected);
  if (typeof parsed === "string") return parsed.trim();
  return parsed;
}

async function runProcess(command, args, inputEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...inputEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let killedByTimeout = false;

    const timeout = setTimeout(() => {
      killedByTimeout = true;
      child.kill("SIGKILL");
    }, RUN_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, code, killedByTimeout });
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr: `${stderr}\n${error.message}`.trim(), code: 1, killedByTimeout });
    });
  });
}

async function executeJavaScript(code, testInput) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clash-js-"));
  const runnerPath = path.join(tempDir, "runner.js");

  const runnerCode = `"use strict";
${code}
(async () => {
  if (typeof solution !== "function") {
    throw new Error("Define a function named solution");
  }
  const parsedInput = JSON.parse(process.env.CLASH_INPUT_JSON || "[]");
  const args = Array.isArray(parsedInput) ? parsedInput : [parsedInput];
  const output = await solution(...args);
  process.stdout.write(JSON.stringify({ output }));
})().catch((err) => {
  process.stderr.write(err?.stack || err?.message || String(err));
  process.exit(1);
});`;

  try {
    await fs.writeFile(runnerPath, runnerCode, "utf8");
    const result = await runProcess("node", [runnerPath], {
      CLASH_INPUT_JSON: JSON.stringify(testInput),
    });
    return result;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function executePython(code, testInput) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clash-py-"));
  const runnerPath = path.join(tempDir, "runner.py");

  const runnerCode = `${code}
import json
import os
import traceback

try:
    if "solution" not in globals() or not callable(solution):
        raise Exception("Define a function named solution")

    parsed_input = json.loads(os.environ.get("CLASH_INPUT_JSON", "[]"))
    if not isinstance(parsed_input, list):
        parsed_input = [parsed_input]
    output = solution(*parsed_input)
    print(json.dumps({"output": output}), end="")
except Exception:
    traceback.print_exc()
    raise
`;

  try {
    await fs.writeFile(runnerPath, runnerCode, "utf8");
    const result = await runProcess("python3", [runnerPath], {
      CLASH_INPUT_JSON: JSON.stringify(testInput),
    });
    return result;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function executeCode({ language, code, input }) {
  if (language === "javascript") {
    return executeJavaScript(code, input);
  }
  if (language === "python") {
    return executePython(code, input);
  }

  throw new HttpsError("invalid-argument", `Unsupported language: ${language}`);
}

function compareOutputs(actual, expected) {
  if (typeof actual === "string" && typeof expected === "string") {
    return actual.trim() === expected.trim();
  }
  return JSON.stringify(actual) === JSON.stringify(expected);
}

async function loadQuestion(questionId) {
  const questionSnap = await db.collection("clashQuestions").doc(questionId).get();
  if (!questionSnap.exists) {
    throw new HttpsError("not-found", "Question not found.");
  }

  const question = questionSnap.data();
  if (!Array.isArray(question.testCases) || question.testCases.length === 0) {
    throw new HttpsError("failed-precondition", "Question has no test cases.");
  }

  return question;
}

async function assertRoomMembership(roomId, uid) {
  const roomRef = db.collection("battles").doc(roomId);
  const roomSnap = await roomRef.get();
  if (!roomSnap.exists) {
    throw new HttpsError("not-found", "Room not found.");
  }

  const room = roomSnap.data();
  const isPlayer1 = room?.player1?.uid === uid;
  const isPlayer2 = room?.player2?.uid === uid;
  if (!isPlayer1 && !isPlayer2) {
    throw new HttpsError("permission-denied", "You are not part of this room.");
  }

  return { roomRef, room };
}

async function evaluateSubmission({ language, code, question }) {
  const testCases = question.testCases;
  const startedAt = Date.now();

  const cases = [];
  let passed = 0;

  for (let i = 0; i < testCases.length; i += 1) {
    const testCase = testCases[i];
    const normalizedInput = normalizeInput(testCase.input);
    const expected = normalizeExpected(testCase.expected);
    const execResult = await executeCode({ language, code, input: normalizedInput });

    if (execResult.killedByTimeout) {
      cases.push({
        index: i,
        passed: false,
        error: "Execution timeout",
        hidden: Boolean(testCase.isHidden),
      });
      continue;
    }

    if (execResult.code !== 0) {
      cases.push({
        index: i,
        passed: false,
        error: execResult.stderr?.slice(0, 700) || "Runtime error",
        hidden: Boolean(testCase.isHidden),
      });
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(execResult.stdout || "{}");
    } catch {
      parsed = { output: execResult.stdout?.trim() ?? "" };
    }

    const didPass = compareOutputs(parsed.output, expected);
    if (didPass) passed += 1;

    cases.push({
      index: i,
      passed: didPass,
      hidden: Boolean(testCase.isHidden),
      output: Boolean(testCase.isHidden) ? undefined : parsed.output,
      expected: Boolean(testCase.isHidden) ? undefined : expected,
    });
  }

  const elapsedMs = Date.now() - startedAt;
  const speedBonus = Math.max(0, 2500 - elapsedMs);
  const points = passed * 100 + Math.floor(speedBonus / 25);

  return {
    passed,
    total: testCases.length,
    elapsedMs,
    points,
    cases,
  };
}

exports.runClashCodeHandler = onCall(functionConfig, async (request) => {
  const uid = assertAuthenticated(request);
  const { roomId, questionId, code, language = "javascript" } = request.data || {};

  if (!roomId || !questionId || !code) {
    throw new HttpsError("invalid-argument", "roomId, questionId, and code are required.");
  }
  if (!SUPPORTED_LANGUAGES.has(language)) {
    throw new HttpsError("invalid-argument", "Unsupported language.");
  }
  if (typeof code !== "string" || code.length > MAX_CODE_SIZE) {
    throw new HttpsError("invalid-argument", "Code is too large or invalid.");
  }

  await assertRoomMembership(roomId, uid);
  const question = await loadQuestion(questionId);
  const result = await evaluateSubmission({ language, code, question });

  return {
    success: true,
    mode: "run",
    result,
  };
});

exports.submitClashAnswerHandler = onCall(functionConfig, async (request) => {
  const uid = assertAuthenticated(request);
  const { roomId, questionId, code, language = "javascript" } = request.data || {};

  if (!roomId || !questionId || !code) {
    throw new HttpsError("invalid-argument", "roomId, questionId, and code are required.");
  }
  if (!SUPPORTED_LANGUAGES.has(language)) {
    throw new HttpsError("invalid-argument", "Unsupported language.");
  }
  if (typeof code !== "string" || code.length > MAX_CODE_SIZE) {
    throw new HttpsError("invalid-argument", "Code is too large or invalid.");
  }

  const { roomRef } = await assertRoomMembership(roomId, uid);
  const question = await loadQuestion(questionId);
  const result = await evaluateSubmission({ language, code, question });

  const updatePayload = {
    [`submissions.${uid}.${questionId}`]: {
      code,
      language,
      passed: result.passed,
      total: result.total,
      elapsedMs: result.elapsedMs,
      points: result.points,
      submittedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    [`scores.${uid}`]: admin.firestore.FieldValue.increment(result.points),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await roomRef.set(updatePayload, { merge: true });

  return {
    success: true,
    mode: "submit",
    result,
  };
});

exports.finalizeClashMatchHandler = onCall(functionConfig, async (request) => {
  const uid = assertAuthenticated(request);
  const { roomId } = request.data || {};

  if (!roomId) {
    throw new HttpsError("invalid-argument", "roomId is required.");
  }

  const { roomRef, room } = await assertRoomMembership(roomId, uid);

  const player1Uid = room?.player1?.uid;
  const player2Uid = room?.player2?.uid;

  if (!player1Uid || !player2Uid) {
    throw new HttpsError("failed-precondition", "Both players must be present to finalize.");
  }

  const p1Score = Number(room?.scores?.[player1Uid] || 0);
  const p2Score = Number(room?.scores?.[player2Uid] || 0);

  let winnerUid = null;
  if (p1Score > p2Score) winnerUid = player1Uid;
  if (p2Score > p1Score) winnerUid = player2Uid;

  await roomRef.set(
    {
      status: "FINISHED",
      result: {
        winnerUid,
        player1Score: p1Score,
        player2Score: p2Score,
        finalizedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return {
    success: true,
    winnerUid,
    player1Score: p1Score,
    player2Score: p2Score,
  };
});
