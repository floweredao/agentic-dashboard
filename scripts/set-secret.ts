#!/usr/bin/env bun
import { runCli } from "./hosted/main";

await runCli("secret", process.argv.slice(2));
