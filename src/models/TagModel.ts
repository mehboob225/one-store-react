/** A tag; linked to tasks many-to-many through `task_tags_relation`. */
import { TagModelAppData } from "./appdata/TagModelAppData";

export class TagModel extends TagModelAppData {
  declare name: string;

  /** Case-insensitive substring match, for a tag picker's filter box. An empty query matches every tag. */
  matches(query: string): boolean {
    return this.name.toLowerCase().includes(query.trim().toLowerCase());
  }
}
