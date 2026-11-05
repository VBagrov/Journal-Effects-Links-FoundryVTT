import { SetManager } from "./set-manager.js";
import { GrantManager } from "./grant-manager.js";
import { RevocationManager } from "./revocation.js";

export const setManager = new SetManager();
export const grantManager = new GrantManager(setManager);
export const revocationManager = new RevocationManager(setManager);
