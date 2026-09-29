/**
 * A workspace user as everyone sees them: `{id, name}` (docs/API.md). The
 * logged-in user's private fields live on CurrentUserModel.
 */
import { UserModelAppData } from "./appdata/UserModelAppData";

export class UserModel extends UserModelAppData {
  declare name: string;

  /** Up to two initials for an avatar: "Ada Lovelace" → "AL", "plato" → "P". */
  initials(): string {
    return this.name
      .split(/\s+/)
      .filter((part) => part.length > 0)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join("");
  }
}
