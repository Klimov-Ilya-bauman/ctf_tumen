import { AsyncLocalStorage } from "node:async_hooks";
import type { ObjectLike } from "./clockwork.js";
import type { SqlDriver } from "./engine.js";

type ExecutionContext<TUserResource extends ObjectLike> = {
  user: TUserResource;
  hasRootAccess: boolean;
  driver?: SqlDriver;
};

export class ExecutionContextManager<TUserResource extends ObjectLike> {
  storage = new AsyncLocalStorage<ExecutionContext<TUserResource>>();

  runAs<TResult>(user: TUserResource, callback: () => TResult): TResult {
    return this.storage.run(
      {
        user,
        hasRootAccess: false,
      },
      callback,
    );
  }

  sudo<TResult>(callback: () => TResult): TResult {
    const context = this.storage.getStore();

    if (!context) {
      throw new Error("No user context available");
    }

    return this.storage.run(
      {
        ...context,
        hasRootAccess: true,
      },
      callback,
    );
  }

  whoami(): TUserResource {
    const context = this.storage.getStore();

    if (!context) {
      throw new Error("No user context available");
    }

    return context.user;
  }

  hasContext(): boolean {
    return this.storage.getStore() !== undefined;
  }

  currentDriver(): SqlDriver | undefined {
    return this.storage.getStore()?.driver;
  }

  runWithDriver<TResult>(
    driver: SqlDriver,
    callback: () => TResult,
  ): TResult {
    const context = this.storage.getStore();

    if (!context) {
      throw new Error("No user context available");
    }

    return this.storage.run({ ...context, driver }, callback);
  }
}
