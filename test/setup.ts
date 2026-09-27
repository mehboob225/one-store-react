// Registers happy-dom globals (window, document, ...) before every test file.
// Loaded via `[test] preload` in bunfig.toml.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
