/**
 * A task. `hash` is the optimistic-locking token a PUT must send back
 * (docs/API.md); `due_on` is a calendar date (`YYYY-MM-DD`), not an instant.
 */
import { isCalendarDate, localCalendarDate } from "./calendarDate";
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

  /**
   * Open and due before `today` (a local calendar date); a task due today is
   * not overdue yet. A `due_on` that is not a calendar date (`""`, junk) is
   * "no due date": compared as a string it would sort before every real date.
   */
  isOverdue(today: Date = new Date()): boolean {
    return !this.isDone() && isCalendarDate(this.due_on) && this.due_on < localCalendarDate(today);
  }
}
