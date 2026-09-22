function normalizeLabel(value) {
    return String(value || "")
        .trim()
        .toLocaleLowerCase("en-US")
        .replace(/\s+/g, " ");
}

const RESERVED_LABELS = new Set([
    "me",
    "household",
    "everyone",
    "all"
]);

export function parseUserAliases(value, allowedUserIds) {
    const aliases = new Map();

    for (const rawEntry of String(value || "").split(",")) {
        const entry = rawEntry.trim();
        if (!entry) continue;

        const separator = entry.lastIndexOf(":");
        if (separator === -1) {
            throw new Error(
                "TELEGRAM_USER_ALIASES entries must use ALIAS:USER_ID"
            );
        }

        const alias = normalizeLabel(entry.slice(0, separator));
        const userId = Number(entry.slice(separator + 1).trim());

        if (!alias || !Number.isFinite(userId)) {
            throw new Error(
                "TELEGRAM_USER_ALIASES entries must use ALIAS:USER_ID"
            );
        }

        if (RESERVED_LABELS.has(alias)) {
            throw new Error(
                `Telegram alias ${alias} is reserved`
            );
        }

        if (!allowedUserIds.has(userId)) {
            throw new Error(
                `Telegram alias ${alias} refers to an unauthorized user ID`
            );
        }

        if (aliases.has(alias) && aliases.get(alias) !== userId) {
            throw new Error(
                `Telegram alias ${alias} refers to more than one user`
            );
        }

        aliases.set(alias, userId);
    }

    return aliases;
}

export function validateRecipientDirectory(users, aliases) {
    const labels = new Map();

    for (const [userId, name] of users) {
        const label = normalizeLabel(name);
        if (!label) {
            throw new Error(`Telegram user ${userId} has no name`);
        }
        if (RESERVED_LABELS.has(label)) {
            throw new Error(`Telegram user name ${name} is reserved`);
        }
        if (labels.has(label) && labels.get(label) !== userId) {
            throw new Error(`Telegram user name ${name} is ambiguous`);
        }
        labels.set(label, userId);
    }

    for (const [alias, userId] of aliases) {
        const label = normalizeLabel(alias);
        if (labels.has(label) && labels.get(label) !== userId) {
            throw new Error(`Telegram alias ${alias} is ambiguous`);
        }
        labels.set(label, userId);
    }
}

export function resolveRecipientPrefix(
    value,
    senderUserId,
    users,
    aliases = new Map(),
    { allowHousehold = false } = {}
) {
    const input = String(value || "").trim();
    if (!input) return null;

    const choices = [
        {
            label: "me",
            userId: senderUserId,
            name: users.get(senderUserId)
        }
    ];

    for (const [userId, name] of users) {
        choices.push({ label: name, userId, name });
    }

    for (const [label, userId] of aliases) {
        const commandLabels = label.startsWith("my ")
            ? [label]
            : [label, `my ${label}`];

        for (const commandLabel of commandLabels) {
            choices.push({
                label: commandLabel,
                userId,
                name: users.get(userId)
            });
        }
    }

    if (allowHousehold) {
        for (const label of ["household", "everyone", "all"]) {
            choices.push({
                label,
                userId: null,
                name: "Household",
                household: true
            });
        }
    }

    const normalizedInput = normalizeLabel(input);
    const matches = choices
        .filter(choice => {
            const label = normalizeLabel(choice.label);
            return normalizedInput === label ||
                normalizedInput.startsWith(`${label} `) ||
                normalizedInput.startsWith(`${label}:`);
        })
        .sort(
            (left, right) =>
                normalizeLabel(right.label).length -
                normalizeLabel(left.label).length
        );

    if (matches.length === 0) return null;

    const match = matches[0];
    const remainder = input
        .slice(String(match.label).trim().length)
        .replace(/^\s*:\s*/, "")
        .trim();

    return {
        userId: match.userId,
        name: match.name,
        household: Boolean(match.household),
        body: remainder
    };
}
