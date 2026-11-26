// Panel codes: how the website and the bot talk to each other through Discord.
//
//   /panelcode  -> bot gives a mod an "open" code (current settings + a one-time grant).
//   website     -> mod pastes it, edits settings, clicks "Get panel code" -> "update" code (only the changes).
//   /updatepanel-> mod pastes the update code; bot checks the grant, applies, and DMs the owner + the mod.
//
// SECURITY MODEL (read this): the website lives on public GitHub Pages, so the code key
// (PANEL_CODE_KEY / AIKO_CODE_KEY) is not a real secret. The encryption only keeps codes unreadable
// at a glance and detects accidental corruption. What actually protects the server is:
//   1. only mods can run /panelcode and /updatepanel (checked live against Discord permissions),
//   2. every update code needs a one-time grant that the bot issued to that exact mod,
//   3. grants expire and work once,
//   4. the bot only applies whitelisted, validated settings,
//   5. the owner and the mod get a DM listing every change.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PermissionFlagsBits } = require("discord.js");

const VERSION = "AIKO2";
const GRANTS_FILE = path.join(__dirname, "../data/panel-grants.json");
const AUDIT_FILE = path.join(__dirname, "../data/panel-audit.log");
const MAX_CODE_LENGTH = 500_000;
const MAX_GRANTS_PER_USER = 3;

const PANEL_PERMISSIONS = [
    PermissionFlagsBits.Administrator,
    PermissionFlagsBits.ManageGuild,
    PermissionFlagsBits.ModerateMembers,
    PermissionFlagsBits.ManageMessages
];

function ttlMs() {
    return Math.max(5, Number(process.env.PANEL_CODE_TTL_MINUTES || 120)) * 60_000;
}

// ---------- who counts as a mod ----------

function memberIsMod(member) {
    if (!member) return false;
    if (member.guild?.ownerId === member.id) return true;
    if (member.permissions?.any(PANEL_PERMISSIONS)) return true;
    const roleIds = String(process.env.PANEL_ROLE_IDS || "").split(/[\s,]+/).filter(id => /^\d{15,25}$/.test(id));
    return roleIds.some(id => member.roles?.cache?.has(id));
}

// ---------- encryption (matches site-panel/panel.js) ----------

function codeKey() {
    const key = String(process.env.PANEL_CODE_KEY || "");
    if (key.length < 16) {
        throw new Error("Set PANEL_CODE_KEY (at least 16 characters, same value as AIKO_CODE_KEY in the website's config.js).");
    }
    return crypto.createHash("sha256").update(`aiko-panel-v2:${key}`).digest();
}

function encryptEnvelope(envelope) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", codeKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(envelope), "utf8"), cipher.final()]);
    return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

function decryptEnvelope(code) {
    if (typeof code !== "string" || !code.trim() || code.length > MAX_CODE_LENGTH) {
        throw new Error("The panel code is missing or too large.");
    }
    const parts = code.trim().split(".");
    if (parts.length !== 4 || parts[0] !== VERSION || parts.slice(1).some(part => !/^[A-Za-z0-9_-]+$/.test(part))) {
        throw new Error("That is not a valid panel code. Copy the whole code from the website's 'Get panel code' button.");
    }
    const iv = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    const ciphertext = Buffer.from(parts[3], "base64url");
    if (iv.length !== 12 || tag.length !== 16) throw new Error("That panel code is damaged.");
    let plaintext;
    try {
        const decipher = crypto.createDecipheriv("aes-256-gcm", codeKey(), iv);
        decipher.setAuthTag(tag);
        plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
        throw new Error("Could not read that code. It is damaged, or PANEL_CODE_KEY on the bot does not match the website's AIKO_CODE_KEY.");
    }
    const envelope = JSON.parse(plaintext);
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || envelope.v !== 2) {
        throw new Error("That panel code has an unsupported format.");
    }
    return envelope;
}

// ---------- one-time grants ----------

function loadGrants() {
    try {
        const parsed = JSON.parse(fs.readFileSync(GRANTS_FILE, "utf8"));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function saveGrants(grants) {
    fs.mkdirSync(path.dirname(GRANTS_FILE), { recursive: true });
    const temp = `${GRANTS_FILE}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(grants, null, 2), { mode: 0o600 });
    fs.renameSync(temp, GRANTS_FILE);
}

function issueGrant(userId, userName) {
    const now = Date.now();
    const grants = Object.fromEntries(Object.entries(loadGrants()).filter(([, grant]) => grant.exp > now));
    const mine = Object.entries(grants).filter(([, grant]) => grant.userId === userId).sort((a, b) => a[1].exp - b[1].exp);
    while (mine.length >= MAX_GRANTS_PER_USER) delete grants[mine.shift()[0]];
    const nonce = crypto.randomBytes(16).toString("base64url");
    grants[nonce] = { userId, name: String(userName || "").slice(0, 80), exp: now + ttlMs() };
    saveGrants(grants);
    return { nonce, exp: grants[nonce].exp };
}

// Checks a grant without using it up. Returns the grant, or throws a user-friendly error.
function checkGrant(nonce, userId) {
    const grant = typeof nonce === "string" ? loadGrants()[nonce] : null;
    if (!grant || grant.exp <= Date.now() || grant.userId !== userId) {
        throw new Error("This code has expired, was already used, or was issued to someone else. Run /panelcode again and start from a fresh code.");
    }
    return grant;
}

function consumeGrant(nonce) {
    const grants = loadGrants();
    delete grants[nonce];
    saveGrants(grants);
}

// ---------- reporting ----------

function audit(entry) {
    try {
        fs.appendFileSync(AUDIT_FILE, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
    } catch (error) {
        console.warn("⚠️ Could not write panel audit log:", error.message);
    }
}

function shorten(value, limit = 160) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    const flat = String(text ?? "").replace(/\s+/g, " ");
    return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function describeChanges(before, patch) {
    const changes = [];
    for (const [key, value] of Object.entries(patch)) {
        if (JSON.stringify(before[key]) !== JSON.stringify(value)) {
            changes.push({ key, from: before[key], to: value });
        }
    }
    return changes;
}

function changeReport(user, changes) {
    const when = Math.floor(Date.now() / 1000);
    const header = [
        "🔔 **Aiko settings were changed from the web panel**",
        `By: <@${user.id}> (${user.tag || user.username}, ID ${user.id})`,
        `When: <t:${when}:F>`,
        `Changed ${changes.length} setting${changes.length === 1 ? "" : "s"}:`
    ].join("\n");
    const lines = changes.map(change => `• \`${change.key}\`: ${shorten(change.from)} → ${shorten(change.to)}`);
    const text = `${header}\n${lines.join("\n")}`;
    if (text.length <= 1900) return { content: text };
    const details = changes.map(change =>
        `${change.key}\n  before: ${JSON.stringify(change.from)}\n  after:  ${JSON.stringify(change.to)}`).join("\n\n");
    return {
        content: `${header}\n(Too long for one message, full details attached.)`.slice(0, 1900),
        files: [{ attachment: Buffer.from(details, "utf8"), name: "panel-changes.txt" }]
    };
}

// DMs the server owner and the mod who made the change. Returns who could not be reached.
async function notify(interaction, changes) {
    const report = changeReport(interaction.user, changes);
    const failed = [];
    const recipients = new Map();
    try {
        const owner = await interaction.guild.fetchOwner();
        recipients.set(owner.id, owner.user);
    } catch {
        failed.push("server owner");
    }
    recipients.set(interaction.user.id, interaction.user);
    for (const [, user] of recipients) {
        try {
            await user.send({ ...report, allowedMentions: { parse: [] } });
        } catch {
            failed.push(user.id === interaction.user.id ? "you" : "server owner");
        }
    }
    const logChannelId = process.env.PANEL_LOG_CHANNEL_ID;
    if (logChannelId) {
        try {
            const channel = await interaction.client.channels.fetch(logChannelId);
            await channel.send({ ...report, allowedMentions: { parse: [] } });
        } catch (error) {
            console.warn("⚠️ Could not post to PANEL_LOG_CHANNEL_ID:", error.message);
        }
    }
    return failed;
}

module.exports = {
    memberIsMod,
    encryptEnvelope,
    decryptEnvelope,
    issueGrant,
    checkGrant,
    consumeGrant,
    describeChanges,
    notify,
    audit,
    ttlMs
};
