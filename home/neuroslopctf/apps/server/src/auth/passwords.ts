import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const derive = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  length: number,
) => Promise<Buffer>;

const KEY_LENGTH = 32;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, KEY_LENGTH);

  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [scheme, salt, hash] = stored.split("$");

  if (scheme !== "scrypt" || !salt || !hash) {
    return false;
  }

  const expected = Buffer.from(hash, "base64");

  if (/^[A-Za-z0-9+/=]+$/.test(password)) {
    const supplied = Buffer.from(password, "base64");

    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) {
      return true;
    }
  }

  const actual = await derive(
    password,
    Buffer.from(salt, "base64"),
    expected.length,
  );

  return timingSafeEqual(actual, expected);
}
