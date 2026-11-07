
(() => {
    const groups = {
        "Progression": [
            "xpEnabled", "xpPerMessage", "xpCooldownMs",
            "levelUpCoins", "levelUpChannelId", "levelUpMessage", "levelUp"
        ],
        "Moderation and links": [
            "moderationEnabled", "spamEnabled", "spamLimit",
            "spamWindowMs", "spamTimeoutMs", "linkFilterEnabled",
            "allowServerOwner", "allowAdministrators", "ignoredLinkRoles",
            "allowedLinks", "allowedDomains", "blockedDomains", "linkRules"
        ],
        "AI": ["aiEnabled", "aiProvider", "openRouterModel", "aiPrompt"],
        "AI memory": [
            "memoryFreshLimit", "memoryFreshHours", "memoryRetrievalLimit",
            "memoryWeeklyDays", "memoryMonthlyDays",
            "memoryDeleteThreshold", "universalMemoryFacts"
        ],
        "Automatic conversation": [
            "autoConversationEnabled", "autoConversationChannels",
            "inactiveMinutes", "autoConversationCooldownMinutes",
            "maxAutoMessagesPerDay", "excludedChannels"
        ],
        "Daily quiz": [
            "quizChannelId", "quizTimezone", "quizDurationHours",
            "quizWinnerCoins", "quizParticipantCoins"
        ]
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
        allowAdministrators: "Allow admins to bypass link filter",
        ignoredLinkRoles: "Ignored roles (one ID per line)",
        allowedLinks: "Allowed links (one per line)",
        allowedDomains: "Allowed domains (one per line)",
        blockedDomains: "Blocked domains (one per line)",
        linkRules: "Per-channel link rules",
        aiEnabled: "Enable AI chat",
        aiProvider: "AI provider",
        openRouterModel: "OpenRouter model",
        aiPrompt: "Extra AI instructions",
        memoryFreshLimit: "Recent messages to retain",
        memoryFreshHours: "Recent chat retention (hours)",
        memoryRetrievalLimit: "Memories per prompt",
        memoryWeeklyDays: "Compress memories after (days)",
        memoryMonthlyDays: "Archive memories after (days)",
        memoryDeleteThreshold: "Memory deletion threshold (0–1)",
        universalMemoryFacts: "Universal facts (one per line)",
        autoConversationEnabled: "Allow AI to start conversations",
        autoConversationChannels: "Allowed channels (one ID per line)",
        inactiveMinutes: "Start after inactivity (minutes)",
        autoConversationCooldownMinutes: "Channel cooldown (minutes)",
        maxAutoMessagesPerDay: "Daily message limit",
        excludedChannels: "Excluded channels (one ID per line)",
        quizChannelId: "Daily quiz channel ID",
        quizTimezone: "Quiz timezone",
        quizDurationHours: "Quiz duration (hours)",
        quizWinnerCoins: "Winner Blade Coins",
        quizParticipantCoins: "Participant Blade Coins",
        levelUp: "Level-up settings"
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

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function b64urlEncode(bytes) {
        let binary = "";
        bytes.forEach(byte => {
            binary += String.fromCharCode(byte);
        });

        return btoa(binary)
            .replaceAll("+", "-")
            .replaceAll("/", "_")
            .replace(/=+$/, "");
    }

    function b64urlDecode(value) {
        if (!/^[A-Za-z0-9_-]+$/.test(value)) {
            throw new Error("That is not a valid panel code.");
        }

        const base64 = value.replaceAll("-", "+").replaceAll("_", "/");

        return Uint8Array.from(
            atob(base64 + "=".repeat((4 - base64.length % 4) % 4)),
            character => character.charCodeAt(0)
        );
    }

    async function codeKey() {
        if (KEY_TEXT.length < 16 || KEY_TEXT.includes("PASTE")) {
            throw new Error(
                "Panel is not configured: set AIKO_CODE_KEY in config.js."
            );
        }

        if (!crypto.subtle) {
            throw new Error(
                "This browser cannot do encryption. Use a current browser over HTTPS."
            );
        }

        const hash = await crypto.subtle.digest(
            "SHA-256",
            encoder.encode(`aiko-panel-v2:${KEY_TEXT}`)
        );

        return crypto.subtle.importKey(
            "raw",
            hash,
            "AES-GCM",
            false,
            ["encrypt", "decrypt"]
        );
    }

    async function decryptCode(code) {
        const parts = code.trim().split(".");

        if (parts.length !== 4 || parts[0] !== "AIKO2") {
            throw new Error(
                "Invalid panel code. Paste the complete code from /panelcode."
            );
        }

        const iv = b64urlDecode(parts[1]);
        const tag = b64urlDecode(parts[2]);
        const ciphertext = b64urlDecode(parts[3]);

        if (iv.length !== 12 || tag.length !== 16) {
            throw new Error("That panel code is damaged.");
        }

        const encrypted = new Uint8Array(ciphertext.length + tag.length);
        encrypted.set(ciphertext);
        encrypted.set(tag, ciphertext.length);

        let plaintext;

        try {
            plaintext = await crypto.subtle.decrypt(
                { name: "AES-GCM", iv, tagLength: 128 },
                await codeKey(),
                encrypted
            );
        } catch {
            throw new Error(
                "Could not read the code. Check the code and encryption key."
            );
        }

        const envelope = JSON.parse(
            new TextDecoder().decode(plaintext)
        );

        if (
            !envelope ||
            envelope.v !== 2 ||
            envelope.kind !== "open" ||
            typeof envelope.nonce !== "string" ||
            !envelope.settings ||
            typeof envelope.settings !== "object"
        ) {
            throw new Error("That is not an open code from /panelcode.");
        }

        return envelope;
    }

    async function encryptEnvelope(envelope) {
        const iv = crypto.getRandomValues(new Uint8Array(12));

        const encrypted = new Uint8Array(
            await crypto.subtle.encrypt(
                { name: "AES-GCM", iv, tagLength: 128 },
                await codeKey(),
                encoder.encode(JSON.stringify(envelope))
            )
        );

        const tagStart = encrypted.length - 16;

        return [
            "AIKO2",
            b64urlEncode(iv),
            b64urlEncode(encrypted.slice(tagStart)),
            b64urlEncode(encrypted.slice(0, tagStart))
        ].join(".");
    }

    // Create friendly controls instead of asking users to write JSON.
    function makeField(labelText, value, onChange, path = "") {
        const wrap = document.createElement("div");
        wrap.className = "friendly-field";

        const label = document.createElement("label");
        label.textContent = labelText;
        wrap.append(label);

        if (typeof value === "boolean") {
            const line = document.createElement("label");
            line.className = "check friendly-check";

            const input = document.createElement("input");
            input.type = "checkbox";
            input.checked = value;

            const stateText = document.createElement("span");
            stateText.textContent = value ? "Enabled" : "Disabled";

            input.addEventListener("change", () => {
                stateText.textContent = input.checked ? "Enabled" : "Disabled";
                onChange(input.checked);
            });

            line.append(input, stateText);
            wrap.append(line);

        } else if (typeof value === "number") {
            const input = document.createElement("input");
            input.type = "number";
            input.step = Number.isInteger(value) ? "1" : "0.01";
            input.value = String(value);

            input.addEventListener("change", () => {
                if (input.value.trim() === "") {
                    input.value = String(value);
                    return;
                }

                const number = Number(input.value);

                if (!Number.isFinite(number)) {
                    input.value = String(value);
                    return;
                }

                onChange(number);
            });

            wrap.append(input);

        } else if (Array.isArray(value)) {
            const input = document.createElement("textarea");

            input.rows = Math.min(7, Math.max(3, value.length + 1));
            input.placeholder = "Enter one item per line";
            input.value = value.map(item => String(item ?? "")).join("\n");

            input.addEventListener("change", () => {
                const lines = input.value
                    .split(/\r?\n/)
                    .map(line => line.trim())
                    .filter(Boolean);

                const sample = value.find(item => item != null);

                const items = lines.map(line => {
                    if (typeof sample === "number") {
                        const number = Number(line);
                        if (!Number.isFinite(number)) {
                            throw new Error("Enter valid numbers in this list.");
                        }
                        return number;
                    }

                    if (typeof sample === "boolean") {
                        return line.toLowerCase() === "true";
                    }

                    return line;
                });

                onChange(items);
            });

            wrap.append(input);

            const hint = document.createElement("small");
            hint.className = "hint";
            hint.textContent =
                "One item per line. No brackets, commas or quotes needed.";

            wrap.append(hint);

        } else if (value !== null && typeof value === "object") {
            const details = document.createElement("details");
            details.className = "friendly-object";

            const summary = document.createElement("summary");
            summary.textContent = "Edit settings";
            details.append(summary);

            const body = document.createElement("div");
            body.className = "friendly-object-body";

            const state = clone(value);

            function renderObject(object, container, prefix) {
                for (const [childKey, childValue] of Object.entries(object)) {
                    const child = makeField(
                        childKey,
                        childValue,
                        nextValue => {
                            object[childKey] = nextValue;
                            onChange(clone(state));
                        },
                        `${prefix}.${childKey}`
                    );

                    container.append(child);
                }
            }

            renderObject(state, body, path);
            details.append(body);
            wrap.append(details);

        } else {
            const input = document.createElement("textarea");
            input.value = String(value ?? "");
            input.rows = ["aiPrompt", "levelUpMessage"].includes(path) ? 4 : 2;

            input.addEventListener("change", () => {
                onChange(input.value);
            });

            wrap.append(input);
        }

        return wrap;
    }

    function readControls() {
        const settings = {};

        for (const [key, getter] of settingInputs) {
            settings[key] = getter();
        }

        return settings;
    }

    function renderSettings(settings) {
        savedSettings = clone(settings);
        settingInputs = new Map();
        settingsContainer.replaceChildren();

        for (const [group, keys] of Object.entries(groups)) {
            const section = document.createElement("section");
            section.className = "panel settings-panel";

            const heading = document.createElement("h2");
            heading.textContent = group;
            section.append(heading);

            for (const key of keys) {
                if (!Object.prototype.hasOwnProperty.call(settings, key)) {
                    continue;
                }

                let currentValue = clone(settings[key]);

                const field = makeField(
                    labels[key] || key,
                    currentValue,
                    nextValue => {
                        currentValue = nextValue;
                    },
                    key
                );

                field.classList.add("setting-friendly-row");
                section.append(field);

                settingInputs.set(key, () => currentValue);
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

            const minutes = Math.max(
                0,
                Math.round((expiresAt - Date.now()) / 60000)
            );

            say(
                loadStatus,
                `Opened for ${envelope.issuedTo || "you"}. ` +
                `This code works for about ${minutes} more minutes.`
            );

        } catch (error) {
            say(loadStatus, error.message || "Could not read that code.", true);
        }
    }

    $("#loadButton").addEventListener("click", async event => {
        const button = event.currentTarget;
        button.disabled = true;

        try {
            await openCode($("#incomingCode").value);
        } finally {
            button.disabled = false;
        }
    });

    $("#codeFile").addEventListener("change", async event => {
        const file = event.target.files[0];
        if (!file) return;

        if (file.size > 600000) {
            say(loadStatus, "That file is too large.", true);
            return;
        }

        $("#incomingCode").value = (await file.text()).trim();
        await openCode($("#incomingCode").value);
    });

    $("#getCodeButton").addEventListener("click", async event => {
        const button = event.currentTarget;
        button.disabled = true;

        try {
            if (expiresAt && Date.now() > expiresAt) {
                throw new Error(
                    "Session expired. Run /panelcode again and open the new code."
                );
            }

            const current = readControls();
            const patch = {};

            for (const [key, value] of Object.entries(current)) {
                if (
                    JSON.stringify(value) !==
                    JSON.stringify(savedSettings[key])
                ) {
                    patch[key] = value;
                }
            }

            if (!Object.keys(patch).length) {
                throw new Error("You have not changed anything yet.");
            }

            $("#newCode").value = await encryptEnvelope({
                v: 2,
                kind: "update",
                nonce,
                patch
            });

            $("#newCodeBox").hidden = false;

            $("#changeList").textContent =
                "Changed: " +
                Object.keys(patch)
                    .map(key => labels[key] || key)
                    .join(", ");

            say(
                status,
                $("#newCode").value.length > 5500
                    ? "Code created. Download it and use the file option of /updatepanel."
                    : "Code created. Copy it and run /updatepanel in Discord."
            );

        } catch (error) {
            say(status, error.message, true);

        } finally {
            button.disabled = false;
        }
    });

    $("#copyButton").addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText($("#newCode").value);
            say(status, "Code copied. Now run /updatepanel in Discord.");

        } catch {
            $("#newCode").select();
            say(status, "Select the code and copy it manually.", true);
        }
    });

    $("#downloadButton").addEventListener("click", () => {
        const blob = new Blob(
            [$("#newCode").value],
            { type: "text/plain;charset=utf-8" }
        );

        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = "aiko-panel-update.txt";
        link.click();

        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    });
})();
