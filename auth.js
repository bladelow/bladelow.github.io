/* Shared account helpers (Supabase). config.js me supabaseUrl + supabaseAnonKey chahiye. */
var _sb = null;
function getSb() {
  if (_sb) return _sb;
  if (typeof SITE === "undefined" || !SITE.supabaseUrl || !window.supabase) return null;
  _sb = window.supabase.createClient(SITE.supabaseUrl, SITE.supabaseAnonKey);
  return _sb;
}
async function loadRemoteConfig() {
  if (typeof SITE === "undefined" || !SITE.supabaseUrl) return;
  try {
    const r = await fetch(SITE.supabaseUrl + "/rest/v1/site_config?id=eq.1&select=data", { headers: { apikey: SITE.supabaseAnonKey } });
    const j = await r.json();
    if (j[0] && j[0].data) Object.assign(SITE, j[0].data, { supabaseUrl: SITE.supabaseUrl, supabaseAnonKey: SITE.supabaseAnonKey });
  } catch (e) {}
}
async function me() {
  const s = getSb(); if (!s) return null;
  const { data: { session } } = await s.auth.getSession();
  if (!session) return null;
  const { data } = await s.from("profiles").select("*").eq("id", session.user.id).single();
  return data;
}
function loginDiscord() {
  getSb().auth.signInWithOAuth({ provider: "discord", options: { redirectTo: location.origin + location.pathname.replace(/[^/]*$/, "") + "login.html" } });
}
async function logout() { await getSb().auth.signOut(); location.href = "index.html"; }
async function fillAcct() {
  const a = document.getElementById("acct"); if (!a) return;
  const u = await me(); a.textContent = u ? u.username : "Login";
}
async function requireAdmin() {
  const p = document.getElementById("panel");
  const u = await me();
  if (!getSb()) { p.textContent = "config.js me supabaseUrl aur supabaseAnonKey daal."; return false; }
  if (!u) { p.innerHTML = '<p>Log in first to access the admin section.</p><p><a href="login.html">Login with Discord</a></p>'; return false; }
  if (u.role !== "admin") { p.textContent = "Your account is not an admin account."; return false; }
  return true;
}
