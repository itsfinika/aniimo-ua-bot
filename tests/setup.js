// Silence the application logger during tests: the modules under test log
// liberally (that is the point in production), and a passing run should show the
// test results, not a hundred INFO lines. Failures still surface through the
// assertions themselves.

import { setLogLevel } from "../services/logger.js";

setLogLevel("CRITICAL");
