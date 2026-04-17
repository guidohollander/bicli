import { main } from "./program.js";

main(process.argv).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
