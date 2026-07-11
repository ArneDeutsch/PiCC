/**
 * Named entry point for the PiCC Pi extension.
 *
 * This thin wrapper exists only so Pi's startup banner labels the extension
 * `picc` (Pi derives the label from the entry's parent directory, popping a
 * trailing `index.ts`). The implementation lives in `../src/index.ts`.
 */
export { default } from "../src/index.js";
