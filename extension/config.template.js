// config.template.js
// Copy this file to `config.js` and fill in your values.

export const EXT_CONFIG = {
  // =========================
  // GOOGLE / DRIVE SETTINGS
  // =========================
  google: {
    // NOTE: oauth2.client_id must ALSO be set in manifest.json
    // This is repeated here for display/help only.
    clientId: "YOUR_CHROME_EXTENSION_OAUTH_CLIENT_ID.apps.googleusercontent.com",

    // Recommended minimal scope for uploads created by this extension
    scopes: ["https://www.googleapis.com/auth/drive.file"],

    // Optional parent folder in Drive (leave blank for My Drive root)
    parentFolderId: "",

    // Dated folder naming (example: "Site Images 2026-02-24")
    folderPrefix: "Site Images"
  },

  // =========================
  // SITE SETTINGS
  // =========================
  site: {
    // Used for user guidance only (manifest still controls access)
    name: "My Site",

    // Default selectors
    imageSelector: "img",
    nextSelector: "",

    // Pagination defaults
    maxPages: 1,
    pageWaitMs: 2500
  },

  // =========================
  // IMAGE FILTERS
  // =========================
  filters: {
    minWidth: 64,
    minHeight: 64,
    minBytes: 10 * 1024, // 10 KB
    allowedTypes: ["image/jpeg", "image/png", "image/webp"]
  },

  // =========================
  // DUPLICATE HANDLING
  // =========================
  duplicates: {
    // "origin" = separate hash list per website origin
    // "global" = one hash list for all sites
    scope: "origin",
    maxHashesStored: 5000
  },

  // =========================
  // OPTIONAL LOGIN AUTOMATION
  // =========================
  login: {
    enabled: false,

    // URL to visit before scraping (if login is required)
    url: "https://example.com/login",

    // Selectors for login form
    usernameSelector: "input[name='email']",
    passwordSelector: "input[name='password']",
    submitSelector: "button[type='submit']",

    // Credentials for the user's own site account
    // NOTE: This is stored locally in the extension if you save it.
    username: "",
    password: "",

    // Wait after submit
    waitAfterLoginMs: 3000
  },
  auth: {
    apiBase: "https://YOUR-AZURE-APP.azurewebsites.net"
  }
};
