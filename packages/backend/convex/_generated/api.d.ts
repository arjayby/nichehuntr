/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as auth from "../auth.js";
import type * as crons from "../crons.js";
import type * as enrich from "../enrich.js";
import type * as enrichCron from "../enrichCron.js";
import type * as feed from "../feed.js";
import type * as healthCheck from "../healthCheck.js";
import type * as http from "../http.js";
import type * as ingest from "../ingest.js";
import type * as migrations from "../migrations.js";
import type * as model_channelLifecycle from "../model/channelLifecycle.js";
import type * as model_clonability from "../model/clonability.js";
import type * as model_deriveListings from "../model/deriveListings.js";
import type * as model_embeddings from "../model/embeddings.js";
import type * as model_enrichment from "../model/enrichment.js";
import type * as model_listings from "../model/listings.js";
import type * as model_submissions from "../model/submissions.js";
import type * as model_subscription from "../model/subscription.js";
import type * as model_validators from "../model/validators.js";
import type * as model_youtube from "../model/youtube.js";
import type * as polar from "../polar.js";
import type * as seed from "../seed.js";
import type * as submissions from "../submissions.js";
import type * as watchlist from "../watchlist.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  auth: typeof auth;
  crons: typeof crons;
  enrich: typeof enrich;
  enrichCron: typeof enrichCron;
  feed: typeof feed;
  healthCheck: typeof healthCheck;
  http: typeof http;
  ingest: typeof ingest;
  migrations: typeof migrations;
  "model/channelLifecycle": typeof model_channelLifecycle;
  "model/clonability": typeof model_clonability;
  "model/deriveListings": typeof model_deriveListings;
  "model/embeddings": typeof model_embeddings;
  "model/enrichment": typeof model_enrichment;
  "model/listings": typeof model_listings;
  "model/submissions": typeof model_submissions;
  "model/subscription": typeof model_subscription;
  "model/validators": typeof model_validators;
  "model/youtube": typeof model_youtube;
  polar: typeof polar;
  seed: typeof seed;
  submissions: typeof submissions;
  watchlist: typeof watchlist;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("@convex-dev/better-auth/_generated/component.js").ComponentApi<"betterAuth">;
  polar: import("@convex-dev/polar/_generated/component.js").ComponentApi<"polar">;
};
