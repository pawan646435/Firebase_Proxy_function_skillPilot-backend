// functions/index.js

const gnewsService = require("./src/gnews");
const groqService = require("./src/groq");
const clashService = require("./src/clash");

// Export them with the names the frontend expects to call
exports.fetchNews = gnewsService.fetchNewsHandler;
exports.fetchGroqChat = groqService.fetchGroqChatHandler;
exports.runClashCode = clashService.runClashCodeHandler;
exports.submitClashAnswer = clashService.submitClashAnswerHandler;
exports.finalizeClashMatch = clashService.finalizeClashMatchHandler;