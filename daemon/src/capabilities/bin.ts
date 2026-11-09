#!/usr/bin/env node
import { runCapabilityCli } from './cli.js';

process.exitCode = await runCapabilityCli(process.argv.slice(2));
