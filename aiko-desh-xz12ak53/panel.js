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

    const KEY_TEXT = String(window.AIKO_CODE_KEY || "");
    const $ = selector => document.querySelector(selector);
    const encoder = new TextEncoder();
    const settingsContainer = $("#settings");
    const status = $("#status");
    const loadStatus = $("#loadStatus");

    let savedSettings = {};
    let settingInputs = new Map();
    let nonce = null;
    let expiresAt = 0;

    function say(element, message, isError = false) {
        element.textContent = message;
        element.className = `status ${isError ? "error" : "success"}`;
    }

    function b64urlEncode(bytes) {
        let binary = "";
        bytes.forEach(byte => { binary += String.fromCharCode(byte); });
        return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    }

    function b64urlDecode(value) {
        if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("That is not a valid panel code.");
        const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
        return Uint8Array.from(atob(base64 + "=".repeat((4 - base64.length % 4) % 4)), character => character.charCodeAt(0));
    }

    async function codeKey() {
        if (KEY_TEXT.length < 16 || KEY_TEXT.includes("PASTE")) {
            throw new Error("Panel is not configured: set AIKO_CODE_KEY in config.js (same as PANEL_CODE_KEY on the bot).");
        }
        if (!crypto.subtle) throw new Error("This browser cannot do encryption. Use a current browser over https.");
        const hash = await crypto.subtle.digest("SHA-256", encoder.encode(`aiko-panel-v2:${KEY_TEXT}`));
        return crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["encrypt", "decrypt"]);
    }

    async function decryptCode(code) {
        const parts = code.trim().split(".");
        if (parts.length !== 4 || parts[0] !== "AIKO2") throw new Error("That is not a valid panel code. Paste the whole code from /panelcode.");
        const iv = b64urlDecode(parts[1]);
        const tag = b64urlDecode(parts[2]);
        const ciphertext = b64urlDecode(parts[3]);
        if (iv.length !== 12 || tag.length !== 16) throw new Error("That panel code is damaged.");
        const encrypted = new Uint8Array(ciphertext.length + tag.length);
        encrypted.set(ciphertext);
        encrypted.set(tag, ciphertext.length);
        let plaintext;
        try {
            plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv, tagLength: 128 }, await codeKey(), encrypted);
        } catch (error) {
            if (String(error.message).startsWith("Panel is not configured")) throw error;
            throw new Error("Could not read that code. It may be damaged, or the key in config.js does not match the bot.");
        }
        const envelope = JSON.parse(new TextDecoder().decode(plaintext));
        if (!envelope || envelope.v !== 2 || envelope.kind !== "open" || typeof envelope.nonce !== "string" ||
            !envelope.settings || typeof envelope.settings !== "object") {
            throw new Error("That is not an 'open' code from /panelcode.");
        }
        return envelope;
    }

    async function encryptEnvelope(envelope) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encrypted = new Uint8Array(await crypto.subtle.encrypt(
            { name: "AES-GCM", iv, tagLength: 128 },
            await codeKey(),
            encoder.encode(JSON.stringify(envelope))
        ));
        const tagStart = encrypted.length - 16;
        return ["AIKO2", b64urlEncode(iv), b64urlEncode(encrypted.slice(tagStart)), b64urlEncode(encrypted.slice(0, tagStart))].join(".");
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

    async function openCode(code) {
        say(loadStatus, "Reading code...");
        try {
            const envelope = await decryptCode(code);
            nonce = envelope.nonce;
            expiresAt = Number(envelope.exp) || 0;
            renderSettings(envelope.settings);
            $("#editor").hidden = false;
            $("#newCodeBox").hidden = true;
            const minutes = Math.max(0, Math.round((expiresAt - Date.now()) / 60000));
            say(loadStatus, `Opened for ${envelope.issuedTo || "you"}. This code works for about ${minutes} more minutes.`);
        } catch (error) {
            say(loadStatus, error.message || "Could not read that code.", true);
        }
    }

    $("#loadButton").addEventListener("click", async event => {
        const button = event.currentTarget;
        button.disabled = true;
        try { await openCode($("#incomingCode").value); } finally { button.disabled = false; }
    });

    $("#codeFile").addEventListener("change", async event => {
        const file = event.target.files[0];
        if (!file) return;
        if (file.size > 600000) { say(loadStatus, "That file is too large.", true); return; }
        $("#incomingCode").value = (await file.text()).trim();
        await openCode($("#incomingCode").value);
    });

    $("#getCodeButton").addEventListener("click", async event => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
            if (expiresAt && Date.now() > expiresAt) {
                throw new Error("This session has expired. Run /panelcode again and open the new code.");
            }
            const current = readControls();
            const patch = {};
            for (const [key, value] of Object.entries(current)) {
                if (JSON.stringify(value) !== JSON.stringify(savedSettings[key])) patch[key] = value;
            }
            const count = Object.keys(patch).length;
            if (!count) throw new Error("You have not changed anything yet.");
            $("#newCode").value = await encryptEnvelope({ v: 2, kind: "update", nonce, patch });
            $("#newCodeBox").hidden = false;
            $("#changeList").textContent = `Changed: ${Object.keys(patch).map(key => labels[key] || key).join(", ")}`;
            say(status, $("#newCode").value.length > 5500
                ? "Code created. It is long: download the file and use the `file` option of /updatepanel."
                : "Code created. Copy it and run /updatepanel in Discord.");
        } catch (error) {
            say(status, error.message, true);
        } finally {
            button.disabled = false;
        }
    });

    $("#copyButton").addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText($("#newCode").value);
            say(status, "Code copied. Now run /updatepanel in Discord and paste it.");
        } catch {
            $("#newCode").select();
            say(status, "Select the code and copy it manually.", true);
        }
    });

    $("#downloadButton").addEventListener("click", () => {
        const blob = new Blob([$("#newCode").value], { type: "text/plain;charset=utf-8" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = "aiko-panel-update.txt";
        link.click();
        URL.revokeObjectURL(link.href);
    });
})();
