// functions/src/groq.js
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { functionConfig } = require("./config");

exports.fetchGroqChatHandler = onCall(functionConfig, async (request) => {
  const { messages } = request.data || {};
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    throw new HttpsError("internal", "Groq API key is missing on the server.");
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new HttpsError("invalid-argument", "messages must be a non-empty array.");
  }

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages,
        temperature: 0.7,
        max_tokens: 1024,
      }),
    });

    const raw = await response.text();

    console.log("Groq upstream status:", response.status);
    console.log("Groq upstream body:", raw);

    if (!response.ok) {
      throw new HttpsError(
        "internal",
        "Failed to fetch from Groq",
        `Groq API error ${response.status}: ${raw}`
      );
    }

    return JSON.parse(raw);
  } catch (error) {
    console.error("fetchGroqChatHandler error:", error);
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", "Failed to fetch from Groq", error.message);
  }
});
