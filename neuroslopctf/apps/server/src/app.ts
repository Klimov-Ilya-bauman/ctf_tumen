import { Application, Orm, PgDriver } from "@backend/thingamajig";

export class User {
  id!: number;
  username!: string;
  passwordHash!: string;
  createdAt!: Date;
  isInstanceAdmin!: boolean;
}

export const app = new Application(User);

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
export const driver = PgDriver.connect({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  options: "-c statement_timeout=15000 -c lock_timeout=10000 -c idle_in_transaction_session_timeout=15000",
});

export const orm = new Orm(app, driver);

export const executionContext = app.getExecutionContextManager();

export const GUEST: User = Object.assign(new User(), {
  id: 0,
  username: "",
  passwordHash: "",
  createdAt: new Date(0),
  isInstanceAdmin: false,
});

export function sudo<TResult>(callback: () => TResult): TResult {
  return executionContext.sudo(callback);
}
