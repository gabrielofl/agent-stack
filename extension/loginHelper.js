// loginHelper.js
export async function performSiteLogin(tabId, loginConfig) {
  if (!loginConfig?.enabled) return { ok: true, skipped: true };

  const {
    url,
    usernameSelector,
    passwordSelector,
    submitSelector,
    username,
    password,
    waitAfterLoginMs = 3000
  } = loginConfig;

  if (!url || !usernameSelector || !passwordSelector || !submitSelector) {
    throw new Error("Login config incomplete: url/selectors are required");
  }
  if (!username || !password) {
    throw new Error("Login config incomplete: username/password are required");
  }

  // Navigate tab to login page
  await chrome.tabs.update(tabId, { url });

  // Wait for page load
  await new Promise((r) => setTimeout(r, 2500));

  // Inject values + submit
  await chrome.scripting.executeScript({
    target: { tabId },
    func: ({ usernameSelector, passwordSelector, submitSelector, username, password }) => {
      const u = document.querySelector(usernameSelector);
      const p = document.querySelector(passwordSelector);
      const s = document.querySelector(submitSelector);

      if (!u) throw new Error("Username field not found");
      if (!p) throw new Error("Password field not found");
      if (!s) throw new Error("Submit button not found");

      u.focus();
      u.value = username;
      u.dispatchEvent(new Event("input", { bubbles: true }));
      u.dispatchEvent(new Event("change", { bubbles: true }));

      p.focus();
      p.value = password;
      p.dispatchEvent(new Event("input", { bubbles: true }));
      p.dispatchEvent(new Event("change", { bubbles: true }));

      s.click();
    },
    args: [{ usernameSelector, passwordSelector, submitSelector, username, password }]
  });

  await new Promise((r) => setTimeout(r, waitAfterLoginMs));

  return { ok: true };
}