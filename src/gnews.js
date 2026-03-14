// functions/src/gnews.js
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { functionConfig } = require("./config");

exports.fetchNewsHandler = onCall(functionConfig, async (request) => {
  const { query, category, pageNum } = request.data || {};
  const apiKey = process.env.GNEWS_API_KEY;

  if (!apiKey) {
    throw new HttpsError("internal", "GNews API key is missing on the server.");
  }

  let url;
  if (query && category !== "technology") {
    url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&lang=en&max=9&page=${pageNum || 1}&token=${apiKey}`;
  } else if (query) {
    url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&lang=en&max=9&page=${pageNum || 1}&token=${apiKey}`;
  } else {
    url = `https://gnews.io/api/v4/top-headlines?category=${category || "technology"}&lang=en&max=9&page=${pageNum || 1}&token=${apiKey}`;
  }

  try {
    const response = await fetch(url);
    const raw = await response.text();

    console.log("GNews upstream status:", response.status);
    console.log("GNews upstream body:", raw);

    if (!response.ok) {
      throw new HttpsError("internal", "Failed to fetch news", `GNews API error ${response.status}: ${raw}`);
    }

    return JSON.parse(raw);
  } catch (error) {
    console.error("fetchNewsHandler error:", error);
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", "Failed to fetch news", error.message);
  }
});
