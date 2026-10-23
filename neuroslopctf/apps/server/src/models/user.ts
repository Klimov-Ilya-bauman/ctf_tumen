import { value } from "@backend/thingamajig";
import { app, User } from "../app.js";

export { User };

export const user = app.define("user", User, (d) =>
  d.permissions({
    read: () => value(true),
  }),
);
