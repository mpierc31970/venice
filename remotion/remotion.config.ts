import { Config } from "@remotion/cli/config";
import { projectDir } from "./project-dir.mjs";

// Studio serves the project directory, so `remotion studio` shows every section that has
// finished rendering, with no import step. Studio *is* the timeline — there is no other.
Config.setPublicDir(projectDir());
Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
