/**
 * The store singleton the whole app imports. One mutable normalized cache:
 * factories, loaders and push write into it; atoms read it and subscribe to
 * its buses. Nothing else holds server data.
 */
import { DataCache } from "./DataCache";

export const AppDataFactory = new DataCache();
