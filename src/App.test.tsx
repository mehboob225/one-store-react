import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { App } from "./App";

describe("App", () => {
  test("renders the placeholder heading", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "one-store-react" })).toBeTruthy();
  });
});
