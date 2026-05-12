#!/usr/bin/env node
import { main } from "../cli.js";

const status = await main();
process.exitCode = status;
