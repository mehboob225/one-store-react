/**
 * A project. The owner is always one of `member_ids` (server invariant), and
 * only members may write to a project or be assigned its tasks, so
 * `isMember` is the one permission rule the UI needs.
 */
import { canonicalKey } from "../store/canonicalKey";
import type { IndexValue } from "../store/EventHandler";
import { ProjectModelAppData } from "./appdata/ProjectModelAppData";

export class ProjectModel extends ProjectModelAppData {
  declare name: string;
  /** ISO timestamp. */
  declare created_at: string;

  isOwner(userId: IndexValue): boolean {
    return this.owner_id != null && canonicalKey(this.owner_id) === canonicalKey(userId);
  }

  isMember(userId: IndexValue): boolean {
    const wanted = canonicalKey(userId);
    return (this.member_ids ?? []).some((id) => canonicalKey(id) === wanted);
  }
}
