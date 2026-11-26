const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { getSettings, saveSettings } = require("../database");

const remoteEditableKeys = [
    "xpEnabled", "xpPerMessage", "xpCooldownMs", "levelUpCoins",
    "spamLimit", "spamWindowMs", "spamTimeoutMs", "moderationEnabled",
    "spamEnabled", "linkFilterEnabled", "allowServerOwner", "allowAdministrators",
    "ignoredLinkRoles", "allowedLinks", "allowedDomains", "blockedDomains",
    "linkRules", "levelUpChannelId", "levelUpMessage", "aiEnabled", "aiPrompt",
    "aiProvider", "openRouterModel", "memoryFreshLimit", "memoryFreshHours",
    "memoryRetrievalLimit", "memoryWeeklyDays", "memoryMonthlyDays",
    "memoryDeleteThreshold", "autoConversationEnabled", "autoConversationChannels",
    "inactiveMinutes", "autoConversationCooldownMinutes", "maxAutoMessagesPerDay",
    "excludedChannels", "quizChannelId", "quizTimezone", "quizDurationHours",
    "quizWinnerCoins", "quizParticipantCoins", "universalMemoryFacts", "levelUp"
];
const remoteBooleanKeys = new Set([
    "xpEnabled", "moderationEnabled", "spamEnabled", "linkFilterEnabled",
    "allowServerOwner", "allowAdministrators", "aiEnabled", "autoConversationEnabled"
]);
const remoteStringLimits = {
    levelUpChannelId: 25,
    levelUpMessage: 1000,
    aiPrompt: 4000,
    aiProvider: 20,
    openRouterModel: 160,
    quizChannelId: 25,
    quizTimezone: 80
};
const remoteNumericRanges = {
    xpPerMessage: [1, 1000],
    xpCooldownMs: [1000, 86400000],
    levelUpCoins: [0, 1000000],
    spamLimit: [2, 100],
    spamWindowMs: [1000, 3600000],
    spamTimeoutMs: [5000, 2419200000],
    memoryFreshLimit: [4, 500],
    memoryFreshHours: [1, 168],
    memoryRetrievalLimit: [2, 100],
    memoryWeeklyDays: [1, 365],
    memoryMonthlyDays: [7, 3650],
    memoryDeleteThreshold: [0, 1],
    inactiveMinutes: [1, 10080],
    autoConversationCooldownMinutes: [1, 43200],
    maxAutoMessagesPerDay: [1, 100],
    quizDurationHours: [1, 168],
    quizWinnerCoins: [0, 1000000],
    quizParticipantCoins: [0, 1000000]
};
const remoteArrayKeys = new Set([
    "ignoredLinkRoles", "allowedLinks", "allowedDomains", "blockedDomains",
    "autoConversationChannels", "excludedChannels", "universalMemoryFacts"
]);
function remoteSettings() {
    const settings = getSettings();
    return Object.fromEntries(
        remoteEditableKeys
            .filter(key => Object.prototype.hasOwnProperty.call(settings, key))
            .map(key => [key, settings[key]])
    );
}

function parseRemoteSettings(encoded) {
    if (typeof encoded !== "string" || encoded.length > 500_000) {
        throw new Error("Encoded settings payload is missing or too large.");
    }
    const raw = Buffer.from(encoded, "base64").toString("utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Settings payload must be a JSON object.");
    }
    const result = {};
    for (const [key, value] of Object.entries(parsed)) {
        if (!remoteEditableKeys.includes(key)) {
            throw new Error(`Unsupported setting: ${key}`);
        }
        if (remoteBooleanKeys.has(key) && typeof value !== "boolean") {
            throw new Error(`${key} must be true or false.`);
        }
        if (remoteArrayKeys.has(key) && (!Array.isArray(value) || !value.every(item => typeof item === "string"))) {
            throw new Error(`${key} must be a list of text values.`);
        }
        if (remoteArrayKeys.has(key) && value.length > 100) {
            throw new Error(`${key} cannot contain more than 100 values.`);
        }
        if (remoteArrayKeys.has(key) && value.some(item => item.length > 500)) {
            throw new Error(`${key} contains an item that is too long.`);
        }
        if (Object.prototype.hasOwnProperty.call(remoteNumericRanges, key)) {
            const [minimum, maximum] = remoteNumericRanges[key];
            if (typeof value !== "number" || value < minimum || value > maximum) {
                throw new Error(`${key} must be a number from ${minimum} to ${maximum}.`);
            }
        }
        if (Object.prototype.hasOwnProperty.call(remoteStringLimits, key)) {
            const limit = remoteStringLimits[key];
            if (typeof value !== "string" || value.length > limit) {
                throw new Error(`${key} must be text with at most ${limit} characters.`);
            }
        }
        if (key === "aiProvider" && !["auto", "gemini", "openrouter"].includes(value)) {
            throw new Error("aiProvider must be auto, gemini, or openrouter.");
        }
        if (key === "quizTimezone") {
            try {
                new Intl.DateTimeFormat("en", { timeZone: value });
            } catch {
                throw new Error("quizTimezone must be a valid IANA timezone name.");
            }
        }
        if (key === "linkRules" && (!value || typeof value !== "object" || Array.isArray(value))) {
            throw new Error("linkRules must be an object keyed by channel IDs.");
        }
        if (key === "levelUp" && (!value || typeof value !== "object" || Array.isArray(value))) {
            throw new Error("levelUp must be a settings object.");
        }
        if (key === "linkRules") {
            for (const [channelId, domains] of Object.entries(value)) {
                if (!/^\d{15,25}$/.test(channelId) || !Array.isArray(domains) ||
                    !domains.every(domain => typeof domain === "string" && domain.length <= 253)) {
                    throw new Error("Each linkRules entry must map a channel ID to a list of domains.");
                }
            }
        }
        if (key === "levelUp") {
            const allowedLevelUpKeys = new Set(["enabled", "channelId", "mentionUser", "message", "image"]);
            for (const [levelUpKey, levelUpValue] of Object.entries(value)) {
                if (!allowedLevelUpKeys.has(levelUpKey)) {
                    throw new Error(`Unsupported levelUp setting: ${levelUpKey}`);
                }
                if (["enabled", "mentionUser"].includes(levelUpKey) && typeof levelUpValue !== "boolean") {
                    throw new Error(`levelUp.${levelUpKey} must be true or false.`);
                }
                if (levelUpKey === "channelId" &&
                    (typeof levelUpValue !== "string" || levelUpValue.length > 25)) {
                    throw new Error("levelUp.channelId must be text with at most 25 characters.");
                }
                if (levelUpKey === "message" &&
                    (typeof levelUpValue !== "string" || levelUpValue.length > 1000)) {
                    throw new Error("levelUp.message must be text with at most 1000 characters.");
                }
                if (levelUpKey === "image") {
                    if (!levelUpValue || typeof levelUpValue !== "object" || Array.isArray(levelUpValue)) {
                        throw new Error("levelUp.image must be a settings object.");
                    }
                    const imageKeys = new Set([
                        "enabled", "width", "height", "title", "accentColor", "backgroundColor",
                        "showAvatar", "showLevelTransition"
                    ]);
                    for (const [imageKey, imageValue] of Object.entries(levelUpValue)) {
                        if (!imageKeys.has(imageKey)) {
                            throw new Error(`Unsupported levelUp.image setting: ${imageKey}`);
                        }
                        if (["enabled", "showAvatar", "showLevelTransition"].includes(imageKey) &&
                            typeof imageValue !== "boolean") {
                            throw new Error(`levelUp.image.${imageKey} must be true or false.`);
                        }
                        if (imageKey === "width" &&
                            (!Number.isInteger(imageValue) || imageValue < 600 || imageValue > 4096)) {
                            throw new Error("levelUp.image.width must be an integer from 600 to 4096.");
                        }
                        if (imageKey === "height" &&
                            (!Number.isInteger(imageValue) || imageValue < 240 || imageValue > 2160)) {
                            throw new Error("levelUp.image.height must be an integer from 240 to 2160.");
                        }
                        if (["title", "accentColor", "backgroundColor"].includes(imageKey) &&
                            (typeof imageValue !== "string" || imageValue.length > (imageKey === "title" ? 40 : 20))) {
                            throw new Error(`levelUp.image.${imageKey} is too long or is not text.`);
                        }
                    }
                }
            }
        }
        if (typeof value === "number" && !Number.isFinite(value)) {
            throw new Error(`${key} must be a finite number.`);
        }
        result[key] = value;
    }
    return result;
}

function applyRemoteSettings(settings, patch) {
    const nextSettings = { ...getSettings(), ...settings, ...patch };
    if (patch.levelUp) {
        nextSettings.levelUp = {
            ...(settings.levelUp || {}),
            ...patch.levelUp
        };
        if (patch.levelUp.image) {
            nextSettings.levelUp.image = {
                ...(settings.levelUp?.image || {}),
                ...patch.levelUp.image
            };
        }
    }
    Object.assign(settings, nextSettings);
    saveSettings(nextSettings);
    return remoteSettings();
}

function hasValidPanelToken(request) {
    const expected = String(process.env.PANEL_TOKEN || "");
    const supplied = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!expected || expected.length !== supplied.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

function readBody(request, maxBytes = Infinity) {
    return new Promise((resolve, reject) => {
        let body = "";
        let bytes = 0;
        let finished = false;
        request.on("data", chunk => {
            if (finished) return;
            bytes += chunk.length;
            if (bytes > maxBytes) {
                finished = true;
                reject(new Error("Request body is too large."));
                request.resume();
                return;
            }
            body += chunk;
        });
        request.on("end", () => {
            if (!finished) resolve(body);
        });
        request.on("error", reject);
    });
}

function parseLinkRules(value) {
    const rules = {};

    for (const line of String(value || "").split(/\r?\n/)) {
        const separator = line.indexOf("=");
        if (separator < 1) continue;

        const channelId = line.slice(0, separator).trim();
        const domains = line
            .slice(separator + 1)
            .split(/[\s,]+/)
            .map(domain => domain.trim().toLowerCase())
            .filter(Boolean);

        if (/^\d{15,25}$/.test(channelId) && domains.length > 0) {
            rules[channelId] = domains;
        }
    }

    return rules;
}

function formatLinkRules(rules) {
    return Object.entries(rules || {})
        .map(([channelId, domains]) => `${channelId}=${domains.join(", ")}`)
        .join("\n");
}

function parseIdList(value) {
    return String(value || "")
        .split(/[\s,]+/)
        .map(item => item.trim())
        .filter(item => /^\d{15,25}$/.test(item));
}

function startPanel(settings) {
    const port = Number(process.env.PORT || process.env.PANEL_PORT || 3000);
    const host = process.env.PANEL_HOST || "0.0.0.0";
    const token = process.env.PANEL_TOKEN;
    const allowedOrigin = String(process.env.PANEL_ORIGIN || "").replace(/\/+$/, "");

    if (!token) {
        console.warn("⚠️ PANEL_TOKEN is missing; web control panel is disabled.");
        return null;
    }

    const server = http.createServer(async (request, response) => {
        const url = new URL(request.url, `http://${request.headers.host}`);
        if (url.pathname.startsWith("/api/")) {
            const origin = request.headers.origin;
            const forwardedProtocol = String(request.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
            const sameOrigin = `${forwardedProtocol}://${request.headers.host}`;
            if (origin && (origin === allowedOrigin || origin === sameOrigin) && origin !== sameOrigin) {
                response.setHeader("Access-Control-Allow-Origin", allowedOrigin);
                response.setHeader("Vary", "Origin");
                response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
                response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            } else if (origin && origin !== allowedOrigin && origin !== sameOrigin) {
                response.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
                response.end(JSON.stringify({ error: "This panel origin is not allowed. Set PANEL_ORIGIN on the bot host." }));
                return;
            }
            if (request.method === "OPTIONS") {
                response.writeHead(204);
                response.end();
                return;
            }
            if (!hasValidPanelToken(request)) {
                response.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
                response.end(JSON.stringify({ error: "Unauthorized. Check PANEL_TOKEN." }));
                return;
            }
            if (url.pathname === "/api/settings" && request.method === "GET") {
                response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
                response.end(JSON.stringify(remoteSettings()));
                return;
            }
            if (url.pathname === "/api/settings" && request.method === "POST") {
                try {
                    const rawBody = await readBody(request, 700_000);
                    const body = JSON.parse(rawBody);
                    const patch = parseRemoteSettings(body.payload);
                    const updatedSettings = applyRemoteSettings(settings, patch);
                    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
                    response.end(JSON.stringify({ ok: true, settings: updatedSettings }));
                } catch (error) {
                    response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
                    response.end(JSON.stringify({ error: error.message || "Invalid settings payload." }));
                }
                return;
            }
            response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
            response.end(JSON.stringify({ error: "Not found." }));
            return;
        }

        if (url.searchParams.get("token") !== token) {
            response.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
            response.end("Unauthorized");
            return;
        }

        if (request.method === "POST" && url.pathname === "/settings") {
            try {
                const rawBody = await readBody(request);
                const body = Object.fromEntries(new URLSearchParams(rawBody));
                const persisted = getSettings();
                Object.assign(settings, persisted);
                settings.levelUp = {
                    ...(settings.levelUp || {}),
                    ...(persisted.levelUp || {})
                };
                settings.levelUp.image = {
                    ...(settings.levelUp.image || {}),
                    ...(persisted.levelUp?.image || {})
                };
                const has = name => Object.prototype.hasOwnProperty.call(body, name);
                settings.levelUp = settings.levelUp || {};
                settings.levelUp.image = settings.levelUp.image || {};
                Object.assign(settings, {
                    xpEnabled: has("xpEnabled") ? body.xpEnabled === "on" : settings.xpEnabled,
                    xpPerMessage: Math.max(1, Number(body.xpPerMessage) || settings.xpPerMessage),
                    xpCooldownMs: Math.max(1000, Number(body.xpCooldownMs) || settings.xpCooldownMs),
                    levelUpCoins: Math.max(0, Number(body.levelUpCoins) || settings.levelUpCoins),
                    spamLimit: Math.max(2, Number(body.spamLimit) || settings.spamLimit),
                    spamWindowMs: Math.max(1000, Number(body.spamWindowMs) || settings.spamWindowMs),
                    spamTimeoutMs: Math.max(5000, Number(body.spamTimeoutMs) || settings.spamTimeoutMs),
                    levelUpChannelId: String(body.levelUpChannelId || "").trim(),
                    levelUpMessage: String(body.levelUpMessage || "").slice(0, 1000),
                    moderationEnabled: has("moderationEnabled") ? body.moderationEnabled === "on" : settings.moderationEnabled,
                    spamEnabled: has("spamEnabled") ? body.spamEnabled === "on" : settings.spamEnabled,
                    linkFilterEnabled: has("linkFilterEnabled") ? body.linkFilterEnabled === "on" : settings.linkFilterEnabled,
                    allowServerOwner: has("allowServerOwner") ? body.allowServerOwner === "on" : settings.allowServerOwner,
                    allowAdministrators: has("allowAdministrators") ? body.allowAdministrators === "on" : settings.allowAdministrators,
                    ignoredLinkRoles: has("ignoredLinkRoles")
                        ? parseIdList(body.ignoredLinkRoles)
                        : settings.ignoredLinkRoles,
                    allowedLinks: has("allowedLinks")
                        ? String(body.allowedLinks || "")
                            .split(/[\s,]+/)
                            .map(value => value.trim().toLowerCase())
                            .filter(Boolean)
                        : settings.allowedLinks,
                    linkRules: has("linkRules")
                        ? parseLinkRules(body.linkRules)
                        : settings.linkRules,
                    aiPrompt: has("aiPrompt") ? String(body.aiPrompt || "").slice(0, 4000) : settings.aiPrompt,
                    aiEnabled: has("aiEnabled") ? body.aiEnabled === "on" : settings.aiEnabled,
                    aiProvider: has("aiProvider") && ["auto", "gemini", "openrouter"].includes(body.aiProvider)
                        ? body.aiProvider
                        : settings.aiProvider,
                    openRouterModel: has("openRouterModel")
                        ? String(body.openRouterModel || "deepseek/deepseek-r1:free").trim().slice(0, 160)
                        : settings.openRouterModel,
                    memoryFreshLimit: Math.max(4, Number(body.memoryFreshLimit) || settings.memoryFreshLimit),
                    memoryFreshHours: Math.max(1, Math.min(168, Number(body.memoryFreshHours) || settings.memoryFreshHours || 24)),
                    memoryRetrievalLimit: Math.max(2, Number(body.memoryRetrievalLimit) || settings.memoryRetrievalLimit),
                    memoryWeeklyDays: Math.max(1, Number(body.memoryWeeklyDays) || settings.memoryWeeklyDays),
                    memoryMonthlyDays: Math.max(7, Number(body.memoryMonthlyDays) || settings.memoryMonthlyDays),
                    memoryDeleteThreshold: has("memoryDeleteThreshold")
                        ? Math.min(1, Math.max(0, Number(body.memoryDeleteThreshold) || 0))
                        : settings.memoryDeleteThreshold,
                    autoConversationEnabled: has("autoConversationEnabled")
                        ? body.autoConversationEnabled === "on"
                        : settings.autoConversationEnabled,
                    autoConversationChannels: has("autoConversationChannels")
                        ? parseIdList(body.autoConversationChannels)
                        : settings.autoConversationChannels,
                    excludedChannels: has("excludedChannels")
                        ? parseIdList(body.excludedChannels)
                        : settings.excludedChannels,
                    inactiveMinutes: Math.max(1, Number(body.inactiveMinutes) || settings.inactiveMinutes || 30),
                    autoConversationCooldownMinutes: Math.max(1, Number(body.autoConversationCooldownMinutes) || settings.autoConversationCooldownMinutes || 180),
                    maxAutoMessagesPerDay: Math.max(1, Number(body.maxAutoMessagesPerDay) || settings.maxAutoMessagesPerDay || 4),
                    quizChannelId: has("quizChannelId") ? String(body.quizChannelId || "").trim() : settings.quizChannelId,
                    quizTimezone: has("quizTimezone") ? String(body.quizTimezone || "Asia/Kolkata").trim() : settings.quizTimezone,
                    quizDurationHours: Math.max(1, Number(body.quizDurationHours) || settings.quizDurationHours || 24),
                    quizWinnerCoins: has("quizWinnerCoins")
                        ? Math.max(0, Number(body.quizWinnerCoins) || 0)
                        : settings.quizWinnerCoins,
                    quizParticipantCoins: has("quizParticipantCoins")
                        ? Math.max(0, Number(body.quizParticipantCoins) || 0)
                        : settings.quizParticipantCoins
                });
                try {
                    new Intl.DateTimeFormat("en", { timeZone: settings.quizTimezone });
                } catch {
                    settings.quizTimezone = "Asia/Kolkata";
                }
                Object.assign(settings.levelUp, {
                    enabled: has("levelUpEnabled") ? body.levelUpEnabled === "on" : settings.levelUp.enabled,
                    channelId: has("levelUpChannelId") ? String(body.levelUpChannelId || "").trim() : settings.levelUp.channelId,
                    mentionUser: has("levelUpMention") ? body.levelUpMention === "on" : settings.levelUp.mentionUser,
                    message: has("levelUpMessage") ? String(body.levelUpMessage || "").slice(0, 1000) : settings.levelUp.message,
                    image: {
                        ...settings.levelUp.image,
                        enabled: has("levelUpImageEnabled") ? body.levelUpImageEnabled === "on" : settings.levelUp.image.enabled,
                        width: Math.max(600, Number(body.levelUpImageWidth) || 1200),
                        height: Math.max(240, Number(body.levelUpImageHeight) || 400),
                        title: String(body.levelUpImageTitle || "LEVEL-UP!").slice(0, 40),
                        accentColor: String(body.levelUpAccentColor || "#8CFF00").slice(0, 20),
                        backgroundColor: String(body.levelUpBackgroundColor || "#080A08").slice(0, 20),
                        showAvatar: has("levelUpShowAvatar") ? body.levelUpShowAvatar === "on" : settings.levelUp.image.showAvatar,
                        showLevelTransition: has("levelUpShowTransition") ? body.levelUpShowTransition === "on" : settings.levelUp.image.showLevelTransition
                    }
                });
                saveSettings(settings);
                response.writeHead(303, { Location: `/panel?token=${encodeURIComponent(token)}` });
                response.end();
            } catch {
                response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
                response.end("Invalid settings");
            }
            return;
        }

        if (url.pathname === "/panel.css") {
            response.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
            response.end(fs.readFileSync(path.join(__dirname, "public/panel.css"), "utf8"));
            return;
        }

        if (url.pathname === "/") {
            response.writeHead(302, {
                Location: `/panel?token=${encodeURIComponent(token)}`
            });
            response.end();
            return;
        }

        if (url.pathname !== "/panel") {
            response.writeHead(404);
            response.end("Not found");
            return;
        }

        const template = fs.readFileSync(path.join(__dirname, "public/index.html"), "utf8");
        const html = template
            .replaceAll("__FORM_ACTION__", `/settings?token=${encodeURIComponent(token)}`)
            .replaceAll("/panel.css", `/panel.css?token=${encodeURIComponent(token)}`)
            .replaceAll("__XP_ENABLED__", settings.xpEnabled ? " checked" : "")
            .replaceAll("__XP_PER_MESSAGE__", escapeHtml(settings.xpPerMessage))
            .replaceAll("__XP_COOLDOWN__", escapeHtml(settings.xpCooldownMs))
            .replaceAll("__LEVEL_COINS__", escapeHtml(settings.levelUpCoins))
            .replaceAll("__SPAM_LIMIT__", escapeHtml(settings.spamLimit))
            .replaceAll("__SPAM_WINDOW__", escapeHtml(settings.spamWindowMs))
            .replaceAll("__SPAM_TIMEOUT__", escapeHtml(settings.spamTimeoutMs))
            .replaceAll("__LEVEL_UP_CHANNEL__", escapeHtml(settings.levelUp?.channelId || settings.levelUpChannelId || ""))
            .replaceAll("__LEVEL_UP_MESSAGE__", escapeHtml(settings.levelUp?.message || settings.levelUpMessage || ""))
            .replaceAll("__LEVEL_UP_ENABLED__", settings.levelUp?.enabled !== false ? " checked" : "")
            .replaceAll("__LEVEL_UP_MENTION__", settings.levelUp?.mentionUser !== false ? " checked" : "")
            .replaceAll("__LEVEL_UP_IMAGE_ENABLED__", settings.levelUp?.image?.enabled !== false ? " checked" : "")
            .replaceAll("__LEVEL_UP_IMAGE_WIDTH__", escapeHtml(settings.levelUp?.image?.width || 1200))
            .replaceAll("__LEVEL_UP_IMAGE_HEIGHT__", escapeHtml(settings.levelUp?.image?.height || 400))
            .replaceAll("__LEVEL_UP_IMAGE_TITLE__", escapeHtml(settings.levelUp?.image?.title || "LEVEL-UP!"))
            .replaceAll("__LEVEL_UP_ACCENT__", escapeHtml(settings.levelUp?.image?.accentColor || "#8CFF00"))
            .replaceAll("__LEVEL_UP_BACKGROUND__", escapeHtml(settings.levelUp?.image?.backgroundColor || "#080A08"))
            .replaceAll("__LEVEL_UP_SHOW_AVATAR__", settings.levelUp?.image?.showAvatar !== false ? " checked" : "")
            .replaceAll("__LEVEL_UP_SHOW_TRANSITION__", settings.levelUp?.image?.showLevelTransition !== false ? " checked" : "")
            .replaceAll("__MODERATION_ENABLED__", settings.moderationEnabled ? " checked" : "")
            .replaceAll("__SPAM_ENABLED__", settings.spamEnabled ? " checked" : "")
            .replaceAll("__LINK_FILTER_ENABLED__", settings.linkFilterEnabled ? " checked" : "")
            .replaceAll("__ALLOWED_LINKS__", escapeHtml((settings.allowedLinks || []).join(", ")))
            .replaceAll("__LINK_RULES__", escapeHtml(formatLinkRules(settings.linkRules)))
            .replaceAll("__ALLOW_SERVER_OWNER__", settings.allowServerOwner !== false ? " checked" : "")
            .replaceAll("__ALLOW_ADMINISTRATORS__", settings.allowAdministrators !== false ? " checked" : "")
            .replaceAll("__IGNORED_LINK_ROLES__", escapeHtml((settings.ignoredLinkRoles || []).join(", ")))
            .replaceAll("__AI_PROMPT__", escapeHtml(settings.aiPrompt))
            .replaceAll("__AI_ENABLED__", settings.aiEnabled ? " checked" : "")
            .replaceAll("__OPENROUTER_MODEL__", escapeHtml(settings.openRouterModel || "deepseek/deepseek-r1:free"))
            .replaceAll("__MEMORY_FRESH_LIMIT__", escapeHtml(settings.memoryFreshLimit))
            .replaceAll("__MEMORY_FRESH_HOURS__", escapeHtml(settings.memoryFreshHours || 24))
            .replaceAll("__MEMORY_RETRIEVAL_LIMIT__", escapeHtml(settings.memoryRetrievalLimit))
            .replaceAll("__MEMORY_WEEKLY_DAYS__", escapeHtml(settings.memoryWeeklyDays))
            .replaceAll("__MEMORY_MONTHLY_DAYS__", escapeHtml(settings.memoryMonthlyDays))
            .replaceAll("__MEMORY_DELETE_THRESHOLD__", escapeHtml(settings.memoryDeleteThreshold))
            .replaceAll("__AUTO_CONVERSATION_ENABLED__", settings.autoConversationEnabled ? " checked" : "")
            .replaceAll("__AUTO_CONVERSATION_CHANNELS__", escapeHtml((settings.autoConversationChannels || []).join(", ")))
            .replaceAll("__EXCLUDED_CHANNELS__", escapeHtml((settings.excludedChannels || []).join(", ")))
            .replaceAll("__INACTIVE_MINUTES__", escapeHtml(settings.inactiveMinutes || 30))
            .replaceAll("__AUTO_CONVERSATION_COOLDOWN__", escapeHtml(settings.autoConversationCooldownMinutes || 180))
            .replaceAll("__MAX_AUTO_MESSAGES__", escapeHtml(settings.maxAutoMessagesPerDay || 4))
            .replaceAll("__QUIZ_CHANNEL_ID__", escapeHtml(settings.quizChannelId || ""))
            .replaceAll("__QUIZ_TIMEZONE__", escapeHtml(settings.quizTimezone || "Asia/Kolkata"))
            .replaceAll("__QUIZ_DURATION__", escapeHtml(settings.quizDurationHours || 24))
            .replaceAll("__QUIZ_WINNER_COINS__", escapeHtml(settings.quizWinnerCoins ?? 25))
            .replaceAll("__QUIZ_PARTICIPANT_COINS__", escapeHtml(settings.quizParticipantCoins ?? 3))
            .replaceAll("__AUTO_SELECTED__", settings.aiProvider === "auto" ? " selected" : "")
            .replaceAll("__GEMINI_SELECTED__", settings.aiProvider === "gemini" ? " selected" : "")
            .replaceAll("__OPENROUTER_SELECTED__", settings.aiProvider === "openrouter" ? " selected" : "");
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(html);
    });

    server.on("error", error => {
        if (error.code === "EADDRINUSE") {
            console.error(`❌ Control panel port ${port} is already in use. Set PANEL_PORT to another port.`);
            return;
        }

        console.error("❌ Control panel failed:", error);
    });

    server.listen(port, host, () => console.log(`🌐 Control panel listening on ${host}:${port}`));
    return server;
}

module.exports = {
    startPanel,
    parseRemoteSettings,
    remoteSettings,
    applyRemoteSettings
};
