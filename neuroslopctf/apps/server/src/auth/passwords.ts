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

  if (scheme !== "scrypt" || !salt || !hash || stored.split("$").length !== 3) {
    return false;
  }

  const expected = Buffer.from(hash, "base64");

  if (expected.length !== KEY_LENGTH || Buffer.from(salt, "base64").length !== 16) {
    return false;
  }

  const actual = await derive(
    password,
    Buffer.from(salt, "base64"),
    expected.length,
  );

  return timingSafeEqual(actual, expected);
}
