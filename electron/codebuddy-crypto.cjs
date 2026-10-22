const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  createSecretKey,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} = require("node:crypto");

// Chromium v10 secrets use the AES key in THIS profile's Local State, protected
// by Windows DPAPI. A different Electron app's safeStorage uses a different key.
// No plaintext key is persisted or sent through renderer IPC.
class CodebuddyCrypto {
  constructor(profile) {
    this.profile = profile;
    this.cached = null;
    this.wrapped = null;
  }
  key() {
    if (process.platform !== "win32")
      throw new Error("CodeBuddy 加密存储仅支持 Windows");
    const local = JSON.parse(
      fs.readFileSync(path.join(this.profile(), "Local State"), "utf8"),
    );
    const wrapped = local.os_crypt?.encrypted_key;
    if (typeof wrapped !== "string" || wrapped.length > 8192 || !wrapped)
      throw new Error("请先初始化 CodeBuddy CN 登录");
    if (this.cached && wrapped === this.wrapped) return this.cached;
    const script = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$raw=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
if($raw.Length -lt 6 -or [Text.Encoding]::ASCII.GetString($raw,0,5) -ne 'DPAPI'){exit 1}
$clear=[Security.Cryptography.ProtectedData]::Unprotect($raw[5..($raw.Length-1)],$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
try { [Console]::Out.Write([Convert]::ToBase64String($clear)) } finally { [Array]::Clear($clear,0,$clear.Length) }
`;
    let output;
    try {
      output = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
          input: wrapped,
          encoding: "utf8",
          windowsHide: true,
          timeout: 15000,
          maxBuffer: 8192,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    } catch {
      throw new Error("无法使用当前 Windows 用户解密 CodeBuddy 登录");
    }
    const bytes = Buffer.from(output.trim(), "base64");
    try {
      if (bytes.length !== 32)
        throw new Error("CodeBuddy 加密密钥格式不受支持");
      this.cached = createSecretKey(bytes);
      this.wrapped = wrapped;
      return this.cached;
    } finally {
      bytes.fill(0);
    }
  }
  isEncryptionAvailable() {
    try {
      this.key();
      return true;
    } catch {
      return false;
    }
  }
  encryptString(value) {
    const nonce = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key(), nonce);
    return Buffer.concat([
      Buffer.from("v10"),
      nonce,
      cipher.update(value, "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
  }
  decryptString(value) {
    const bytes = Buffer.from(value);
    if (bytes.length < 31 || bytes.subarray(0, 3).toString() !== "v10")
      throw new Error("CodeBuddy 加密格式不受支持");
    const cipher = createDecipheriv(
      "aes-256-gcm",
      this.key(),
      bytes.subarray(3, 15),
    );
    cipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([
      cipher.update(bytes.subarray(15, -16)),
      cipher.final(),
    ]).toString("utf8");
  }
}
module.exports = { CodebuddyCrypto };
