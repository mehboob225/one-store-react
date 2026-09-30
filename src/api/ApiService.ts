/**
 * The app's API client: every request goes to the backend DomainConfiguration
 * resolved, carries the signed-in user's credentials, and writes its
 * response into AppDataFactory through AppDataModelFactory.
 */
import { DomainConfiguration } from "../config/DomainConfiguration";
import { APIClient } from "./ApiClient";

export const APIService = new APIClient(DomainConfiguration.api);
