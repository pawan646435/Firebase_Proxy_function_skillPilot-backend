// functions/index.js

const gnewsService = require("./src/gnews");
const groqService = require("./src/groq");

// Export them with the names the frontend expects to call
exports.fetchNews = gnewsService.fetchNewsHandler;
exports.fetchGroqChat = groqService.fetchGroqChatHandler;