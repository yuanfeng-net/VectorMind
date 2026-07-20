import crypto from "node:crypto";
import fs from "node:fs";

export const RTK_RELEASE_TAG = "v0.43.0";
export const RTK_COMMIT_SHA = "5a7880d404db8364d602f2ecdc41dd790f64013f";

export const RTK_ASSET_SHA256: Readonly<Record<string, string>> = Object.freeze({
  "rtk-aarch64-apple-darwin.tar.gz": "8a17e49acbd378997eb21d0eb6f7f861111f35b4fc9b1c74edf4c7448e576c65",
  "rtk-aarch64-unknown-linux-gnu.tar.gz": "5519f7ca12e5c143a609f0d28a0a77b97413a8dce31c2681f1a41c24519a8731",
  "rtk-x86_64-apple-darwin.tar.gz": "a85f60e2637811be68366208b8d8b9c5ba1b748cb5df4477ab20cd73d3c5d9f8",
  "rtk-x86_64-pc-windows-msvc.zip": "7c5e4a2ef816a4d4ed947ddd74ca3df851fc39ea87d49a3ca2bf3abc515a016b",
  "rtk-x86_64-unknown-linux-musl.tar.gz": "ff8a1e7766496e175291a85aeca1dc97c9ff6df33e51e5893d1fbc78fea2a609",
});

export function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(filePath, "r");
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

export function verifyFileSha256(filePath: string, expectedSha256: string): void {
  const actualSha256 = sha256File(filePath);
  if (actualSha256 !== expectedSha256.toLowerCase()) {
    throw new Error(`SHA-256 mismatch for ${filePath}: expected ${expectedSha256}, received ${actualSha256}`);
  }
}
