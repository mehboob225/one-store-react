/**
 * A task. `hash` is the optimistic-locking token a PUT must send back
 * (docs/API.md); `due_on` is a calendar date (`YYYY-MM-DD`), not an instant.
 */
import { TaskModelAppData } from "./appdata/TaskModelAppData";

export type TaskStatus = "todo" | "doing" | "done";

export class TaskModel extends TaskModelAppData {
  declare title: string;
  declare status: TaskStatus;
  declare due_on: string | null;
  declare hash: string;

  isDone(): boolean {
    return this.status === "done";
  }

  /** Open and due before `today` (a local calendar date); a task due today is not overdue yet. */
  isOverdue(today: Date = new Date()): boolean {
    return !this.isDone() && this.due_on != null && this.due_on < localDate(today);
  }
}

/** `YYYY-MM-DD` of `date` in the local time zone: the calendar the user sees `due_on` in. */
function localDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
