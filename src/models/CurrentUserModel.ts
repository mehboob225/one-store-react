/**
 * The logged-in user: the public fields plus `email` and `settings`, only
 * ever sent to that user. One record whose id is the user's id, so the
 * public side is `getUser()`.
 */
import { storeOf } from "./generator/PassiveModel";
import { CurrentUserModelAppData } from "./appdata/CurrentUserModelAppData";
import type { UserModel } from "./UserModel";

export class CurrentUserModel extends CurrentUserModelAppData {
  declare name: string;
  declare email: string;
  declare settings: Readonly<Record<string, unknown>>;

  /** The same person in the `users` bucket (what owners, assignees and authors resolve to). */
  getUser(): UserModel | undefined {
    return storeOf(this).users.getById(this.id);
  }

  /** One user setting, or `fallback` when it has never been set. */
  getSetting<T>(key: string, fallback: T): T {
    return Object.hasOwn(this.settings ?? {}, key) ? (this.settings[key] as T) : fallback;
  }
}
