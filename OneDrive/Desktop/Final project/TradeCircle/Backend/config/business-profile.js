const crypto = require("crypto");

const profileKey = crypto.scryptSync(
    process.env.SESSION_SECRET,
    "TradeCircle/business-profile/v1",
    32
);

function encryptBusinessProfile(profile) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", profileKey, iv);
    const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(profile), "utf8"),
        cipher.final()
    ]);

    return {
        version: 1,
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64")
    };
}

function decryptBusinessProfile(envelope) {
    if (!envelope || !envelope.ciphertext) return {};
    if (envelope.version !== 1) {
        throw new Error("Unsupported business profile encryption version.");
    }

    const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        profileKey,
        Buffer.from(envelope.iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final()
    ]);

    return JSON.parse(plaintext.toString("utf8"));
}

module.exports = { encryptBusinessProfile, decryptBusinessProfile };
