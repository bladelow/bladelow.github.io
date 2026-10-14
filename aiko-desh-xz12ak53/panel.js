(() => {
    const groups = {
        "Progression": ["xpEnabled", "xpPerMessage", "xpCooldownMs", "levelUpCoins", "levelUpChannelId", "levelUpMessage", "levelUp"],
        "Moderation and links": ["moderationEnabled", "spamEnabled", "spamLimit", "spamWindowMs", "spamTimeoutMs", "linkFilterEnabled", "allowServerOwner", "allowAdministrators", "ignoredLinkRoles", "allowedLinks", "allowedDomains", "blockedDomains", "linkRules"],
        "AI": ["aiEnabled", "aiProvider", "openRouterModel", "aiPrompt"],
        "AI memory": ["memoryFreshLimit", "memoryFreshHours", "memoryRetrievalLimit", "memoryWeeklyDays", "memoryMonthlyDays", "memoryDeleteThreshold", "universalMemoryFacts"],
        "Automatic conversation": ["autoConversationEnabled", "autoConversationChannels", "inactiveMinutes", "autoConversationCooldownMinutes", "maxAutoMessagesPerDay", "excludedChannels"],
        "Daily quiz": ["quizChannelId", "quizTimezone", "quizDurationHours", "quizWinnerCoins", "quizParticipantCoins"]
    };
    const labels = {
        xpEnabled: "Enable XP and levels",
        xpPerMessage: "XP per message",
        xpCooldownMs: "XP cooldown (ms)",
        levelUpCoins: "Coins per level",
        levelUpChannelId: "Level-up channel ID",
        levelUpMessage: "Level-up message template",
        moderationEnabled: "Enable moderation",
        spamEnabled: "Detect repeated messages",
        spamLimit: "Repeated messages before timeout",
        spamWindowMs: "Spam detection window (ms)",
        spamTimeoutMs: "Timeout duration (ms)",
        linkFilterEnabled: "Block non-allowed links",
        allowServerOwner: "Allow server owner to bypass link filter",
        allowAdministrators: "Allow administrators to bypass link filter",
        ignoredLinkRoles: "Ignored link-filter role IDs (JSON list)",
        allowedLinks: "Allowed link domains (JSON list)",
        allowedDomains: "Allowed domains (JSON list)",
        blockedDomains: "Blocked domains (JSON list)",
        linkRules: "Per-channel link rules (JSON object)",
        aiEnabled: "Enable AI chat",
        aiProvider: "AI provider (auto, gemini, openrouter)",
        openRouterModel: "OpenRouter model",
        aiPrompt: "Extra AI instructions",
        memoryFreshLimit: "Recent messages to retain",
        memoryFreshHours: "Recent chat retention (hours)",
        memoryRetrievalLimit: "Memories per prompt",
        memoryWeeklyDays: "Compress memories after (days)",
        memoryMonthlyDays: "Archive/delete memories after (days)",
        memoryDeleteThreshold: "Memory deletion threshold (0–1)",
        universalMemoryFacts: "Universal facts (JSON list)",
        autoConversationEnabled: "Allow AI to start conversations",
        autoConversationChannels: "Allowed channel IDs (JSON list)",
        inactiveMinutes: "Start after inactivity (minutes)",
        autoConversationCooldownMinutes: "Channel cooldown (minutes)",
        maxAutoMessagesPerDay: "Daily message limit",
        excludedChannels: "Excluded channel IDs (JSON list)",
        quizChannelId: "Daily quiz channel ID",
        quizTimezone: "Quiz timezone",
        quizDurationHours: "Quiz duration (hours)",
        quizWinnerCoins: "Winner Blade Coins",
        quizParticipantCoins: "Participant Blade Coins",
        levelUp: "Level-up settings (JSON object)"
    };

    const API = String(window.AIKO_API_BASE || "").replace(/\/+$/, "");
    const $ = selector => document.querySelector(selector);
    const loginPanel = $("#loginPanel"), app = $("#app");
    const loginStatus = $("#loginStatus"), status = $("#status");
    const settingsContainer = $("#settings");

    // The session token lives only in this variable: closing or refreshing the page logs you out.
    let token = null;
    let expiryTimer = null;
    let savedSettings = {};
    let settingInputs = new Map();

    function say(element, message, isError = false) {
        element.textContent = message;
        element.className = `status ${isError ? "error" : "success"}`;
    }

    async function api(path, options = {}) {
        if (!API || API.includes("YOUR-BOT-API-URL")) throw new Error("Panel is not configured: set AIKO_API_BASE in config.js.");
        let response;
        try {
            response = await fetch(API + path, {
                ...options,
                headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) }
            });
        } catch {
            throw new Error("Cannot reach the bot. Is it online?");
        }
        const data = await response.json().catch(() => ({}));
        if (response.status === 401 && token) {
            logout("Session expired. Please log in again.");
            throw new Error("Session expired.");
        }
        if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
        return data;
    }

    function logout(message = "") {
        token = null;
        clearTimeout(expiryTimer);
        settingInputs = new Map();
        settingsContainer.replaceChildren();
        app.hidden = true;
        loginPanel.hidden = false;
        $("#password").value = "";
        say(loginStatus, message, true);
    }

    function utf8Base64(text) {
        let binary = "";
        new TextEncoder().encode(text).forEach(byte => { binary += String.fromCharCode(byte); });
        return btoa(binary);
    }

    function readControls() {
        const settings = {};
        for (const [key, input] of settingInputs) {
            if (input.type === "checkbox") {
                settings[key] = input.checked;
            } else if (input.dataset.json === "true") {
                try { settings[key] = JSON.parse(input.value); }
                catch { throw new Error(`${labels[key] || key}: enter valid JSON.`); }
            } else if (input.type === "number") {
                if (!input.value.trim()) throw new Error(`${labels[key] || key}: enter a number.`);
                const value = Number(input.value);
                if (!Number.isFinite(value)) throw new Error(`${labels[key] || key}: enter a valid number.`);
                settings[key] = value;
            } else {
                settings[key] = input.value;
            }
        }
        return settings;
    }

    function createControl(key, value) {
        let input;
        if (typeof value === "boolean") {
            input = document.createElement("input");
            input.type = "checkbox";
            input.checked = value;
        } else if (typeof value === "number") {
            input = document.createElement("input");
            input.type = "number";
            input.step = Number.isInteger(value) ? "1" : "0.01";
            input.value = String(value);
        } else if (value !== null && typeof value === "object") {
            input = document.createElement("textarea");
            input.value = JSON.stringify(value, null, 2);
            input.dataset.json = "true";
        } else {
            input = document.createElement("textarea");
            input.value = String(value ?? "");
            if (["aiPrompt", "levelUpMessage"].includes(key)) input.rows = 4;
        }
        input.id = `setting-${key}`;
        settingInputs.set(key, input);
        return input;
    }

    function renderSettings(settings) {
        savedSettings = settings;
        settingInputs = new Map();
        settingsContainer.replaceChildren();
        for (const [group, keys] of Object.entries(groups)) {
            const section = document.createElement("section");
            section.className = "panel";
            const heading = document.createElement("h2");
            heading.textContent = group;
            section.append(heading);
            for (const key of keys) {
                if (!Object.prototype.hasOwnProperty.call(settings, key)) continue;
                const row = document.createElement("div");
                row.className = "setting";
                const label = document.createElement("label");
                label.htmlFor = `setting-${key}`;
                label.textContent = labels[key] || key;
                const input = createControl(key, settings[key]);
                if (input.type === "checkbox") {
                    label.className = "check";
                    row.append(input, label);
                } else {
                    row.append(label, input);
                }
                section.append(row);
            }
            settingsContainer.append(section);
        }
    }

    async function loadSettings() {
        say(status, "Loading settings...");
        renderSettings(await api("/api/settings"));
        say(status, "Settings loaded.");
    }

    $("#loginForm").addEventListener("submit", async event => {
        event.preventDefault();
        const button = $("#loginButton");
        button.disabled = true;
        say(loginStatus, "Checking...");
        try {
            const userId = $("#userId").value.trim();
            const result = await api("/api/login", {
                method: "POST",
                body: JSON.stringify({ userId, password: $("#password").value })
            });
            token = result.token;
            $("#password").value = "";
            try { localStorage.setItem("aikoPanelUserId", userId); } catch {}
            clearTimeout(expiryTimer);
            expiryTimer = setTimeout(() => logout("Session expired. Please log in again."), result.expiresInMs);
            $("#who").textContent = `Logged in as ${result.name}`;
            loginPanel.hidden = true;
            app.hidden = false;
            say(loginStatus, "");
            await loadSettings();
        } catch (error) {
            if (!token) say(loginStatus, error.message, true);
            else say(status, error.message, true);
        } finally {
            button.disabled = false;
        }
    });

    $("#saveButton").addEventListener("click", async event => {
        const button = event.currentTarget;
        button.disabled = true;
        say(status, "Saving...");
        try {
            const current = readControls();
            const patch = {};
            for (const [key, value] of Object.entries(current)) {
                if (JSON.stringify(value) !== JSON.stringify(savedSettings[key])) patch[key] = value;
            }
            if (!Object.keys(patch).length) {
                say(status, "Nothing changed.");
                return;
            }
            const result = await api("/api/settings", {
                method: "POST",
                body: JSON.stringify({ payload: utf8Base64(JSON.stringify(patch)) })
            });
            renderSettings(result.settings);
            say(status, `Saved ${Object.keys(patch).length} setting(s). The bot uses them immediately.`);
        } catch (error) {
            say(status, error.message, true);
        } finally {
            button.disabled = false;
        }
    });

    $("#reloadButton").addEventListener("click", () => loadSettings().catch(error => say(status, error.message, true)));
    $("#logoutButton").addEventListener("click", () => logout("Logged out."));

    try { $("#userId").value = localStorage.getItem("aikoPanelUserId") || ""; } catch {}
})();

