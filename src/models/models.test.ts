import { describe, expect, test } from "bun:test";
import { DataCache } from "../store/DataCache";
import { ModelFactory } from "../store/AppDataModelFactory";
import { isCalendarDate, localCalendarDate } from "./calendarDate";
import { CurrentUserModel } from "./CurrentUserModel";
import { ProjectModel } from "./ProjectModel";
import { TagModel } from "./TagModel";
import { TaskModel } from "./TaskModel";
import { UserModel } from "./UserModel";

describe("UserModel", () => {
  test("initials: first letters of up to two words", () => {
    expect(new UserModel({ id: 1, name: "Ada Lovelace" }).initials()).toBe("AL");
    expect(new UserModel({ id: 1, name: "  grace   brewster hopper " }).initials()).toBe("GB");
    expect(new UserModel({ id: 1, name: "plato" }).initials()).toBe("P");
    expect(new UserModel({ id: 1, name: "" }).initials()).toBe("");
    expect(new UserModel({ id: 1 }).initials()).toBe(""); // a partial record renders, it does not throw
  });
});

describe("CurrentUserModel", () => {
  test("getSetting returns the stored value, or the fallback for a key never set", () => {
    const me = new CurrentUserModel({ id: 1, name: "Ada", email: "ada@example.com", settings: { theme: "dark", compact: false } });
    expect(me.getSetting("theme", "light")).toBe("dark");
    expect(me.getSetting("compact", true)).toBe(false); // a stored falsy value is not "unset"
    expect(me.getSetting("density", "normal")).toBe("normal");
    expect(me.getSetting("toString", "x")).toBe("x"); // own settings only
  });

  test("getUser resolves the public record with the same id in the same store", () => {
    const store = new DataCache();
    const factory = new ModelFactory(store);
    const [me] = factory.addData("current_users", { id: 1, name: "Ada", email: "ada@example.com", settings: {} });
    expect(me!.getUser()).toBeUndefined();
    factory.addData("users", [{ id: 1, name: "Ada" }]);
    expect(me!.getUser()).toBe(store.users.getById(1)!);
  });
});

describe("ProjectModel", () => {
  test("isOwner and isMember compare ids canonically (1 and \"1\" are the same user)", () => {
    const project = new ProjectModel({ id: 1, name: "P", owner_id: 1, member_ids: [1, "2"], created_at: "2026-09-01T09:00:00Z" });
    expect(project.isOwner(1)).toBe(true);
    expect(project.isOwner("1")).toBe(true);
    expect(project.isOwner(2)).toBe(false);
    expect(project.isMember(2)).toBe(true);
    expect(project.isMember("1")).toBe(true);
    expect(project.isMember(3)).toBe(false);
    expect(new ProjectModel({ id: 2, owner_id: null }).isOwner(1)).toBe(false);
    expect(new ProjectModel({ id: 2 }).isMember(1)).toBe(false);
  });
});

describe("TaskModel", () => {
  const task = (fields: Record<string, unknown>) => new TaskModel({ id: 1, project_id: 1, title: "t", status: "todo", due_on: null, hash: "h", ...fields });
  const oct1 = new Date(2026, 9, 1, 23, 59); // a local date: `due_on` is a calendar day, not an instant

  test("isOverdue: open and due before today; due today is not overdue", () => {
    expect(task({ due_on: "2026-09-30" }).isOverdue(oct1)).toBe(true);
    expect(task({ due_on: "2026-10-01" }).isOverdue(oct1)).toBe(false);
    expect(task({ due_on: "2026-10-02" }).isOverdue(oct1)).toBe(false);
    expect(task({ due_on: null }).isOverdue(oct1)).toBe(false);
  });

  test("a due_on that is not a calendar date is no due date, never overdue (it would sort before every real date)", () => {
    for (const due_on of ["", "soon", "2026-9-1", "2026-02-30", 20260901, undefined]) expect(task({ due_on }).isOverdue(oct1)).toBe(false);
  });

  test("a done task is never overdue", () => {
    expect(task({ status: "done", due_on: "2026-01-01" }).isDone()).toBe(true);
    expect(task({ status: "done", due_on: "2026-01-01" }).isOverdue(oct1)).toBe(false);
    expect(task({ status: "doing", due_on: "2026-01-01" }).isOverdue(oct1)).toBe(true);
  });
});

describe("TagModel", () => {
  test("matches is a case-insensitive substring test; an empty query matches", () => {
    const tag = new TagModel({ id: 1, name: "Urgent" });
    expect(tag.matches("urg")).toBe(true);
    expect(tag.matches(" GENT ")).toBe(true);
    expect(tag.matches("")).toBe(true);
    expect(tag.matches("ui")).toBe(false);
    expect(new TagModel({ id: 2 }).matches("")).toBe(true); // a nameless tag does not throw
    expect(new TagModel({ id: 2 }).matches("a")).toBe(false);
  });
});

describe("calendarDate", () => {
  test("isCalendarDate accepts real YYYY-MM-DD days only", () => {
    for (const good of ["2026-09-29", "2024-02-29", "2000-02-29", "0001-01-01", "2026-12-31"]) expect(isCalendarDate(good)).toBe(true);
    for (const bad of ["", " 2026-09-29", "2026-9-29", "2026-02-30", "2025-02-29", "2026-13-01", "2026-00-10", "2026-09-00", "1900-02-29", "2026-09-29T00:00:00Z", null, 20260929]) {
      expect(isCalendarDate(bad)).toBe(false);
    }
  });

  test("localCalendarDate is the local day, zero-padded", () => {
    expect(localCalendarDate(new Date(2026, 0, 5, 0, 0))).toBe("2026-01-05");
    expect(localCalendarDate(new Date(2026, 11, 31, 23, 59))).toBe("2026-12-31");
  });
});
