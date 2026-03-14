// functions/src/config.js

exports.functionConfig = {
  region: "asia-south1",
  
  // Directly provide your whitelist as an array of strings.
  // Make sure there are NO trailing slashes at the end of the URLs!
  cors: [
    "http://localhost:5173", // Your local Vite development server
    "https://skill-pilot-coral.vercel.app"
  ],
};